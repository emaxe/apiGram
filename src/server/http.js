/**
 * Сборка Express-приложения: парсеры, аутентификация, роутер, обработка ошибок.
 * Сами эндпоинты живут в router.js — здесь только каркас и то, что должно
 * выполняться до/после всех маршрутов.
 */
import express from "express";
import multer from "multer";
import { getAccount, listAccounts } from "./accounts.js";
import { bearerToken } from "./bearer.js";
import { buildRouter } from "./router.js";
import { toHttpError } from "./httpErrors.js";
import { corsMiddleware } from "./cors.js";
import { config } from "../config.js";

// Файлы держим в памяти: они сразу уходят в Telegram, писать их на диск незачем —
// это лишний след с пользовательским контентом. Отсюда и жёсткие лимиты размера.
const uploadFiles = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
}).array("files", 10);

const uploadAvatar = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
}).single("avatar");

/**
 * Создаёт Express-приложение.
 * @returns {import("express").Express}
 */
export function createHttpApp() {
    const app = express();
    app.disable("x-powered-by");
    // CORS идёт первым: предварительный запрос OPTIONS не несёт ни тела,
    // ни токена, и до разбора JSON с проверкой Bearer доходить не должен.
    app.use(corsMiddleware(config.corsOrigins));
    app.use(express.json({ limit: "10mb" }));

    app.get("/v1/health", (req, res) => {
        res.json({ ok: true, version: config.version });
    });

    // Список аккаунтов токена. Пустой результат означает, что токен не опознан:
    // отдельного «покажи все аккаунты» здесь нет и быть не должно.
    app.get("/v1/accounts", (req, res) => {
        const accounts = listAccounts(bearerToken(req));
        if (accounts.length === 0) return res.status(401).json({ error: "invalid_token" });
        res.json({ accounts });
    });

    // Единая Bearer-проверка на всё, что адресовано конкретному аккаунту.
    // Дальше по цепочке req.account уже гарантированно принадлежит владельцу токена,
    // поэтому обработчики маршрутов прав больше не проверяют.
    app.use("/v1/accounts/:accountId", (req, res, next) => {
        const account = getAccount(req.params.accountId, bearerToken(req));
        if (!account) return res.status(401).json({ error: "invalid_token" });
        req.account = account;
        // Multer-обработчики прокидываем в req: роутер вызывает их вручную, только
        // для multipart-запросов, чтобы не парсить форму там, где ждём JSON.
        req.uploadFiles = uploadFiles;
        req.uploadAvatar = uploadAvatar;
        next();
    });

    app.use("/v1", buildRouter());

    app.use((req, res) => {
        res.status(404).json({ error: "not_found", message: `Нет такого эндпоинта: ${req.method} ${req.originalUrl}` });
    });

    // Единственная точка, где ошибка превращается в HTTP-ответ. Четыре аргумента
    // обязательны — по их числу Express опознаёт error-middleware.
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const { status, body } = toHttpError(err);
        if (status >= 500) console.error("[apiGram]", err);
        res.status(status).json(body);
    });
    return app;
}
