import { z } from "zod";
import { sessionManager } from "../../telegram/sessionManager.js";
import { sendFiles, openMedia } from "../../telegram/messages.js";
import { withToolError } from "../toolError.js";

/**
 * Регистрирует tools для отправки и получения ссылок на файлы вложений.
 *
 * `download_file` намеренно не отдаёт байты внутрь MCP-ответа: агенту это
 * раздувает контекст, а стриминг с Range уже реализован в REST
 * (`GET /v1/accounts/:accountId/chat/:peer/messages/:msgId/file`). Вместо
 * этого tool отдаёт ту же ссылку и тот же Bearer-токен, которым уже открыта
 * эта MCP-сессия.
 *
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {object} account
 * @param {string} baseUrl "http(s)://host[:port]" без завершающего слэша
 */
export function registerMediaTools(server, account, baseUrl) {
    server.registerTool(
        "send_files",
        {
            title: "Отправить файлы",
            description: "Отправляет один файл или альбом (до 10 файлов) в чат. Каждый файл — base64.",
            inputSchema: {
                peer: z.string(),
                files: z.array(z.object({ name: z.string(), base64: z.string() })).min(1).max(10),
                caption: z.string().optional(),
                replyTo: z.number().int().optional(),
                forceDocument: z.boolean().optional(),
            },
        },
        withToolError(async ({ peer, files, caption, replyTo, forceDocument }) => {
            const client = await sessionManager.getClient(account);
            const uploadable = files.map((f) => ({ name: f.name, buffer: Buffer.from(f.base64, "base64") }));
            const sent = await sendFiles(client, peer, uploadable, { caption, replyTo, forceDocument });
            return { content: [{ type: "text", text: JSON.stringify({ sent }, null, 2) }] };
        })
    );

    server.registerTool(
        "download_file",
        {
            title: "Ссылка на файл вложения",
            description: "Возвращает метаданные и временную HTTP-ссылку на файл вложения сообщения — не сами байты.",
            inputSchema: { peer: z.string(), messageId: z.number().int() },
        },
        withToolError(async ({ peer, messageId }) => {
            const client = await sessionManager.getClient(account);
            const { info } = await openMedia(client, peer, messageId);
            const url = `${baseUrl}/v1/accounts/${account.accountId}/chat/${encodeURIComponent(peer)}/messages/${messageId}/file`;
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        fileName: info.fileName,
                        mimeType: info.mimeType,
                        size: info.size,
                        url,
                        authorization: `Bearer ${account.apiToken}`,
                    }, null, 2),
                }],
            };
        })
    );
}
