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
import { normalizeMessage } from "../src/telegram/messages.js";
import { normalizeDialog } from "../src/telegram/dialogs.js";

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

test("sessionManager: channel создаётся единожды и чистится release", () => {
    const c1 = sessionManager.channel("acc_x");
    const c2 = sessionManager.channel("acc_x");
    assert.equal(c1, c2);
    let got = 0;
    c1.on("ping", () => got++);
    c1.emit("ping");
    assert.equal(got, 1);
    sessionManager.release("acc_x");
    assert.equal(sessionManager.channels.has("acc_x"), false);
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
