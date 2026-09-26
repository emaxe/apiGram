import { resolveEntity } from "./entities.js";
import { normalizeMessage } from "./messages.js";
import { ProtocolError } from "./errors.js";

/**
 * Копирует сообщения в другой чат без пересылки (без штампа «Переслано от»).
 *
 * Без подписи — `forwardMessages({dropAuthor: true})`: дешевле и сохраняет
 * альбом одним вызовом. С подписью `dropAuthor` бесполезен (подпись всё равно
 * своя), поэтому вложение переносится через `sendFile` со ссылкой на media
 * исходного сообщения — Telegram не перекачивает файл, а строит
 * `InputMediaPhoto`/`InputMediaDocument` по уже существующему file-id.
 *
 * @param {import("teleproto").TelegramClient} client
 * @param {string} toPeer
 * @param {Array<number>} ids
 * @param {{ fromPeer: string, caption?: string, parseMode?: string }} opts
 * @returns {Promise<Array<object>>}
 */
export async function copyMessages(client, toPeer, ids, { fromPeer, caption, parseMode } = {}) {
    const sourceEntity = await resolveEntity(client, fromPeer);
    if (sourceEntity.noforwards) {
        throw new ProtocolError("protected_content", "Источник запрещает пересылку своего содержимого.");
    }
    const targetEntity = await resolveEntity(client, toPeer);

    if (!caption) {
        const sent = await client.forwardMessages(targetEntity, { messages: ids, fromPeer: sourceEntity, dropAuthor: true });
        return (Array.isArray(sent) ? sent : [sent]).filter(Boolean).map(normalizeMessage);
    }

    const raw = await client.getMessages(sourceEntity, { ids });
    const sent = [];
    for (const message of raw) {
        if (!message) continue;
        const params = { file: message.media, caption };
        if (parseMode !== undefined) params.parseMode = parseMode;
        sent.push(normalizeMessage(await client.sendFile(targetEntity, params)));
    }
    return sent;
}
