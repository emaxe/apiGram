import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../mcp/server.js";

/**
 * Активные MCP-сессии на процесс: sessionId → { transport, accountId }.
 * accountId хранится отдельно, чтобы не открывать чужую сессию по угаданному
 * id — сравнение идёт всегда с `req.account.accountId`, который уже проверен
 * bearer-мидлварой в `http.js`.
 * @type {Map<string, { transport: StreamableHTTPServerTransport, accountId: string }>}
 */
const sessions = new Map();

/**
 * POST /v1/accounts/:accountId/mcp — инициализация сессии или JSON-RPC вызов
 * в уже открытой сессии.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function handleMcpPost(req, res) {
    const sessionId = req.headers["mcp-session-id"];
    let entry = sessionId ? sessions.get(sessionId) : undefined;

    if (entry && entry.accountId !== req.account.accountId) {
        res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        return;
    }

    if (!entry) {
        if (!isInitializeRequest(req.body)) {
            res.status(400).json({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Bad Request: No valid session ID provided" },
                id: null,
            });
            return;
        }
        const baseUrl = `${req.protocol}://${req.get("host")}`;
        const server = createMcpServer(req.account, baseUrl);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (newSessionId) => {
                sessions.set(newSessionId, { transport, accountId: req.account.accountId });
            },
        });
        transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        entry = { transport, accountId: req.account.accountId };
    }

    await entry.transport.handleRequest(req, res, req.body);
}

/**
 * GET/DELETE /v1/accounts/:accountId/mcp — SSE-поток уведомлений и закрытие сессии.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function handleMcpGetOrDelete(req, res) {
    const sessionId = req.headers["mcp-session-id"];
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry || entry.accountId !== req.account.accountId) {
        res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        return;
    }
    await entry.transport.handleRequest(req, res);
}
