import { Api, errors } from "teleproto";
import { CustomFile } from "teleproto/client/uploads.js";
import { resolveEntity, toMarkedId } from "./entities.js";
import { idToString } from "./serialize.js";
import {
    describeMedia,
    chunkPlan,
    sliceChunks,
    orderedParts,
    pickThumbType,
    rawMediaSizes,
    DOWNLOAD_PART_SIZE,
    DOWNLOAD_INFLIGHT,
} from "./media.js";
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
        chatId: messageChatId(message),
        groupedId: idToString(message.groupedId),
        mediaType: message.media?.className || null,
        media: describeMedia(message.media),
        fwdFrom: normalizeFwdFrom(message.fwdFrom),
        viaBotId: idToString(message.viaBotId),
        senderName: senderNameOf(message),
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
 * Единственная честная привязка сообщения к чату.
 *
 * `peerId` маркирован, `fromId` — нет, и клиент, разбирая их сам, вынужден
 * угадывать тип чата по форме числа. Здесь ответ считается один раз и всегда
 * маркированным.
 *
 * @param {object} message
 * @returns {string|null}
 */
function messageChatId(message) {
    const peer = toMarkedId(message.peerId);
    if (peer) return peer;
    // Пустой peerId бывает только в личке. У входящего чат — это отправитель;
    // у исходящего опереться не на что, и выдумывать чат нельзя.
    if (!message.out && message.fromId) return toMarkedId(message.fromId) || null;
    return null;
}

/**
 * Заголовок пересылки. У отправителя, закрывшего ссылку на свой профиль,
 * остаётся только `fromName` — по нему нельзя перейти в чат, но подписать
 * пузырь надо всё равно.
 * @param {object} [fwdFrom]
 * @returns {object|null}
 */
function normalizeFwdFrom(fwdFrom) {
    if (!fwdFrom) return null;
    return {
        fromId: fwdFrom.fromId ? toMarkedId(fwdFrom.fromId) || null : null,
        fromName: fwdFrom.fromName || null,
        date: fwdFrom.date ? fwdFrom.date * 1000 : null,
        channelPost: fwdFrom.channelPost || null,
        postAuthor: fwdFrom.postAuthor || null,
        savedFromPeer: fwdFrom.savedFromPeer ? toMarkedId(fwdFrom.savedFromPeer) || null : null,
        savedFromMsgId: fwdFrom.savedFromMsgId || null,
        imported: Boolean(fwdFrom.imported),
    };
}

/**
 * Имя отправителя для подписи пузыря.
 *
 * Сущность уже разрешена внутри `getMessages`, поэтому берётся из сообщения:
 * отдельный запрос за именем к каждому сообщению превратил бы страницу
 * истории в сотню обращений к Telegram.
 *
 * @param {object} message
 * @returns {string|null}
 */
function senderNameOf(message) {
    // У подписанного поста канала сущность — сам канал, а человек указан
    // отдельным полем: показывать надо его.
    if (message.postAuthor) return message.postAuthor;
    const sender = message.sender;
    if (!sender) return null;
    if (sender.title) return sender.title;
    const name = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim();
    if (name) return name;
    return sender.username || null;
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
/**
 * Достаёт сообщение вместе с описанием его вложения.
 *
 * Отдельный шаг от самой загрузки: HTTP-слою нужен размер файла раньше, чем
 * первый байт — без него не разобрать `Range` и не выставить `Content-Length`.
 *
 * Проверяется не только наличие медиа, но и то, что за ним стоит файл: у гео,
 * опроса и контакта вложения нет, и уход в загрузку заканчивался бы ожиданием
 * до таймаута вместо честной ошибки.
 *
 * @param {import("teleproto").TelegramClient} client
 * @param {string} rawPeer
 * @param {number} messageId
 * @returns {Promise<{raw: object, info: object}>}
 */
export async function openMedia(client, rawPeer, messageId) {
    const entity = await resolveEntity(client, rawPeer);
    const [raw] = await client.getMessages(entity, { ids: [messageId] });
    if (!raw) throw new ProtocolError("message_not_found", "Сообщение не найдено.");
    const info = describeMedia(raw.media);
    if (!info || !info.downloadable) {
        throw new ProtocolError("no_media", "У сообщения нет файла.");
    }
    return { raw, info };
}

/**
 * Сколько держать описание вложения.
 *
 * Ссылка на файл в Telegram живёт часами, но не вечно, и протухшую отличить
 * нечем, кроме отказа на загрузке. Минуты хватает на просмотр видео целиком со
 * всеми перемотками — а до срока годности ссылки отсюда далеко.
 */
export const MEDIA_INFO_TTL_MS = 2 * 60 * 1000;

/** Сколько описаний помнить на аккаунт. */
const MEDIA_INFO_LIMIT = 64;

/**
 * Оборачивает [openMedia] в кеш с коротким сроком.
 *
 * Плеер шлёт за одно видео десятки запросов — проба, старт, каждая перемотка,
 * — и каждый из них платил бы `getEntity` и `getMessages` ещё до первого
 * байта. Через прокси это сотни миллисекунд на пустом месте, и заметны они
 * ровно там, где заметнее всего: в паузе после нажатия.
 *
 * Кеш заведён отдельной функцией, а не спрятан внутрь `openMedia`: с
 * состоянием на модуле тесты подсматривали бы друг за другом, а вызовы, где
 * свежесть важнее скорости, лишились бы выбора.
 *
 * @param {(client: object, rawPeer: string, messageId: number) => Promise<{raw: object, info: object}>} load
 * @param {{ttlMs?: number, limit?: number, now?: () => number}} [options]
 */
export function createMediaOpener(load, { ttlMs = MEDIA_INFO_TTL_MS, limit = MEDIA_INFO_LIMIT, now = Date.now } = {}) {
    // Ключ — сам клиент: аккаунты не делят ни сессию, ни права, и общая карта
    // означала бы чужое видео в ответ на своё. WeakMap ещё и освобождает
    // записи вместе с отключённым аккаунтом, без всякой уборки.
    const byClient = new WeakMap();

    return async function openCached(client, rawPeer, messageId) {
        let entries = byClient.get(client);
        if (!entries) {
            entries = new Map();
            byClient.set(client, entries);
        }

        const key = `${rawPeer}\u0000${messageId}`;
        const hit = entries.get(key);
        if (hit && hit.until > now()) return hit.opened;

        const opened = await load(client, rawPeer, messageId);
        // Отказ сюда не доходит намеренно: запомнить его значит запереть
        // вложение на весь срок записи — клиент повторяет запрос, а шлюз
        // повторяет отказ, не пытаясь заново.
        entries.delete(key);
        entries.set(key, { opened, until: now() + ttlMs });
        // Map хранит порядок вставки, поэтому первый ключ — самый старый.
        while (entries.size > limit) entries.delete(entries.keys().next().value);
        return opened;
    };
}

/** Описание вложения с кешем — то, чем пользуется маршрут выдачи файла. */
export const openMediaCached = createMediaOpener(openMedia);

/**
 * Поток байтов файла — целиком или запрошенным диапазоном.
 *
 * Файл никогда не собирается в память целиком: видео на 200 МБ — это 200 МБ
 * RSS шлюза, общего для всех аккаунтов. Наружу уходит генератор, который
 * тянет из Telegram ровно столько, сколько успел прочитать клиент.
 *
 * Куски запрашиваются несколькими сразу. Один `upload.getFile` за раз означает
 * простой соединения на всё время обратного пути до дата-центра, и открытие
 * видео упирается в задержку, а не в канал — особенно заметно через прокси.
 *
 * @param {import("teleproto").TelegramClient} client
 * @param {{raw: object, info: object}} opened результат `openMedia`
 * @param {{range?: {start: number, end: number}|null, signal?: AbortSignal, partSize?: number, inflight?: number}} [options]
 * @returns {AsyncGenerator<Buffer>}
 */
export function streamMedia(client, opened, {
    range = null,
    signal = undefined,
    partSize = DOWNLOAD_PART_SIZE,
    inflight = DOWNLOAD_INFLIGHT,
} = {}) {
    const { raw, info } = opened;
    const plan = range
        ? chunkPlan(range.start, range.end, partSize)
        : { offset: 0, skip: 0, length: info.size ?? Number.MAX_SAFE_INTEGER };

    const parts = orderedParts((offset) => fetchPart(client, raw, offset, partSize, signal), {
        offset: plan.offset,
        // Голова первого куска — часть плана загрузки, а не запрошенных байт:
        // она выкачивается, но наружу не идёт.
        length: plan.skip + plan.length,
        partSize,
        inflight,
    });
    return sliceChunks(parts, plan.skip, plan.length);
}

/**
 * Один кусок файла — ровно один `upload.getFile` под капотом.
 *
 * `limit` и `requestSize` совпадают намеренно: так `iterDownload` делает один
 * запрос и заканчивается, а очередь кусков остаётся целиком нашей. Без `limit`
 * он продолжил бы качать файл до конца, и параллельные куски перекрыли бы
 * друг друга.
 *
 * @param {import("teleproto").TelegramClient} client
 * @param {object} raw сообщение с вложением
 * @param {number} offset смещение, выровненное по правилам `chunkPlan`
 * @param {number} partSize сколько байт просить
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<Buffer>}
 */
async function fetchPart(client, raw, offset, partSize, signal) {
    const chunks = [];
    for await (const chunk of client.iterDownload(raw, {
        offset,
        limit: partSize,
        requestSize: partSize,
        signal,
    })) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}

/**
 * Качает превью сообщения.
 *
 * В отличие от файла, обрезка собирается в память целиком: она весит
 * килобайты, а поток ради них — лишняя сложность на самом частом запросе.
 *
 * `ifNoneMatch` проверяется до обращения к Telegram за файлом: смысл метки не
 * только в сэкономленном ответе клиенту, но и в несделанной загрузке.
 *
 * @param {import("teleproto").TelegramClient} client
 * @param {string} rawPeer
 * @param {number} messageId
 * @param {string} want "s" | "m"
 * @param {{ifNoneMatch?: string}} [options]
 * @returns {Promise<{etag: string, mimeType: string, buffer: Buffer|null, notModified: boolean}>}
 */
export async function downloadThumb(client, rawPeer, messageId, want, { ifNoneMatch } = {}) {
    const { raw, info } = await openMedia(client, rawPeer, messageId);
    const type = pickThumbType(info.thumbs, want);
    // Обрезки нет — выдумывать её нечем. Клиенту в этом случае остаётся
    // размытая заглушка из `stripped`, которая уже приехала в сообщении.
    if (!type) throw new ProtocolError("no_thumb", "У вложения нет превью.");

    // Проверка «такой размер у вложения действительно есть»: сам объект в
    // загрузку не уходит — см. ниже, почему.
    const size = rawMediaSizes(raw.media).find((s) => s?.type === type);
    if (!size) throw new ProtocolError("no_thumb", "У вложения нет превью.");

    // Идентификатор файла в Telegram неизменен, поэтому метка сильная:
    // отредактированное сообщение получает новый файл и новую метку само.
    const fileId = idToString(raw.media?.photo?.id ?? raw.media?.document?.id) || String(messageId);
    const etag = `"${fileId}-${type}"`;
    if (ifNoneMatch && ifNoneMatch === etag) {
        return { etag, mimeType: "image/jpeg", buffer: null, notModified: true };
    }

    // Размер передаётся строкой типа, а не TL-объектом. Объектная ветка
    // `getThumb` в teleproto знает только PhotoSize, PhotoCachedSize,
    // PhotoStrippedSize и VideoSize; PhotoSizeProgressive — а это самый
    // крупный размер у любого современного фото — не распознаётся, и загрузка
    // молча возвращает нулевой буфер. Строковая ветка ищет размер по `type` и
    // прогрессивный обрабатывает правильно.
    const buffer = Buffer.from((await client.downloadMedia(raw, { thumb: type })) || []);
    // Пустой ответ — это не превью. Отдать его двухсоткой значит выдать
    // поломку за картинку: клиент не отличит её от «превью просто нет», а
    // маршрут накроет пустоту недельным immutable-кешем.
    if (buffer.length === 0) throw new ProtocolError("no_thumb", "Превью не загрузилось.");

    return {
        etag,
        mimeType: "image/jpeg",
        buffer,
        notModified: false,
    };
}
