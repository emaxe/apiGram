import { Api, errors } from "teleproto";
import { CustomFile } from "teleproto/client/uploads.js";
import { resolveEntity, toMarkedId } from "./entities.js";
import { idToString } from "./serialize.js";
import { ProtocolError } from "./errors.js";

const { FloodWaitError } = errors;

/** Максимальное ожидание FloodWait внутри запроса, сек. Дольше — отдаём 429 наверх. */
const FLOOD_WAIT_MAX_SECONDS = 30;

/**
 * Нормализует сообщение MTProto в компактный объект.
 * @param {object} message
 * @returns {object}
 */
export function normalizeMessage(message) {
    if (!message) return null;
    return {
        id: message.id,
        date: message.date ? message.date * 1000 : Date.now(),
        editDate: message.editDate ? message.editDate * 1000 : null,
        out: Boolean(message.out),
        text: message.message || "",
        fromId: idToString(message.fromId?.userId || message.fromId?.channelId || message.fromId?.chatId),
        peerId: toMarkedId(message.peerId),
        replyToMsgId: message.replyTo?.replyToMsgId || null,
        pinned: Boolean(message.pinned),
        views: message.views || null,
        forwards: message.forwards || null,
        mediaType: message.media?.className || null,
        entities: normalizeEntities(message.entities),
        reactions: Array.isArray(message.reactions?.results)
            ? message.reactions.results.map((r) => ({
                  emoticon: r.reaction?.emoticon || "👍",
                  count: r.count || 1,
                  chosen: Boolean(r.chosenOrder),
              }))
            : [],
    };
}

/**
 * Приводит entities сообщения к JSON-safe виду. Сырые TL-объекты могут
 * содержать bigint (например, userId в MessageEntityMentionName), что ломает
 * JSON.stringify — поэтому каждый entity сворачивается в плоский объект.
 * @param {object[]} [entities]
 * @returns {object[]}
 */
function normalizeEntities(entities) {
    if (!Array.isArray(entities)) return [];
    return entities.map((e) => {
        const out = {
            type: e.className || "unknown",
            offset: e.offset,
            length: e.length,
        };
        if (e.url !== undefined) out.url = e.url;
        if (e.userId !== undefined) out.userId = idToString(e.userId);
        return out;
    });
}

/**
 * История сообщений чата с защитой от FloodWait.
 * @param {import("teleproto").TelegramClient} client
 * @param {string} rawPeer
 * @param {object} [opts] { limit=40, offsetId=0, reverse=false }
 * @returns {Promise<Array<object>>}
 */
export async function fetchHistory(client, rawPeer, { limit = 40, offsetId = 0, reverse = false } = {}) {
    const entity = await resolveEntity(client, rawPeer);
    const messages = [];
    const load = async () => {
        for await (const msg of client.iterMessages(entity, { limit, offsetId, reverse })) {
            if (msg && msg.className !== "MessageEmpty") messages.push(normalizeMessage(msg));
        }
    };
    try {
        await load();
    } catch (err) {
        const isFlood = err instanceof FloodWaitError || typeof err?.seconds === "number";
        // Долгий FloodWait не отсиживаем внутри HTTP-запроса — пробрасываем,
        // сервер отдаст 429 с `seconds`, и клиент повторит сам.
        if (!isFlood || (err.seconds || 0) > FLOOD_WAIT_MAX_SECONDS) throw err;
        const wait = (err.seconds || 5) + 1;
        await new Promise((r) => setTimeout(r, wait * 1000));
        messages.length = 0;
        await load();
    }
    return messages;
}

/**
 * Отправка текстового сообщения.
 * @param {import("teleproto").TelegramClient} client
 * @param {string} rawPeer
 * @param {string} text
 * @param {object} [opts] { replyTo }
 * @returns {Promise<object>}
 */
export async function sendMessage(client, rawPeer, text, { replyTo } = {}) {
    const entity = await resolveEntity(client, rawPeer);
    const params = { message: text };
    if (replyTo) params.replyTo = replyTo;
    const sent = await client.sendMessage(entity, params);
    return normalizeMessage(sent);
}

/** @param {import("teleproto").TelegramClient} client @param {string} rawPeer @param {number} id @param {string} text */
export async function editMessage(client, rawPeer, id, text) {
    const entity = await resolveEntity(client, rawPeer);
    return normalizeMessage(await client.editMessage(entity, { message: id, text }));
}

/** @param {import("teleproto").TelegramClient} client @param {string} rawPeer @param {Array<number>} ids @param {{revoke?:boolean}} [opts] */
export async function deleteMessages(client, rawPeer, ids, { revoke = true } = {}) {
    const entity = await resolveEntity(client, rawPeer);
    return await client.deleteMessages(entity, ids, { revoke });
}

/** Максимум вложений в альбоме. */
export const ALBUM_LIMIT = 10;

/**
 * Приводит вход к тому, что понимает `client.sendFile`: путь, Buffer или
 * `{ name, buffer }` из multipart. Простой объект `{name, buffer}` teleproto
 * не принимает — его нужно завернуть в `CustomFile`, иначе получаем
 * `Cannot use [object Object] as file`.
 * @param {string|Buffer|{name?: string, buffer: Buffer}} file
 * @returns {string|Buffer|import("teleproto/client/uploads.js").CustomFile}
 */
function toUploadable(file) {
    if (typeof file === "string" || Buffer.isBuffer(file)) return file;
    if (file && Buffer.isBuffer(file.buffer)) {
        return new CustomFile(file.name || "file", file.buffer.length, "", file.buffer);
    }
    throw new ProtocolError("file_invalid", "Не удалось прочитать файл для отправки.");
}

/**
 * Отправка одного файла или альбома.
 * @param {import("teleproto").TelegramClient} client
 * @param {string} rawPeer
 * @param {string|Buffer|{name?: string, buffer: Buffer}|Array<string|Buffer|{name?: string, buffer: Buffer}>} files
 * @param {object} [opts] { caption, replyTo, forceDocument }
 * @returns {Promise<Array<object>>}
 */
export async function sendFiles(client, rawPeer, files, { caption = "", replyTo, forceDocument = false } = {}) {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
    if (list.length === 0) throw new ProtocolError("no_files", "Не указан ни один файл.");
    if (list.length > ALBUM_LIMIT) {
        throw new ProtocolError("too_many_files", `За раз не больше ${ALBUM_LIMIT} файлов.`);
    }
    const uploadable = list.map(toUploadable);
    const entity = await resolveEntity(client, rawPeer);
    const params = {
        file: uploadable.length === 1 ? uploadable[0] : uploadable,
        caption,
        forceDocument,
    };
    if (replyTo) params.replyTo = replyTo;
    const sent = await client.sendFile(entity, params);
    return (Array.isArray(sent) ? sent : [sent]).filter(Boolean).map(normalizeMessage);
}

/**
 * Скачивание медиа сообщения. Нормализованное сообщение не хранит сырое медиа,
 * поэтому сначала дотягиваем полный объект через getMessages, затем качаем.
 * @param {import("teleproto").TelegramClient} client
 * @param {string} rawPeer
 * @param {number} messageId
 * @returns {Promise<Buffer>}
 */
export async function downloadMedia(client, rawPeer, messageId) {
    const entity = await resolveEntity(client, rawPeer);
    const [raw] = await client.getMessages(entity, { ids: [messageId] });
    if (!raw) throw new ProtocolError("message_not_found", "Сообщение не найдено.");
    if (!raw.media) throw new ProtocolError("no_media", "У сообщения нет медиа.");
    const buffer = await client.downloadMedia(raw.media);
    return {
        buffer: Buffer.from(buffer || []),
        fileName: mediaFileName(raw.media),
        mimeType: raw.media.document?.mimeType || null,
    };
}

/**
 * Достаёт имя файла из атрибутов документа, если оно есть.
 * @param {object} media
 * @returns {string|null}
 */
function mediaFileName(media) {
    const attributes = media?.document?.attributes;
    if (!Array.isArray(attributes)) return null;
    const named = attributes.find((a) => a.className === "DocumentAttributeFilename");
    return named?.fileName || null;
}

/**
 * Отправка реакции.
 * @param {import("teleproto").TelegramClient} client
 * @param {string} rawPeer
 * @param {number} messageId
 * @param {string} [emoji="👍"]
 */
export async function sendReaction(client, rawPeer, messageId, emoji = "👍") {
    const entity = await resolveEntity(client, rawPeer);
    return await client.invoke(new Api.messages.SendReaction({
        peer: entity,
        msgId: messageId,
        reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
    }));
}

/** @param {import("teleproto").TelegramClient} client @param {string} rawPeer @param {number} [maxId=0] */
export async function markAsRead(client, rawPeer, maxId = 0) {
    const entity = await resolveEntity(client, rawPeer);
    try {
        if (maxId > 0) await client.markAsRead(entity, maxId, {});
        else await client.markAsRead(entity);
    } catch {
        // игнорируем незначительные ошибки прочтения
    }
}

/**
 * Пересылка сообщений.
 * @param {import("teleproto").TelegramClient} client
 * @param {string} toPeer
 * @param {Array<number>} ids
 * @param {object} [opts] { fromPeer }
 * @returns {Promise<Array<object>>}
 */
export async function forwardMessages(client, toPeer, ids, { fromPeer } = {}) {
    const entity = await resolveEntity(client, toPeer);
    const params = { messages: ids };
    if (fromPeer) params.fromPeer = await resolveEntity(client, fromPeer);
    const sent = await client.forwardMessages(entity, params);
    return (Array.isArray(sent) ? sent : [sent]).filter(Boolean).map(normalizeMessage);
}