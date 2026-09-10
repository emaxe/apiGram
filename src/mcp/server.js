import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { registerDialogTools } from "./tools/dialogs.js";
import { registerMessageTools } from "./tools/messages.js";
import { registerMediaTools } from "./tools/media.js";

/**
 * Собирает MCP-сервер для одного Telegram-аккаунта. Привязка к аккаунту —
 * через замыкание в каждом registerXTools, отдельного состояния здесь нет.
 * @param {object} account сырой аккаунт из реестра (с apiToken и accountId)
 * @param {string} baseUrl "http(s)://host[:port]" без завершающего слэша — для ссылок на файлы
 * @returns {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer}
 */
export function createMcpServer(account, baseUrl) {
    const server = new McpServer({ name: "apigram", version: config.version });
    registerDialogTools(server, account);
    registerMessageTools(server, account);
    registerMediaTools(server, account, baseUrl);
    return server;
}
