import crypto from "node:crypto";
import { config } from "../config.js";
import { readJson, writeJson } from "../storage/json.js";

/**
 * Читает весь реестр аккаунтов.
 * @returns {{ accounts: Array<object> }}
 */
export function readRegistry() {
    return readJson(config.accountsFile, { accounts: [] });
}

/** @param {object} registry */
export function saveRegistry(registry) {
    writeJson(config.accountsFile, registry);
}

/**
 * Находит аккаунт по ID.
 * @param {string} accountId
 * @returns {object|undefined}
 */
export function findAccount(accountId) {
    return readRegistry().accounts.find((a) => a.accountId === accountId);
}

/**
 * Находит аккаунт по API-токену.
 * @param {string} apiToken
 * @returns {object|undefined}
 */
export function findAccountByToken(apiToken) {
    return readRegistry().accounts.find((a) => a.apiToken === apiToken);
}

function genId(prefix) {
    return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Создаёт новый аккаунт (без телеграм-сессии).
 * @param {string} name
 * @returns {object} аккаунт
 */
export function createAccount(name) {
    const account = {
        accountId: genId("acc"),
        name: name || "",
        apiToken: genId("tok"),
        phone: "",
        sessionString: "",
        status: "no_session",
        auth: { phoneCodeHash: null },
        me: null,
        createdAt: Date.now(),
    };
    const registry = readRegistry();
    registry.accounts.push(account);
    saveRegistry(registry);
    return account;
}

/**
 * Обновляет поля аккаунта и сохраняет.
 * @param {string} accountId
 * @param {object} patch
 * @returns {object|undefined} обновлённый аккаунт
 */
export function updateAccount(accountId, patch) {
    const registry = readRegistry();
    const account = registry.accounts.find((a) => a.accountId === accountId);
    if (!account) return undefined;
    Object.assign(account, patch);
    saveRegistry(registry);
    return account;
}

/**
 * Удаляет аккаунт.
 * @param {string} accountId
 * @returns {boolean}
 */
export function deleteAccount(accountId) {
    const registry = readRegistry();
    const before = registry.accounts.length;
    registry.accounts = registry.accounts.filter((a) => a.accountId !== accountId);
    if (registry.accounts.length === before) return false;
    saveRegistry(registry);
    return true;
}
