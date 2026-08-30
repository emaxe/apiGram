/**
 * Сквозная ручная проверка apiGram на живом аккаунте Telegram.
 *
 *   npm start                      # в одном терминале
 *   node scripts/smoke.mjs         # в другом
 *
 * Переменные окружения:
 *   BASE         базовый URL (по умолчанию http://127.0.0.1:3111/v1)
 *   ADMIN_TOKEN  если задан на сервере — нужен для создания аккаунта
 *   ACC, TOKEN   переиспользовать уже залогиненный аккаунт (без повторного логина)
 *
 * Скрипт пишет только в «Избранное» (peer = me). Логаут НЕ делается, чтобы
 * сессию можно было переиспользовать: ACC/TOKEN печатаются в конце.
 */
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const BASE = process.env.BASE || "http://127.0.0.1:3111/v1";
const rl = readline.createInterface({ input: stdin, output: stdout });

const ESC = "[";
const c = {
    ok: `${ESC}32m`,
    bad: `${ESC}31m`,
    dim: `${ESC}90m`,
    head: `${ESC}1m`,
    off: `${ESC}0m`,
};

let passed = 0;
let failed = 0;

function head(text) {
    console.log(`\n${c.head}-- ${text} ${"-".repeat(Math.max(0, 58 - text.length))}${c.off}`);
}

function preview(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/** Выполняет шаг, печатает результат и не роняет весь прогон при ошибке. */
async function step(name, fn) {
    try {
        const result = await fn();
        passed++;
        console.log(`${c.ok}OK${c.off}   ${name}`);
        if (result !== undefined) console.log(`${c.dim}     ${preview(result)}${c.off}`);
        return result;
    } catch (err) {
        failed++;
        console.log(`${c.bad}FAIL${c.off} ${name}`);
        console.log(`${c.bad}     ${err.message}${c.off}`);
        return undefined;
    }
}

/** Запрос к API с проверкой статуса. */
async function api(method, url, { body, token, form, raw } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload;
    if (form) {
        payload = form;
    } else if (body !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
    }
    const res = await fetch(`${BASE}${url}`, { method, headers, body: payload });
    if (raw) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (!res.ok) throw new Error(`${res.status} ${buf.toString("utf8").slice(0, 200)}`);
        return { buffer: buf, headers: res.headers };
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) throw new Error(`${res.status} ${preview(data)}`);
    return data;
}

/** Ввод без эха — для 2FA-пароля. */
async function secret(question) {
    // Читаем тем же readline, который уже владеет stdin: собственный async-итератор
    // над stdin уничтожил бы поток на выходе из цикла и уронил бы rl с ABORT_ERR.
    // Эхо гасим подменой stdout.write на время ввода.
    stdout.write(question);
    const own = Object.prototype.hasOwnProperty.call(stdout, "write");
    const write = stdout.write;
    stdout.write = () => true;
    try {
        return await rl.question("");   // без trim: пробелы в пароле значимы
    } finally {
        if (own) stdout.write = write; else delete stdout.write;
        stdout.write("\n");
    }
}

async function main() {
    head("Сервер");
    await step("GET /health", () => api("GET", "/health"));

    let accountId = process.env.ACC || "";
    let token = process.env.TOKEN || "";

    if (accountId && token) {
        console.log(`${c.dim}Переиспользую аккаунт из ACC/TOKEN${c.off}`);
    } else {
        head("Аккаунт и авторизация");
        const created = await step("POST /accounts", () =>
            api("POST", "/accounts", { body: { name: "smoke" }, token: process.env.ADMIN_TOKEN }));
        if (!created) throw new Error("не удалось создать аккаунт — дальше нет смысла");
        accountId = created.accountId;
        token = created.apiToken;

        await step("GET /auth/status (ожидается no_session)", async () => {
            const s = await api("GET", `/accounts/${accountId}/auth/status`, { token });
            if (s.status !== "no_session") throw new Error(`ожидался no_session, получен ${s.status}`);
            return s;
        });

        const phone = (await rl.question("\nНомер телефона (например +79991234567): ")).trim();
        const sent = await step("POST /auth/send-code", () =>
            api("POST", `/accounts/${accountId}/auth/send-code`, { body: { phone }, token }));
        if (!sent) throw new Error("код не отправлен");

        const code = (await rl.question("Код из Telegram: ")).trim();
        let verified = await step("POST /auth/verify-code", () =>
            api("POST", `/accounts/${accountId}/auth/verify-code`, { body: { code }, token }));

        if (verified?.next === "password") {
            console.log(`${c.dim}     Включён 2FA — это самая переписанная часть, смотрим внимательно${c.off}`);
            const password = await secret("Пароль 2FA (ввод скрыт): ");
            verified = await step("POST /auth/password", () =>
                api("POST", `/accounts/${accountId}/auth/password`, { body: { password }, token }));
        }
        if (verified?.next !== "done") throw new Error("логин не завершён");
    }

    const auth = { token };
    const acc = `/accounts/${accountId}`;
    const me = `${acc}/chat/${encodeURIComponent("me")}`;

    head("Профиль и диалоги");
    await step("GET /me", () => api("GET", `${acc}/me`, auth));
    await step("GET /status", () => api("GET", `${acc}/status`, auth));
    await step("GET /dialogs?limit=5", async () => {
        const d = await api("GET", `${acc}/dialogs?limit=5`, auth);
        return `диалогов: ${d.dialogs.length}, первый: ${d.dialogs[0]?.title ?? "-"}`;
    });
    await step("GET /chat/me (инфо о чате)", () => api("GET", me, auth));

    head("WebSocket");
    const events = [];
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws?accountId=${accountId}&token=${token}`);
    ws.on("message", (d) => events.push(JSON.parse(d.toString())));
    ws.on("error", (e) => events.push({ type: "ws_error", error: e.message }));
    await step("подключение и событие connected", () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("не дождались connected за 10 с")), 10_000);
        ws.once("message", (d) => { clearTimeout(timer); resolve(JSON.parse(d.toString())); });
        ws.once("close", (code) => { clearTimeout(timer); reject(new Error(`сокет закрыт кодом ${code}`)); });
    }));

    head("Сообщения (всё в «Избранное»)");
    const sentMsg = await step("POST /messages", () =>
        api("POST", `${me}/messages`, { ...auth, body: { text: "apiGram smoke test" } }));
    const msgId = sentMsg?.id;

    await step("GET /history?limit=3", async () => {
        const h = await api("GET", `${me}/history?limit=3`, auth);
        return `сообщений: ${h.messages.length}, верхнее: ${JSON.stringify(h.messages[0]?.text)}`;
    });

    if (msgId) {
        await step("PATCH /messages/:id (редактирование)", () =>
            api("PATCH", `${me}/messages/${msgId}`, { ...auth, body: { text: "apiGram smoke test (изменено)" } }));
        await step("POST /messages/:id/react", () =>
            api("POST", `${me}/messages/${msgId}/react`, { ...auth, body: { emoji: "\u{1F44D}" } }));
        await step("POST /read", () => api("POST", `${me}/read`, { ...auth, body: { maxId: msgId } }));
        await step("POST /forward (в тот же чат)", () =>
            api("POST", `${me}/forward`, { ...auth, body: { ids: [msgId], fromPeer: "me" } }));
    }

    head("Файлы");
    const tmpFile = path.join(os.tmpdir(), `apigram-smoke-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "apiGram: проверка загрузки файла\n");
    const uploaded = await step("POST /files (multipart)", async () => {
        const form = new FormData();
        form.append("files", new Blob([fs.readFileSync(tmpFile)]), path.basename(tmpFile));
        form.append("caption", "smoke");
        const r = await api("POST", `${me}/files`, { ...auth, form });
        if (!r.sent?.length) throw new Error("сервер не вернул отправленных сообщений");
        return `отправлено: ${r.sent.length}, id: ${r.sent[0].id}`;
    });
    fs.unlinkSync(tmpFile);

    if (uploaded) {
        const recent = await api("GET", `${me}/history?limit=5`, auth);
        const fileMsgId = recent.messages.find((m) => m.mediaType)?.id;
        if (fileMsgId) {
            await step("GET /messages/:id/file (скачивание)", async () => {
                const { buffer, headers } = await api("GET", `${me}/messages/${fileMsgId}/file`, { ...auth, raw: true });
                return `${buffer.length} байт, type=${headers.get("content-type")}, disposition=${headers.get("content-disposition") ?? "-"}`;
            });
        }
    }

    head("Ошибки (должны быть осмысленные статусы, не 500)");
    await step("несуществующий юзернейм -> 404 peer_not_found", async () => {
        try {
            await api("GET", `${acc}/chat/${encodeURIComponent("@no_such_user_zzz_12345")}`, auth);
        } catch (err) {
            if (/^404/.test(err.message)) return err.message;
            throw new Error(`ожидался 404, получено: ${err.message}`);
        }
        throw new Error("ошибки не было, а должна быть");
    });
    await step("чужой токен -> 401", async () => {
        try {
            await api("GET", `${acc}/me`, { token: "tok_wrong" });
        } catch (err) {
            if (/^401/.test(err.message)) return err.message;
            throw new Error(`ожидался 401, получено: ${err.message}`);
        }
        throw new Error("ошибки не было, а должна быть");
    });

    head("Realtime");
    console.log("Напишите себе в «Избранное» с телефона — ждём событие 20 секунд...");
    await step("входящее событие new_message в WebSocket", () => new Promise((resolve, reject) => {
        const seen = events.find((e) => e.type === "new_message");
        if (seen) return resolve(`уже поймано: ${JSON.stringify(seen.message?.text)}`);
        const timer = setTimeout(() => reject(new Error("за 20 с событий new_message не пришло")), 20_000);
        const onMsg = (d) => {
            const event = JSON.parse(d.toString());
            if (event.type !== "new_message") return;
            clearTimeout(timer);
            ws.off("message", onMsg);
            resolve(`text=${JSON.stringify(event.message?.text)} peer=${event.message?.peerId}`);
        };
        ws.on("message", onMsg);
    }));

    ws.close();
    rl.close();

    head("Итог");
    console.log(`${c.ok}успешно: ${passed}${c.off}   ${failed ? c.bad : c.dim}провалено: ${failed}${c.off}`);
    console.log(`\nСобытий в сокете: ${events.length}`);
    for (const e of events.slice(0, 10)) console.log(`${c.dim}  ${e.type}${c.off}`);
    console.log(`\nПовторный прогон без логина:\n  ACC=${accountId} TOKEN=${token} node scripts/smoke.mjs`);
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error(`\n${c.bad}Прогон прерван: ${err.message}${c.off}`);
    rl.close();
    process.exit(1);
});
