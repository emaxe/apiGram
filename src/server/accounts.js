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
        updateAccount(accountId, { sessionString: "", status: "no_session", me: null,
            auth: { phoneCodeHash: null } });
    },
};

export function listAccounts(token) {
    // Возвращает аккаунты, принадлежащие токену; в MVP один токен = один аккаунт.
    const acc = findAccountByToken(token);
    return acc ? [toPublic(acc)] : [];
}

export function getAccount(accountId, token) {
    const acc = findAccount(accountId);
    if (!acc || acc.apiToken !== token) return null;
    return acc;
}

export function makeAccount(name) {
    return createAccount(name);
}

export function removeAccount(accountId, token) {
    const acc = getAccount(accountId, token);
    if (!acc) return false;
    return delAccount(accountId);
}

/** Публичное представление без секрета sessionString. */
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