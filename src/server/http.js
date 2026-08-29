import express from "express";
import multer from "multer";
import { findAccountByToken } from "../registry/accountsFile.js";
import { toPublic } from "./accounts.js";
import { buildRouter } from "./router.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }).array("files", 10);

/**
 * Создаёт Express-приложение.
 * @returns {import("express").Express}
 */
export function createHttpApp() {
    const app = express();
    app.use(express.json({ limit: "10mb" }));

    app.get("/v1/accounts", (req, res) => {
        const auth = req.headers.authorization || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const account = findAccountByToken(token);
        if (!account) return res.status(401).json({ error: "invalid_token" });
        res.json({ accounts: [toPublic(account)] });
    });

    app.use("/v1/accounts/:accountId", (req, res, next) => {
        const auth = req.headers.authorization || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const account = findAccountByToken(token);
        if (!account || account.accountId !== req.params.accountId) {
            return res.status(401).json({ error: "invalid_token" });
        }
        req.account = account;
        req.upload = upload;
        next();
    });

    app.use("/v1", buildRouter());
    app.use((err, req, res, next) => {
        const status = err?.status || 500;
        res.status(status).json({ error: String(err?.message || err) });
    });
    return app;
}