/**
 * CORS для браузерных клиентов.
 *
 * По умолчанию выключен: без заголовков ни одна страница не может обратиться к
 * шлюзу, и это правильное состояние для сервера, который держит боевые сессии
 * Telegram. Включается списком источников в `CORS_ORIGINS`.
 *
 * Список, а не `*`, — сознательно. При пустом `ADMIN_TOKEN` эндпоинт
 * `POST /v1/accounts` открыт всем, поэтому с `*` любая посещённая пользователем
 * страница смогла бы создавать аккаунты на его локальном шлюзе. Значение `*`
 * поддержано, но только явным указанием и с предупреждением при старте.
 */

/**
 * Разбирает `CORS_ORIGINS` в список источников.
 * @param {string} raw "http://localhost:8080, https://gram.example.com" | "*"
 * @returns {string[]} пустой список означает «CORS выключен»
 */
export function parseOrigins(raw) {
    return String(raw || "")
        .split(",")
        .map((value) => value.trim().replace(/\/+$/, ""))
        .filter(Boolean);
}

/**
 * Разрешён ли источник.
 * @param {string} origin значение заголовка Origin
 * @param {string[]} allowed
 * @returns {boolean}
 */
export function isOriginAllowed(origin, allowed) {
    if (!origin || allowed.length === 0) return false;
    if (allowed.includes("*")) return true;
    return allowed.includes(origin.replace(/\/+$/, ""));
}

/** Заголовки, которые браузеру разрешено читать из ответа. */
const EXPOSED_HEADERS = [
    // Без этих двух клиент не узнает имя и размер скачиваемого вложения.
    "Content-Disposition",
    "Content-Length",
    // Нужны для докачки и потокового воспроизведения медиа.
    "Content-Range",
    "Accept-Ranges",
    "ETag",
].join(", ");

/** Заголовки, которые клиенту разрешено присылать. */
const ALLOWED_HEADERS = ["Authorization", "Content-Type", "Range", "If-None-Match"].join(", ");

const ALLOWED_METHODS = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"].join(", ");

/**
 * Middleware CORS. Если список пуст, ничего не делает.
 * @param {string[]} allowed
 * @returns {import("express").RequestHandler}
 */
export function corsMiddleware(allowed) {
    return function cors(req, res, next) {
        const origin = req.headers.origin;
        if (!origin || allowed.length === 0) return next();

        if (!isOriginAllowed(origin, allowed)) {
            // Предварительный запрос от чужого источника обрываем сразу: без
            // заголовков браузер всё равно не пропустит ответ, а выполнять
            // побочные действия ради заведомо отброшенного ответа незачем.
            if (req.method === "OPTIONS") return res.status(403).end();
            return next();
        }

        // Vary обязателен: ответы различаются по Origin, и без него
        // промежуточный кеш отдал бы заголовки одного источника другому.
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS);

        if (req.method === "OPTIONS") {
            res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
            res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
            res.setHeader("Access-Control-Max-Age", "600");
            return res.status(204).end();
        }
        return next();
    };
}
