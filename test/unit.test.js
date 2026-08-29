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
