import { config } from "../config.js";

/**
 * Достаёт Bearer-токен из заголовка Authorization.
 * @param {import("express").Request} req
 * @returns {string}
 */
export function bearerToken(req) {
    const auth = req.headers.authorization || "";
    return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

/**
 * Проверяет админ-токен для операций над реестром аккаунтов.
 * Если `ADMIN_TOKEN` не задан, создание аккаунтов остаётся открытым — это
 * допустимо только на `127.0.0.1`, о чём предупреждаем при старте (`index.js`).
 * @param {import("express").Request} req
 * @returns {boolean}
 */
export function isAdmin(req) {
    if (!config.adminToken) return true;
    return bearerToken(req) === config.adminToken;
}
