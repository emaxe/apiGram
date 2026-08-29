import { Api, errors } from "teleproto";
import { resolveEntity, toMarkedId } from "./entities.js";
import { idToString } from "./serialize.js";

const { FloodWaitError } = errors;

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
        entities: message.entities || [],
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
        if (err instanceof FloodWaitError || typeof err?.seconds === "number") {
            const wait = (err.seconds || 5) + 1;
            await new Promise((r) => setTimeout(r, wait * 1000));
            messages.length = 0;
            await load();
        } else {
            throw err;
        }
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
 * Отправка одного файла или альбома.
 * @param {import("teleproto").TelegramClient} client
 * @param {string} rawPeer
 * @param {string|Buffer|Array<string|Buffer>} files
 * @param {object} [opts] { caption, replyTo, forceDocument }
 * @returns {Promise<Array<object>>}
 */
export async function sendFiles(client, rawPeer, files, { caption = "", replyTo, forceDocument = false } = {}) {
    const list = Array.isArray(files) ? files : [files];
    if (list.length === 0) throw new Error("Не указан ни один файл");
    if (list.length > ALBUM_LIMIT) throw new Error(`За раз не больше ${ALBUM_LIMIT} файлов`);
    const entity = await resolveEntity(client, rawPeer);
    const params = { file: list.length === 1 ? list[0] : list, caption, forceDocument };
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
    if (!raw?.media) throw new Error("У сообщения нет медиа");
    const buffer = await client.downloadMedia(raw.media);
    return Buffer.from(buffer || []);
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
        if (maxId > 0) await client.sendReadAcknowledge(entity, { maxId });
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