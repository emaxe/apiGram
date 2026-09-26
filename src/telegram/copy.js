import { resolveEntity } from "./entities.js";
import { normalizeMessage } from "./messages.js";
import { ProtocolError } from "./errors.js";

/**
 * Вложения, которые `sendFile`/`getInputMedia` teleproto не умеют превратить
 * в исходящее медиа (веб-превью ссылки — не самостоятельный файл). Проверяем
 * заранее и отдаём внятный код, а не даём teleproto упасть непонятной
 * ошибкой каста.
 */
const UNSUPPORTED_MEDIA_CLASSES = new Set(["MessageMediaWebPage"]);

/**
 * Копирует сообщения в другой чат без пересылки (без штампа «Переслано от»).
 *
 * Без подписи — `forwardMessages({dropAuthor: true})`: дешевле и сохраняет
 * альбом одним вызовом. С подписью `dropAuthor` бесполезен (подпись всё равно
 * своя), поэтому вложение переносится через `sendFile` со ссылкой на media
 * исходного сообщения — Telegram не перекачивает файл, а строит
 * `InputMediaPhoto`/`InputMediaDocument` по уже существующему file-id.
 * Несколько сообщений с вложением уходят одним `sendFile` (альбом), а не по
 * одному на сообщение — иначе подпись оказалась бы на каждом посте отдельно.
 * Текстовое сообщение без вложения `sendFile` принять не может (`file`
 * обязателен), поэтому подпись для него отправляется обычным `sendMessage`.
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

    const raw = (await client.getMessages(sourceEntity, { ids })).filter(Boolean);
    const withMedia = raw.filter((message) => message.media);
    for (const message of withMedia) {
        if (UNSUPPORTED_MEDIA_CLASSES.has(message.media.className)) {
            throw new ProtocolError(
                "unsupported_media",
                `Вложение типа ${message.media.className} нельзя переотправить со своей подписью.`
            );
        }
    }

    if (withMedia.length === 0) {
        const params = { message: caption };
        if (parseMode !== undefined) params.parseMode = parseMode;
        return [normalizeMessage(await client.sendMessage(targetEntity, params))];
    }

    const params = {
        file: withMedia.length === 1 ? withMedia[0].media : withMedia.map((message) => message.media),
        caption,
    };
    if (parseMode !== undefined) params.parseMode = parseMode;
    const sent = await client.sendFile(targetEntity, params);
    return (Array.isArray(sent) ? sent : [sent]).filter(Boolean).map(normalizeMessage);
}
