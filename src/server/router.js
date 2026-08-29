import { Router } from "express";
import { makeAccount, removeAccount, toPublic, accountStore } from "./accounts.js";
import { isAdmin, bearerToken } from "./bearer.js";
import { sessionManager } from "../telegram/sessionManager.js";
import * as authApi from "../telegram/auth.js";
import * as msg from "../telegram/messages.js";
import * as dlg from "../telegram/dialogs.js";
import * as prof from "../telegram/profile.js";

/** @returns {import("express").Router} */
export function buildRouter() {
    const r = Router();

    // Создание аккаунта. Токен отдаём в ответе один раз — больше он нигде не показывается.
    r.post("/accounts", (req, res) => {
        if (!isAdmin(req)) return res.status(401).json({ error: "admin_token_required" });
        const account = makeAccount(req.body?.name || "");
        res.status(201).json({ ...toPublic(account), apiToken: account.apiToken });
    });

    r.delete("/accounts/:accountId", async (req, res, next) => {
        try {
            await sessionManager.detach(req.account.accountId);
            const ok = removeAccount(req.account.accountId, bearerToken(req));
            res.json({ ok });
        } catch (err) { next(err); }
    });

    // ── Авторизация ───────────────────────────────────────────────
    r.post("/accounts/:accountId/auth/send-code", async (req, res, next) => {
        try {
            const { phone } = req.body || {};
            if (!phone) return res.status(400).json({ error: "phone_required", step: "send-code" });
            const result = await authApi.sendCode(req.account, phone);
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

    r.post("/accounts/:accountId/auth/logout", async (req, res, next) => {
        try {
            await authApi.logout(req.account, accountStore);
            res.json({ ok: true });
        } catch (err) { next(err); }
    });

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
                const patch = pickProfileFields(req.body || {});
                const result = Object.keys(patch).length
                    ? await prof.updateProfile(client, patch)
                    : await prof.getMe(client);
                res.json(result);
            } catch (err) { next(err); }
        });
    });

    // ── Диалоги и чаты ────────────────────────────────────────────
    r.get("/accounts/:accountId/dialogs", async (req, res, next) => {
        try {
            const client = await getClient(req);
            const { limit, archived, query } = req.query;
            const dialogs = await dlg.fetchDialogs(client, {
                limit: parseInt(limit || "100", 10),
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

    r.post("/accounts/:accountId/chat/:peer/read", async (req, res, next) => {
        try {
            const client = await getClient(req);
            await msg.markAsRead(client, req.params.peer, parseInt(req.body?.maxId || "0", 10));
            res.json({ ok: true });
        } catch (err) { next(err); }
    });

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

    r.get("/accounts/:accountId/chat/:peer/messages/:msgId/file", async (req, res, next) => {
        try {
            const client = await getClient(req);
            const media = await msg.downloadMedia(client, req.params.peer,
                parseInt(req.params.msgId, 10));
            res.setHeader("Content-Type", media.mimeType || "application/octet-stream");
            res.setHeader("Content-Length", media.buffer.length);
            if (media.fileName) {
                res.setHeader("Content-Disposition",
                    `attachment; filename*=UTF-8''${encodeURIComponent(media.fileName)}`);
            }
            res.send(media.buffer);
        } catch (err) { next(err); }
    });

    // ── Статус присутствия ─────────────────────────────────────────
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

/** @param {import("express").Request} req */
async function getClient(req) {
    return sessionManager.getClient(req.account);
}

/** @param {import("express").Request} req */
function isMultipart(req) {
    return String(req.headers["content-type"] || "").includes("multipart/form-data");
}

/** Оставляет только поля профиля, которые реально пришли. */
function pickProfileFields(body) {
    const patch = {};
    for (const key of ["firstName", "lastName", "about"]) {
        if (body[key] !== undefined) patch[key] = body[key];
    }
    return patch;
}
