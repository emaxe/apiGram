import { errors } from "teleproto";
import { apiCredentials, sessionManager } from "./sessionManager.js";

const { SessionPasswordNeededError } = errors;

/**
 * Отправляет код подтверждения на телефон.
 * @param {object} account
 * @param {string} phone
 * @returns {Promise<{ codeHash: string }>}
 */
export async function sendCode(account, phone) {
    const client = await sessionManager.startLogin(account, phone);
    const creds = apiCredentials();
    const res = await client.sendCode(creds, phone);
    const entry = sessionManager.getPending(account.accountId);
    if (entry) entry.phoneCodeHash = res.phoneCodeHash;
    return { codeHash: res.phoneCodeHash, isCodeViaApp: Boolean(res.isCodeViaApp) };
}

/**
 * Проверяет код. Если нужен 2FA — возвращает { next: "password" }.
 * Иначе сохраняет сессию и возвращает { next: "done", me }.
 * @param {object} account
 * @param {object} accountStore функции сохранения в реестр (инъекция, чтобы не тянуть реестр в протокол)
 * @param {string} code
 * @returns {Promise<{ next: "password"|"done", me?: object }>}
 */
export async function verifyCode(account, accountStore, code) {
    const entry = sessionManager.getPending(account.accountId);
    if (!entry || !entry.phoneCodeHash) {
        throw new Error("Сначала вызовите send-code.");
    }
    const creds = apiCredentials();
    try {
        const user = await entry.client.signInUser(creds, {
            phoneNumber: entry.phone,
            phoneCodeHash: entry.phoneCodeHash,
            phoneCode: async () => code,
        });
        return await finalizeLogin(account, accountStore, entry.client, user);
    } catch (err) {
        if (err instanceof SessionPasswordNeededError) {
            return { next: "password" };
        }
        throw err;
    }
}

/**
 * Подтверждает 2FA-пароль и завершает логин.
 * @param {object} account
 * @param {object} accountStore
 * @param {string} password
 * @returns {Promise<{ next: "done", me: object }>}
 */
export async function verifyPassword(account, accountStore, password) {
    const entry = sessionManager.getPending(account.accountId);
    if (!entry) {
        throw new Error("Сначала вызовите send-code.");
    }
    const creds = apiCredentials();
    const user = await entry.client.signInWithPassword(creds, { password });
    return finalizeLogin(account, accountStore, entry.client, user);
}

async function finalizeLogin(account, accountStore, client, user) {
    const sessionString = client.session.save();
    const me = {
        id: String(user.id),
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        username: user.username || null,
        phone: user.phone || account.phone || "",
    };
    await sessionManager.registerAuthorized(account, client);
    accountStore.saveAuthorized(account.accountId, { sessionString, status: "authorized", me });
    return { next: "done", me };
}

/**
 * Полный логаут аккаунта.
 * @param {object} account
 * @param {object} accountStore
 * @returns {Promise<void>}
 */
export async function logout(account, accountStore) {
    await sessionManager.release(account.accountId);
    accountStore.clearSession(account.accountId);
}

/**
 * Статус авторизации аккаунта.
 * @param {object} account
 * @returns {{ status: string, next?: string, me?: object|null }}
 */
export function authStatus(account) {
    if (account.status === "authorized") {
        return { status: account.status, me: account.me };
    }
    if (account.status === "code_sent" || account.status === "awaiting_2fa") {
        return {
            status: account.status,
            next: account.status === "awaiting_2fa" ? "password" : "code",
        };
    }
    return { status: "no_session", next: "phone" };
}
