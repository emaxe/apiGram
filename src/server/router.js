/**
 * Все эндпоинты `/v1`, кроме health и списка аккаунтов (те заданы в http.js).
 *
 * Каждый обработчик устроен одинаково: достать клиента через `getClient(req)`,
 * вызвать модуль из `telegram/`, отдать результат. Ошибки не разбираются на месте —
 * уходят в `next(err)` и превращаются в HTTP-код единым маппером `toHttpError`.
 * Права здесь уже проверены Bearer-мидлварой в http.js: `req.account` доверенный.
 */
import { Router } from "express";
import { makeAccount, removeAccount, toPublic, accountStore } from "./accounts.js";
import { isAdmin, bearerToken } from "./bearer.js";
import { sessionManager } from "../telegram/sessionManager.js";
import * as authApi from "../telegram/auth.js";
import * as msg from "../telegram/messages.js";
import * as dlg from "../telegram/dialogs.js";
import * as prof from "../telegram/profile.js";
import { createDownloadGate } from "../telegram/media.js";
import { parseRange, mediaResponseHead } from "./range.js";

// Пропускник загрузок общий на процесс: ограничение считается по аккаунту,
// а не по запросу, и пересоздавать его на каждый роутер значило бы снять его.
const downloadGate = createDownloadGate();

/** @returns {import("express").Router} */
export function buildRouter() {
    const r = Router();

    // Создание аккаунта. Токен отдаём в ответе один раз — больше он нигде не показывается.
    r.post("/accounts", (req, res) => {
        if (!isAdmin(req)) return res.status(401).json({ error: "admin_token_required" });
        const account = makeAccount(req.body?.name || "");
        res.status(201).json({ ...toPublic(account), apiToken: account.apiToken });
    });

    // Сначала detach (закрыть клиента и уведомить сокеты), потом удаление из реестра:
    // в обратном порядке живой клиент остался бы висеть без записи в реестре.
    r.delete("/accounts/:accountId", async (req, res, next) => {
        try {
            await sessionManager.detach(req.account.accountId);
            const ok = removeAccount(req.account.accountId, bearerToken(req));
            res.json({ ok });
        } catch (err) { next(err); }
    });

    // ── Авторизация ───────────────────────────────────────────────
    // Трёхшаговый вход: send-code → verify-code → (password, если включён 2FA).
    // Состояние между шагами живёт в реестре, поэтому рестарт процесса
    // не роняет начатый логин.

    r.post("/accounts/:accountId/auth/send-code", async (req, res, next) => {
        try {
            const { phone } = req.body || {};
            if (!phone) return res.status(400).json({ error: "phone_required", step: "send-code" });
            const result = await authApi.sendCode(req.account, phone);
            // phoneCodeHash намеренно не сохраняем в реестр: он привязан к живому
            // клиенту, который держит sessionManager, и на диске бесполезен.
            accountStore.saveAuthorized(req.account.accountId, {
                phone,
                status: "code_sent",
                auth: { phoneCodeHash: null },
            });
            res.json({ ok: true, isCodeViaApp: result.isCodeViaApp, next: "code" });
        } catch (err) { next(err); }
    });

    r.post("/accounts/:accountId/auth/verify-code", async (req, res, next) => {
        try {
            const { code } = req.body || {};
            if (!code) return res.status(400).json({ error: "code_required", step: "verify-code" });
            const result = await authApi.verifyCode(req.account, accountStore, code);
            // Верный код при включённом 2FA — ещё не вход: клиент остаётся поднятым
            // и ждёт пароль следующим запросом.
            if (result.next === "password") {
                accountStore.saveAuthorized(req.account.accountId, { status: "awaiting_2fa" });
                return res.json({ next: "password" });
            }
            res.json({ next: "done", me: result.me });
        } catch (err) { next(err); }
    });

    r.post("/accounts/:accountId/auth/password", async (req, res, next) => {
        try {
            const { password } = req.body || {};
            if (!password) return res.status(400).json({ error: "password_required", step: "password" });
            const result = await authApi.verifyPassword(req.account, accountStore, password);
            res.json({ next: "done", me: result.me });
        } catch (err) { next(err); }
    });

    // Логаут отзывает сессию в Telegram — она станет непригодна и на других устройствах.
    r.post("/accounts/:accountId/auth/logout", async (req, res, next) => {
        try {
            await authApi.logout(req.account, accountStore);
            res.json({ ok: true });
        } catch (err) { next(err); }
    });

    // Читает только реестр, без обращения к Telegram: дёшево и работает,
    // даже когда сессия отозвана.
    r.get("/accounts/:accountId/auth/status", (req, res) => {
        res.json(authApi.authStatus(req.account));
    });

    // ── Профиль ───────────────────────────────────────────────────
    r.get("/accounts/:accountId/me", async (req, res, next) => {
        try {
            res.json(await prof.getMe(await getClient(req)));
        } catch (err) { next(err); }
    });

    // JSON — имя/фамилия/био; multipart с полем `avatar` — аватарка.
    // Один маршрут на оба случая: клиенту удобнее слать частичный патч профиля
    // и картинку одним запросом.
    r.post("/accounts/:accountId/me", async (req, res, next) => {
        if (!isMultipart(req)) {
            try {
                const client = await getClient(req);
                res.json(await prof.updateProfile(client, pickProfileFields(req.body || {})));
            } catch (err) { next(err); }
            return;
        }
        req.uploadAvatar(req, res, async (uploadErr) => {
            if (uploadErr) return next(uploadErr);
            try {
                const client = await getClient(req);
                if (req.file?.buffer) {
                    await prof.setProfilePhoto(client, req.file.buffer);
                }
                // Текстовых полей могло и не быть — тогда просто возвращаем
                // актуальный профиль, чтобы ответ был одинаковой формы.
                const patch = pickProfileFields(req.body || {});
                const result = Object.keys(patch).length
                    ? await prof.updateProfile(client, patch)
                    : await prof.getMe(client);
                res.json(result);
            } catch (err) { next(err); }
        });
    });

    // ── Диалоги и чаты ────────────────────────────────────────────
    // Вызов dialogs заодно прогревает кэш сущностей: после рестарта это
    // единственный способ научить клиента резолвить чаты по числовому ID.
    r.get("/accounts/:accountId/dialogs", async (req, res, next) => {
        try {
            const client = await getClient(req);
            const { limit, archived, query } = req.query;
            const dialogs = await dlg.fetchDialogs(client, {
                limit: parseInt(limit || "100", 10),
                // undefined — «без фильтра», в отличие от явного false.
                archived: archived === undefined ? undefined : archived === "true",
                query,
            });
            res.json({ dialogs });
        } catch (err) { next(err); }
    });

    r.get("/accounts/:accountId/chat/:peer", async (req, res, next) => {
        try {
            const client = await getClient(req);
            res.json(await dlg.fetchChat(client, req.params.peer));
        } catch (err) { next(err); }
    });

    r.get("/accounts/:accountId/chat/:peer/history", async (req, res, next) => {
        try {
            const client = await getClient(req);
            const { limit, offsetId, reverse } = req.query;
            const history = await msg.fetchHistory(client, req.params.peer, {
                limit: parseInt(limit || "40", 10),
                offsetId: parseInt(offsetId || "0", 10),
                reverse: reverse === "true",
            });
            res.json({ messages: history });
        } catch (err) { next(err); }
    });

    // ── Сообщения ─────────────────────────────────────────────────
    r.post("/accounts/:accountId/chat/:peer/messages", async (req, res, next) => {
        try {
            const client = await getClient(req);
            const sent = await msg.sendMessage(client, req.params.peer, req.body?.text || "", {
                replyTo: req.body?.replyTo,
            });
            res.json(sent);
        } catch (err) { next(err); }
    });

    // Multipart: поле `files` (до 10 штук), остальные поля приходят строками —
    // отсюда ручное приведение replyTo и forceDocument.
    r.post("/accounts/:accountId/chat/:peer/files", (req, res, next) => {
        req.uploadFiles(req, res, async (uploadErr) => {
            if (uploadErr) return next(uploadErr);
            try {
                const client = await getClient(req);
                const files = (req.files || []).map((f) => ({ name: f.originalname, buffer: f.buffer }));
                const sent = await msg.sendFiles(client, req.params.peer, files, {
                    caption: req.body?.caption || "",
                    replyTo: req.body?.replyTo ? parseInt(req.body.replyTo, 10) : undefined,
                    forceDocument: String(req.body?.forceDocument || "false") === "true",
                });
                res.json({ sent });
            } catch (err) { next(err); }
        });
    });

    r.patch("/accounts/:accountId/chat/:peer/messages/:msgId", async (req, res, next) => {
        try {
            const client = await getClient(req);
            const edited = await msg.editMessage(client, req.params.peer,
                parseInt(req.params.msgId, 10), req.body?.text || "");
            res.json(edited);
        } catch (err) { next(err); }
    });

    // ids приходят строкой query-параметра: "1,2,3". revoke по умолчанию true —
    // удаление у всех участников, а не только у себя.
    r.delete("/accounts/:accountId/chat/:peer/messages", async (req, res, next) => {
        try {
            const client = await getClient(req);
            const ids = String(req.query.ids || "").split(",")
                .map((s) => parseInt(s, 10))
                .filter((n) => !Number.isNaN(n));
            if (ids.length === 0) return res.status(400).json({ error: "ids_required" });
            await msg.deleteMessages(client, req.params.peer, ids, {
                revoke: String(req.query.revoke ?? "true") !== "false",
            });
            res.json({ ok: true, deleted: ids });
        } catch (err) { next(err); }
    });

    r.post("/accounts/:accountId/chat/:peer/messages/:msgId/react", async (req, res, next) => {
        try {
            const client = await getClient(req);
            await msg.sendReaction(client, req.params.peer, parseInt(req.params.msgId, 10),
                req.body?.emoji || "👍");
            res.json({ ok: true });
        } catch (err) { next(err); }
    });

    // maxId = 0 означает «прочитать всё до последнего сообщения».
    r.post("/accounts/:accountId/chat/:peer/read", async (req, res, next) => {
        try {
            const client = await getClient(req);
            await msg.markAsRead(client, req.params.peer, parseInt(req.body?.maxId || "0", 10));
            res.json({ ok: true });
        } catch (err) { next(err); }
    });

    // :peer здесь — куда пересылаем, fromPeer в теле — откуда.
    r.post("/accounts/:accountId/chat/:peer/forward", async (req, res, next) => {
        try {
            const client = await getClient(req);
            const ids = (req.body?.ids || []).map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
            if (ids.length === 0) return res.status(400).json({ error: "ids_required" });
            const sent = await msg.forwardMessages(client, req.params.peer, ids, {
                fromPeer: req.body?.fromPeer,
            });
            res.json({ sent });
        } catch (err) { next(err); }
    });

    // ── Медиа ─────────────────────────────────────────────────────
    // Два маршрута ниже — единственные, отдающие не JSON, а байты.

    // Превью. Отдельный маршрут нужен ровно затем, чтобы показать вложение,
    // не выкачивая оригинал: обрезка весит килобайты против мегабайтов файла.
    r.get("/accounts/:accountId/chat/:peer/messages/:msgId/thumb", async (req, res, next) => {
        try {
            const client = await getClient(req);
            // Любое значение, кроме "s", означает крупную обрезку: ошибка в
            // параметре не должна оборачиваться отказом показать картинку.
            const want = req.query.size === "s" ? "s" : "m";
            const thumb = await msg.downloadThumb(client, req.params.peer,
                parseInt(req.params.msgId, 10), want, { ifNoneMatch: req.headers["if-none-match"] });

            res.setHeader("ETag", thumb.etag);
            // Файл в Telegram неизменен, а правка сообщения меняет метку сама,
            // поэтому обрезку можно держать в кеше долго и без перепроверок.
            res.setHeader("Cache-Control", "private, max-age=604800, immutable");
            if (thumb.notModified) return res.status(304).end();

            res.setHeader("Content-Type", thumb.mimeType);
            res.setHeader("Content-Length", thumb.buffer.length);
            res.send(thumb.buffer);
        } catch (err) { next(err); }
    });

    // Файл целиком или диапазоном. Тело идёт потоком: собрать его в память
    // значит отдать RSS шлюза во власть самого большого видео в чате.
    // filename* с UTF-8 — чтобы не терять кириллицу и эмодзи в именах.
    r.get("/accounts/:accountId/chat/:peer/messages/:msgId/file", async (req, res, next) => {
        let release = null;
        try {
            const client = await getClient(req);
            const opened = await msg.openMedia(client, req.params.peer, parseInt(req.params.msgId, 10));
            const { info } = opened;

            const range = parseRange(req.headers.range, info.size);
            const head = mediaResponseHead(info, range);
            res.status(head.status);
            for (const [name, value] of Object.entries(head.headers)) res.setHeader(name, value);
            // Пустой 206 плеер принимает за конец файла и останавливается —
            // на запрос за пределами файла нужен именно 416.
            if (head.status === 416) return res.end();

            // HEAD плеер шлёт первым, чтобы узнать размер и поддержку Range.
            if (req.method === "HEAD") return res.end();

            // Клиент отваливается на середине постоянно — перемотка видео так и
            // работает. Без прерывания шлюз продолжал бы качать файл в никуда.
            const abort = new AbortController();
            res.on("close", () => { if (!res.writableEnded) abort.abort(); });

            release = await downloadGate.acquire(req.account.accountId);
            for await (const chunk of msg.streamMedia(client, opened, { range, signal: abort.signal })) {
                // Обратное давление обязательно: без него чанки копятся в
                // буфере сокета, и экономия памяти на стриминге пропадает.
                if (!res.write(chunk)) {
                    await new Promise((resolve) => res.once("drain", resolve));
                }
            }
            res.end();
        } catch (err) {
            // Заголовки уже ушли — сообщить об ошибке нечем: дописать JSON в
            // тело файла хуже, чем оборвать соединение.
            if (res.headersSent) return res.destroy();
            next(err);
        } finally {
            if (release) release();
        }
    });

    // ── Статус присутствия ─────────────────────────────────────────
    // Отдельного «мой статус» в TL нет — вытаскиваем его из getMe.
    r.get("/accounts/:accountId/status", async (req, res, next) => {
        try {
            const me = await prof.getMe(await getClient(req));
            res.json({ online: /online/i.test(String(me.status)), status: me.status });
        } catch (err) { next(err); }
    });

    r.post("/accounts/:accountId/status", async (req, res, next) => {
        try {
            const online = Boolean(req.body?.online);
            await prof.setStatus(await getClient(req), online);
            res.json({ ok: true, online });
        } catch (err) { next(err); }
    });

    return r;
}

// ── Хелперы ─────────────────────────────────────────────────────

/**
 * Клиент Telegram для аккаунта запроса. Поднимает сессию при первом обращении
 * и переиспользует её дальше — вызывать напрямую buildClient нельзя.
 * @param {import("express").Request} req
 */
async function getClient(req) {
    return sessionManager.getClient(req.account);
}

/** @param {import("express").Request} req */
function isMultipart(req) {
    return String(req.headers["content-type"] || "").includes("multipart/form-data");
}

/**
 * Оставляет только поля профиля, которые реально пришли.
 * Отсутствие ключа и пустая строка — разные вещи: пустую строку Telegram
 * принимает как «стереть значение», поэтому проверяем именно на undefined.
 */
function pickProfileFields(body) {
    const patch = {};
    for (const key of ["firstName", "lastName", "about"]) {
        if (body[key] !== undefined) patch[key] = body[key];
    }
    return patch;
}
