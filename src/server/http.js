import express from "express";
import multer from "multer";
import { getAccount, listAccounts } from "./accounts.js";
import { bearerToken } from "./bearer.js";
import { buildRouter } from "./router.js";
import { toHttpError } from "./httpErrors.js";

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
    app.use(express.json({ limit: "10mb" }));

    app.get("/v1/health", (req, res) => {
        res.json({ ok: true, version: "1.0.0" });
    });

    app.get("/v1/accounts", (req, res) => {
        const accounts = listAccounts(bearerToken(req));
        if (accounts.length === 0) return res.status(401).json({ error: "invalid_token" });
        res.json({ accounts });
    });

    // Единая Bearer-проверка на всё, что адресовано конкретному аккаунту.
    app.use("/v1/accounts/:accountId", (req, res, next) => {
        const account = getAccount(req.params.accountId, bearerToken(req));
        if (!account) return res.status(401).json({ error: "invalid_token" });
        req.account = account;
        req.uploadFiles = uploadFiles;
        req.uploadAvatar = uploadAvatar;
        next();
    });

    app.use("/v1", buildRouter());

    app.use((req, res) => {
        res.status(404).json({ error: "not_found", message: `Нет такого эндпоинта: ${req.method} ${req.originalUrl}` });
    });

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const { status, body } = toHttpError(err);
        if (status >= 500) console.error("[apiGram]", err);
        res.status(status).json(body);
    });
    return app;
}
