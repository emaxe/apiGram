import { Api, errors } from "teleproto";
import { computeCheck } from "teleproto/Password.js";
import { sessionManager } from "./sessionManager.js";
import { ProtocolError } from "./errors.js";

const { SessionPasswordNeededError } = errors;

/**
 * Отправляет код подтверждения на телефон.
 *
 * Используется низкоуровневый `client.sendCode`, а не `client.signInUser`:
 * последний сам заново шлёт код и игнорирует переданный `phoneCodeHash`,
 * поэтому пошаговый логин через REST на нём не строится.
 * @param {object} account
 * @param {string} phone
 * @returns {Promise<{ codeHash: string, isCodeViaApp: boolean }>}
 */
export async function sendCode(account, phone) {
    const client = await sessionManager.startLogin(account, phone);
    const creds = sessionManager.apiCredentials();
    const res = await client.sendCode(creds, phone);
    if (res.emailRequired || res.emailCodeSent) {
        throw new ProtocolError(
            "email_auth_unsupported",
            "Для этого номера Telegram требует подтверждение по email — такой вход не поддерживается.",
            { step: "send-code" }
        );
    }
    const entry = sessionManager.getPending(account.accountId);
    if (entry) entry.phoneCodeHash = res.phoneCodeHash;
    return { codeHash: res.phoneCodeHash, isCodeViaApp: Boolean(res.isCodeViaApp) };
}

/**
 * Проверяет код. Если включён 2FA — возвращает `{ next: "password" }`.
 * Иначе сохраняет сессию и возвращает `{ next: "done", me }`.
 * @param {object} account
 * @param {object} accountStore функции сохранения в реестр (инъекция, чтобы не тянуть реестр в протокол)
 * @param {string} code
 * @returns {Promise<{ next: "password"|"done", me?: object }>}
 */
export async function verifyCode(account, accountStore, code) {
    const entry = sessionManager.getPending(account.accountId);
    if (!entry || !entry.phoneCodeHash) {
        throw new ProtocolError("auth_step_missing", "Сначала вызовите send-code.", {
            step: "verify-code",
            hint: "POST /v1/accounts/:id/auth/send-code",
        });
    }
    let result;
    try {
        result = await entry.client.invoke(new Api.auth.SignIn({
            phoneNumber: entry.phone,
            phoneCodeHash: entry.phoneCodeHash,
            phoneCode: String(code),
        }));
    } catch (err) {
        if (err instanceof SessionPasswordNeededError) {
            return { next: "password" };
        }
        throw asAuthError(err, "verify-code");
    }
    if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        throw new ProtocolError(
            "signup_required",
            "Аккаунт с таким номером не зарегистрирован в Telegram. Регистрация через API не поддерживается.",
            { step: "verify-code" }
        );
    }
    return finalizeLogin(account, accountStore, entry.client, result.user);
}

/**
 * Подтверждает 2FA-пароль (SRP) и завершает логин.
 * @param {object} account
 * @param {object} accountStore
 * @param {string} password
 * @returns {Promise<{ next: "done", me: object }>}
 */
export async function verifyPassword(account, accountStore, password) {
    const entry = sessionManager.getPending(account.accountId);
    if (!entry) {
        throw new ProtocolError("auth_step_missing", "Сначала вызовите send-code.", {
            step: "password",
            hint: "POST /v1/accounts/:id/auth/send-code",
        });
    }
    let result;
    try {
        const passwordInfo = await entry.client.invoke(new Api.account.GetPassword());
        const srp = await computeCheck(passwordInfo, password);
        result = await entry.client.invoke(new Api.auth.CheckPassword({ password: srp }));
    } catch (err) {
        throw asAuthError(err, "password");
    }
    return finalizeLogin(account, accountStore, entry.client, result.user);
}

/**
 * Превращает ошибку teleproto в `ProtocolError` с понятным текстом и шагом.
 * @param {any} err
 * @param {string} step
 * @returns {Error}
 */
function asAuthError(err, step) {
    const message = String(err?.errorMessage || err?.message || err);
    if (/PHONE_CODE_INVALID/i.test(message)) {
        return new ProtocolError("phone_code_invalid", "Неверный код подтверждения.", { step, cause: err });
    }
    if (/PHONE_CODE_EXPIRED/i.test(message)) {
        return new ProtocolError("phone_code_expired", "Код подтверждения истёк, запросите новый.", {
            step,
            hint: "POST /v1/accounts/:id/auth/send-code",
            cause: err,
        });
    }
    if (/PHONE_CODE_EMPTY|PHONE_CODE_HASH_EMPTY/i.test(message)) {
        return new ProtocolError("auth_step_missing", "Код или его hash пустые — начните логин заново.", {
            step,
            cause: err,
        });
    }
    if (/PASSWORD_HASH_INVALID/i.test(message)) {
        return new ProtocolError("password_invalid", "Неверный пароль двухфакторной аутентификации.", {
            step,
            cause: err,
        });
    }
    if (/PHONE_NUMBER_INVALID/i.test(message)) {
        return new ProtocolError("phone_invalid", "Некорректный номер телефона.", { step, cause: err });
    }
    if (/PHONE_NUMBER_BANNED/i.test(message)) {
        return new ProtocolError("phone_banned", "Номер заблокирован в Telegram.", { step, cause: err });
    }
    return err;
}

/**
 * Общий финал успешного логина: сохранить сессию, поднять слушателя, обновить реестр.
 * @param {object} account
 * @param {object} accountStore
 * @param {import("teleproto").TelegramClient} client
 * @param {object} user
 * @returns {Promise<{ next: "done", me: object }>}
 */
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
    accountStore.saveAuthorized(account.accountId, {
        sessionString,
        status: "authorized",
        me,
        auth: { phoneCodeHash: null },
    });
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
