/**
 * HTTP-статусы для кодов `ProtocolError` из слоя `telegram/`.
 * @type {Record<string, number>}
 */
const CODE_STATUS = {
    // 400 — клиент прислал неверные данные / нарушил порядок шагов
    peer_required: 400,
    file_invalid: 400,
    no_files: 400,
    too_many_files: 400,
    phone_invalid: 400,
    phone_code_invalid: 400,
    phone_code_expired: 400,
    password_invalid: 400,
    auth_step_missing: 400,
    email_auth_unsupported: 400,
    signup_required: 400,
    phone_banned: 403,
    // 403 — доступа к чату нет
    peer_forbidden: 403,
    // 404 — сущность не найдена
    peer_not_found: 404,
    message_not_found: 404,
    no_media: 404,
    // 409 — аккаунт не в том состоянии
    not_authorized: 409,
    session_invalid: 409,
};

/**
 * Сырые ошибки teleproto, для которых у нас нет своего кода, но статус очевиден.
 * @type {Array<{ pattern: RegExp, status: number, code: string }>}
 */
const RAW_PATTERNS = [
    { pattern: /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/i, status: 409, code: "session_invalid" },
    { pattern: /CHAT_WRITE_FORBIDDEN|USER_IS_BLOCKED|CHAT_SEND_\w+_FORBIDDEN/i, status: 403, code: "forbidden" },
    { pattern: /MESSAGE_ID_INVALID|MESSAGE_DELETE_FORBIDDEN/i, status: 400, code: "message_invalid" },
    { pattern: /MESSAGE_NOT_MODIFIED|MESSAGE_EMPTY|MESSAGE_TOO_LONG/i, status: 400, code: "message_invalid" },
    { pattern: /REACTION_INVALID|REACTIONS_TOO_MANY/i, status: 400, code: "reaction_invalid" },
    { pattern: /Could not find the input entity|Cannot find any entity/i, status: 404, code: "peer_not_found" },
];

/**
 * Превращает любую ошибку в HTTP-ответ `{ status, body }`.
 * Спека требует внятных статусов и `{ step, hint }` на шагах логина —
 * до этого всё, кроме FloodWait, отдавалось как 500.
 * @param {any} err
 * @returns {{ status: number, body: object }}
 */
export function toHttpError(err) {
    const message = String(err?.errorMessage || err?.message || err);

    if (typeof err?.seconds === "number" || /FLOOD_WAIT|floodwait/i.test(message)) {
        return {
            status: 429,
            body: { error: "flood_wait", message, seconds: err.seconds || 0 },
        };
    }

    if (err?.code && CODE_STATUS[err.code]) {
        const body = { error: err.code, message };
        if (err.step) body.step = err.step;
        if (err.hint) body.hint = err.hint;
        return { status: CODE_STATUS[err.code], body };
    }

    for (const { pattern, status, code } of RAW_PATTERNS) {
        if (pattern.test(message)) {
            return { status, body: { error: code, message } };
        }
    }

    if (typeof err?.status === "number") {
        return { status: err.status, body: { error: err.code || "error", message } };
    }

    return { status: 500, body: { error: "internal_error", message } };
}
