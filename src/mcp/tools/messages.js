import { z } from "zod";
import { sessionManager } from "../../telegram/sessionManager.js";
import * as msg from "../../telegram/messages.js";
import { withToolError } from "../toolError.js";

/**
 * Регистрирует tools для отправки, редактирования и модерации сообщений.
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {object} account
 */
export function registerMessageTools(server, account) {
    server.registerTool(
        "send_message",
        {
            title: "Отправить сообщение",
            description: "Отправляет текстовое сообщение в чат.",
            inputSchema: {
                peer: z.string(),
                text: z.string(),
                replyTo: z.number().int().optional(),
                topMsgId: z.number().int().optional(),
                parseMode: z.enum(["markdown", "md", "html", "markdownv2", "md2"]).optional(),
                silent: z.boolean().optional(),
                linkPreview: z.boolean().optional(),
            },
        },
        withToolError(async ({ peer, text, replyTo, topMsgId, parseMode, silent, linkPreview }) => {
            const client = await sessionManager.getClient(account);
            const sent = await msg.sendMessage(client, peer, text, { replyTo, topMsgId, parseMode, silent, linkPreview });
            return { content: [{ type: "text", text: JSON.stringify(sent, null, 2) }] };
        })
    );

    server.registerTool(
        "edit_message",
        {
            title: "Редактировать сообщение",
            description: "Меняет текст уже отправленного сообщения.",
            inputSchema: {
                peer: z.string(),
                messageId: z.number().int(),
                text: z.string(),
                parseMode: z.enum(["markdown", "md", "html", "markdownv2", "md2"]).optional(),
                linkPreview: z.boolean().optional(),
            },
        },
        withToolError(async ({ peer, messageId, text, parseMode, linkPreview }) => {
            const client = await sessionManager.getClient(account);
            const edited = await msg.editMessage(client, peer, messageId, text, { parseMode, linkPreview });
            return { content: [{ type: "text", text: JSON.stringify(edited, null, 2) }] };
        })
    );

    server.registerTool(
        "delete_messages",
        {
            title: "Удалить сообщения",
            description: "Удаляет одно или несколько сообщений в чате.",
            inputSchema: {
                peer: z.string(),
                ids: z.array(z.number().int()).min(1),
                revoke: z.boolean().optional(),
            },
        },
        withToolError(async ({ peer, ids, revoke }) => {
            const client = await sessionManager.getClient(account);
            await msg.deleteMessages(client, peer, ids, { revoke });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: ids }, null, 2) }] };
        })
    );

    server.registerTool(
        "mark_as_read",
        {
            title: "Отметить прочитанным",
            description: "Отмечает сообщения в чате прочитанными до maxId (0 или отсутствие — всё до последнего).",
            inputSchema: { peer: z.string(), maxId: z.number().int().optional() },
        },
        withToolError(async ({ peer, maxId }) => {
            const client = await sessionManager.getClient(account);
            await msg.markAsRead(client, peer, maxId ?? 0);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }] };
        })
    );

    server.registerTool(
        "react",
        {
            title: "Поставить реакцию",
            description: "Ставит эмодзи-реакцию на сообщение.",
            inputSchema: { peer: z.string(), messageId: z.number().int(), emoji: z.string().optional() },
        },
        withToolError(async ({ peer, messageId, emoji }) => {
            const client = await sessionManager.getClient(account);
            await msg.sendReaction(client, peer, messageId, emoji);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }] };
        })
    );

    server.registerTool(
        "forward_messages",
        {
            title: "Переслать сообщения",
            description: "Пересылает сообщения из одного чата в другой.",
            inputSchema: {
                toPeer: z.string(),
                ids: z.array(z.number().int()).min(1),
                fromPeer: z.string().optional(),
            },
        },
        withToolError(async ({ toPeer, ids, fromPeer }) => {
            const client = await sessionManager.getClient(account);
            const sent = await msg.forwardMessages(client, toPeer, ids, { fromPeer });
            return { content: [{ type: "text", text: JSON.stringify({ sent }, null, 2) }] };
        })
    );
}
