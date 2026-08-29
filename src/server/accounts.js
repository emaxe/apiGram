import {
    createAccount,
    findAccount,
    findAccountByToken,
    updateAccount,
    deleteAccount as delAccount,
} from "../registry/accountsFile.js";

/** Функции сохранения, которые протокол auth вызывает после логина. */
export const accountStore = {
    saveAuthorized(accountId, patch) {
        updateAccount(accountId, patch);
    },
    clearSession(accountId) {
        updateAccount(accountId, {
            sessionString: "",
            status: "no_session",
            me: null,
            auth: { phoneCodeHash: null },
        });
    },
};

/**
 * Аккаунты, принадлежащие токену. В MVP один токен = один аккаунт.
 * @param {string} token
 * @returns {Array<object>} публичные представления
 */
export function listAccounts(token) {
    const account = findAccountByToken(token);
    return account ? [toPublic(account)] : [];
}

/**
 * Аккаунт по ID при условии, что токен принадлежит именно ему.
 * @param {string} accountId
 * @param {string} token
 * @returns {object|null} сырой аккаунт (с sessionString) или null
 */
export function getAccount(accountId, token) {
    if (!accountId || !token) return null;
    const account = findAccount(accountId);
    if (!account || account.apiToken !== token) return null;
    return account;
}

/**
 * Создаёт аккаунт и выдаёт токен.
 * @param {string} name
 * @returns {object}
 */
export function makeAccount(name) {
    return createAccount(name);
}

/**
 * Удаляет аккаунт, если токен ему принадлежит.
 * @param {string} accountId
 * @param {string} token
 * @returns {boolean}
 */
export function removeAccount(accountId, token) {
    if (!getAccount(accountId, token)) return false;
    return delAccount(accountId);
}

/**
 * Публичное представление без секретов (sessionString, apiToken).
 * @param {object} acc
 * @returns {object}
 */
export function toPublic(acc) {
    return {
        accountId: acc.accountId,
        name: acc.name,
        phone: acc.phone,
        status: acc.status,
        me: acc.me,
        createdAt: acc.createdAt,
    };
}
