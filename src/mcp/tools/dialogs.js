import { z } from "zod";
import { sessionManager } from "../../telegram/sessionManager.js";
import * as dlg from "../../telegram/dialogs.js";
import { fetchHistory } from "../../telegram/messages.js";
import { withToolError } from "../toolError.js";

/**
 * Регистрирует tools для диалогов и истории сообщений одного аккаунта.
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {object} account
 */
export function registerDialogTools(server, account) {
    server.registerTool(
        "list_dialogs",
        {
            title: "Список диалогов",
            description: "Список чатов аккаунта: личные переписки, группы, каналы.",
            inputSchema: {
                limit: z.number().int().min(1).max(200).optional(),
                archived: z.boolean().optional(),
                query: z.string().optional(),
            },
        },
        withToolError(async ({ limit, archived, query }) => {
            const client = await sessionManager.getClient(account);
            const dialogs = await dlg.fetchDialogs(client, { limit, archived, query });
            return { content: [{ type: "text", text: JSON.stringify({ dialogs }, null, 2) }] };
        })
    );

    server.registerTool(
        "get_chat",
        {
            title: "Информация о чате",
            description: "Данные о пользователе, группе или канале по идентификатору или @username.",
            inputSchema: { peer: z.string() },
        },
        withToolError(async ({ peer }) => {
            const client = await sessionManager.getClient(account);
            const chat = await dlg.fetchChat(client, peer);
            return { content: [{ type: "text", text: JSON.stringify(chat, null, 2) }] };
        })
    );

    server.registerTool(
        "get_history",
        {
            title: "История сообщений",
            description: "Сообщения чата с пагинацией по offsetId.",
            inputSchema: {
                peer: z.string(),
                limit: z.number().int().min(1).max(200).optional(),
                offsetId: z.number().int().optional(),
                reverse: z.boolean().optional(),
            },
        },
        withToolError(async ({ peer, limit, offsetId, reverse }) => {
            const client = await sessionManager.getClient(account);
            const messages = await fetchHistory(client, peer, { limit, offsetId, reverse });
            return { content: [{ type: "text", text: JSON.stringify({ messages }, null, 2) }] };
        })
    );
}
