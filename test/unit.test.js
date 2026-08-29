import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { readJson, writeJson } from "../src/storage/json.js";
import { ensureDir } from "../src/storage/json.js";
import {
    createAccount,
    findAccount,
    findAccountByToken,
    updateAccount,
    deleteAccount,
} from "../src/registry/accountsFile.js";
import { sessionManager } from "../src/telegram/sessionManager.js";
import { authStatus } from "../src/telegram/auth.js";
import { normalizeMessage, sendFiles } from "../src/telegram/messages.js";
import { normalizeDialog } from "../src/telegram/dialogs.js";
import { toPlain } from "../src/telegram/serialize.js";
import { ProtocolError } from "../src/telegram/errors.js";
import { toHttpError } from "../src/server/httpErrors.js";

test("json: writeJson/readJson round-trip с 0600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apigram-"));
    const file = path.join(dir, "nested", "data.json");
    writeJson(file, { a: 1, b: [2, 3] });
    assert.deepEqual(readJson(file), { a: 1, b: [2, 3] });
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(readJson(path.join(dir, "missing.json"), "def"), "def");
    assert.equal(readJson(path.join(dir, "broken.json")), null);
});

test("registry: create/find/update/delete", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apigram-"));
    const account = createAccount("test");
    assert.ok(account.accountId.startsWith("acc_"));
    assert.ok(account.apiToken.startsWith("tok_"));
    assert.equal(account.status, "no_session");

    const found = findAccount(account.accountId);
    assert.equal(found.accountId, account.accountId);
    assert.equal(found.apiToken, account.apiToken);

    const byToken = findAccountByToken(account.apiToken);
    assert.equal(byToken.accountId, account.accountId);
    assert.equal(findAccountByToken("nope"), undefined);

    updateAccount(account.accountId, { phone: "+7999" });
    assert.equal(findAccount(account.accountId).phone, "+7999");

    assert.equal(deleteAccount(account.accountId), true);
    assert.equal(findAccount(account.accountId), undefined);
    assert.equal(deleteAccount(account.accountId), false);
});

test("sessionManager: channel переиспользуется и переживает release", async () => {
    const c1 = sessionManager.channel("acc_x");
    const c2 = sessionManager.channel("acc_x");
    assert.equal(c1, c2);
    let got = 0;
    c1.on("ping", () => got++);
    c1.emit("ping");
    assert.equal(got, 1);

    // release шлёт терминальное событие, но НЕ выбрасывает канал: иначе
    // подписанные WS-сокеты остались бы на emitter'е, который после повторного
    // логина никто уже не использует.
    const closed = [];
    c1.on("account_event", (e) => closed.push(e));
    await sessionManager.release("acc_x");
    assert.equal(sessionManager.channels.get("acc_x"), c1);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].type, "session_closed");
    sessionManager.channels.delete("acc_x");
});

test("sessionManager: onChannelCreated срабатывает только на новый канал", () => {
    const seen = [];
    sessionManager.onChannelCreated((id) => seen.push(id));
    sessionManager.channel("acc_obs");
    sessionManager.channel("acc_obs");
    assert.deepEqual(seen, ["acc_obs"]);
    sessionManager.channelObservers.length = 0;
    sessionManager.channels.delete("acc_obs");
});

test("auth: authStatus по состояниям", () => {
    assert.deepEqual(authStatus({ status: "authorized", me: { id: "1" } }), {
        status: "authorized",
        me: { id: "1" },
    });
    assert.deepEqual(authStatus({ status: "awaiting_2fa" }), {
        status: "awaiting_2fa",
        next: "password",
    });
    assert.deepEqual(authStatus({ status: "code_sent" }), {
        status: "code_sent",
        next: "code",
    });
    assert.deepEqual(authStatus({ status: "no_session" }), {
        status: "no_session",
        next: "phone",
    });
});

test("messages: normalizeMessage сворачивает даты и peerId", () => {
    const msg = normalizeMessage({
        id: 12,
        date: 1700000000,
        out: true,
        message: "hi",
        peerId: { value: 123 },
        fromId: { userId: 7 },
    });
    assert.equal(msg.id, 12);
    assert.equal(msg.text, "hi");
    assert.equal(msg.out, true);
    assert.equal(msg.peerId, "123");
    assert.equal(msg.fromId, "7");
    assert.ok(msg.date > 0);
    assert.equal(normalizeMessage(null), null);
});

test("messages: normalizeMessage сворачивает entities в JSON-safe", () => {
    const msg = normalizeMessage({
        id: 13,
        message: "@user hi",
        peerId: { value: 1 },
        entities: [
            { className: "MessageEntityMentionName", offset: 0, length: 5, userId: 123456789n },
            { className: "MessageEntityTextUrl", offset: 7, length: 2, url: "https://x.test" },
        ],
    });
    assert.ok(Array.isArray(msg.entities));
    assert.equal(msg.entities.length, 2);
    assert.equal(msg.entities[0].userId, "123456789");
    assert.doesNotThrow(() => JSON.stringify(msg));
});

test("dialogs: normalizeDialog отдаёт компактный объект", () => {
    const d = normalizeDialog({
        id: { value: -100789 },
        entity: { className: "Channel", broadcast: true, title: "Канал" },
        message: { id: 1, date: 1700000000, message: "yep" },
        pinned: true,
    });
    assert.equal(d.id, "-100789");
    assert.equal(d.type, "channel");
    assert.equal(d.title, "Канал");
    assert.equal(d.pinned, true);
    assert.equal(d.lastMessage.text, "yep");
});

test("httpErrors: коды ProtocolError → HTTP-статусы, а не тотальный 500", () => {
    const notFound = toHttpError(new ProtocolError("peer_not_found", "Чат не найден."));
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error, "peer_not_found");

    const badCode = toHttpError(new ProtocolError("phone_code_invalid", "Неверный код.", {
        step: "verify-code",
    }));
    assert.equal(badCode.status, 400);
    assert.equal(badCode.body.step, "verify-code");

    const notAuth = toHttpError(new ProtocolError("not_authorized", "Не авторизован.", {
        hint: "send-code",
    }));
    assert.equal(notAuth.status, 409);
    assert.equal(notAuth.body.hint, "send-code");

    const flood = toHttpError(Object.assign(new Error("FLOOD_WAIT_42"), { seconds: 42 }));
    assert.equal(flood.status, 429);
    assert.equal(flood.body.seconds, 42);

    const raw = toHttpError(Object.assign(new Error("boom"), { errorMessage: "CHAT_WRITE_FORBIDDEN" }));
    assert.equal(raw.status, 403);

    assert.equal(toHttpError(new Error("что-то пошло не так")).status, 500);
});

test("serialize: toPlain обезвреживает BigInt, Buffer, Date и методы", () => {
    const plain = toPlain({
        className: "Message",
        id: 5,
        big: 123456789012345678901234567890n,
        buf: Buffer.from("hi"),
        when: new Date("2024-01-02T03:04:05.000Z"),
        reply: () => {},
        _private: "скрыто",
        nested: { arr: [1n, "x"] },
    });
    assert.equal(plain.className, "Message");
    assert.equal(plain.big, "123456789012345678901234567890");
    assert.equal(plain.buf.base64, Buffer.from("hi").toString("base64"));
    assert.equal(plain.when, "2024-01-02T03:04:05.000Z");
    assert.equal("reply" in plain, false);
    assert.equal("_private" in plain, false);
    assert.deepEqual(plain.nested.arr, ["1", "x"]);
    assert.doesNotThrow(() => JSON.stringify(plain));
});

test("messages: sendFiles заворачивает {name, buffer} в CustomFile", async () => {
    const { CustomFile } = await import("teleproto/client/uploads.js");
    let passed;
    const client = {
        getEntity: async () => ({ className: "User", id: 1 }),
        sendFile: async (entity, params) => { passed = params; return [{ id: 1, message: "" }]; },
    };
    await sendFiles(client, "me", [{ name: "a.txt", buffer: Buffer.from("hi") }]);
    // Простой объект teleproto не принимает — раньше сюда уходил {name, buffer}
    // и sendFile падал с "Cannot use [object Object] as file".
    assert.ok(passed.file instanceof CustomFile);
    assert.equal(passed.file.name, "a.txt");
    assert.equal(passed.file.size, 2);

    await sendFiles(client, "me", [
        { name: "a.txt", buffer: Buffer.from("a") },
        { name: "b.txt", buffer: Buffer.from("bb") },
    ]);
    assert.ok(Array.isArray(passed.file));
    assert.ok(passed.file.every((f) => f instanceof CustomFile));

    await assert.rejects(() => sendFiles(client, "me", []), /Не указан ни один файл/);
    await assert.rejects(
        () => sendFiles(client, "me", new Array(11).fill({ name: "x", buffer: Buffer.from("x") })),
        /не больше 10 файлов/
    );
});
