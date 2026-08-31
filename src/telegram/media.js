/**
 * Описание медиа сообщения.
 *
 * Клиент должен решить две вещи ещё до того, как получит хоть один байт файла:
 * какого размера нарисовать заглушку и стоит ли вообще качать вложение. Оба
 * ответа лежат в сыром TL-объекте, но добираться до них приходится через
 * атрибуты, у которых приоритет не совпадает с порядком в массиве.
 *
 * Всё, что отсюда выходит, обязано быть JSON-safe: буферы разворачиваются в
 * base64, `long` — в число. Через `toPlain` описание не проходит, потому что
 * оно уходит внутрь уже нормализованного сообщения.
 */

// Медиа, за которым нет файла: гео, контакт, опрос. Кнопка «скачать» у такого
// пузыря — это 404 по нажатию, поэтому признак считается здесь, а не на клиенте.
const KIND_BY_CLASS = {
    MessageMediaGeo: "geo",
    MessageMediaGeoLive: "geo",
    MessageMediaVenue: "venue",
    MessageMediaContact: "contact",
    MessageMediaPoll: "poll",
    MessageMediaDice: "dice",
    MessageMediaWebPage: "webpage",
    MessageMediaGame: "game",
    MessageMediaInvoice: "invoice",
    MessageMediaStory: "story",
};

/**
 * Приводит `long`/BigInteger/строку к числу. Размеры файлов и длительности
 * до 2^53 доходят без потерь, а объект в этих полях ломает и JSON, и клиент.
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "bigint") return Number(value);
    const n = Number(String(value));
    return Number.isFinite(n) ? n : null;
}

/**
 * Байты из TL-поля в base64. Буфер и Uint8Array приходят вперемешку.
 * @param {unknown} value
 * @returns {string|null}
 */
function toBase64(value) {
    if (!value) return null;
    if (Buffer.isBuffer(value)) return value.toString("base64");
    if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
    // Уже сериализованный буфер (через toPlain) — отдаём его base64 как есть.
    if (typeof value === "object" && typeof value.base64 === "string") return value.base64;
    return null;
}

/**
 * Разворачивает waveform голосового сообщения: Telegram пакует амплитуды по
 * 5 бит подряд, без выравнивания по байтам. Клиенту нужен массив 0…31, и
 * распаковывать его на каждой платформе заново — лишняя копия одной и той же
 * ошибки.
 * @param {unknown} raw
 * @returns {number[]|null}
 */
function decodeWaveform(raw) {
    let bytes = null;
    if (Buffer.isBuffer(raw)) bytes = raw;
    else if (raw instanceof Uint8Array) bytes = Buffer.from(raw);
    else if (raw && typeof raw === "object" && typeof raw.base64 === "string") {
        bytes = Buffer.from(raw.base64, "base64");
    }
    if (!bytes || bytes.length === 0) return null;

    const samples = Math.floor((bytes.length * 8) / 5);
    const out = new Array(samples);
    for (let i = 0; i < samples; i++) {
        const bit = i * 5;
        const byte = bit >> 3;
        const shift = bit & 7;
        let value = bytes[byte] >> shift;
        // Отсчёт может пересекать границу байта — добираем старшие биты.
        if (shift > 3 && byte + 1 < bytes.length) value |= bytes[byte + 1] << (8 - shift);
        out[i] = value & 0x1f;
    }
    return out;
}

/**
 * Вес фотографии заданного размера. У прогрессивного размера вес — последний
 * элемент `sizes`: массив описывает границы качества, а не список файлов.
 * @param {object} size
 * @returns {number|null}
 */
function photoSizeBytes(size) {
    if (Array.isArray(size.sizes) && size.sizes.length) {
        return toNumber(size.sizes[size.sizes.length - 1]);
    }
    if (size.bytes) {
        const base64 = toBase64(size.bytes);
        return base64 ? Buffer.from(base64, "base64").length : null;
    }
    return toNumber(size.size);
}

/**
 * Делит набор размеров на скачиваемые обрезки и инлайн-превью.
 *
 * `PhotoStrippedSize` и `PhotoPathSize` приходят прямо в сообщении и весят
 * десятки байт — это единственное, что можно показать мгновенно, ещё до
 * запроса к шлюзу. Остальные размеры надо качать, и они попадают в `thumbs`.
 *
 * @param {object[]} [sizes]
 * @returns {{thumbs: object[], stripped: string|null}}
 */
function splitSizes(sizes) {
    const thumbs = [];
    let stripped = null;
    for (const size of Array.isArray(sizes) ? sizes : []) {
        if (!size || typeof size !== "object") continue;
        const className = size.className || "";
        if (className === "PhotoStrippedSize" || className === "PhotoPathSize") {
            stripped = stripped || toBase64(size.bytes);
            continue;
        }
        if (className === "PhotoSizeEmpty") continue;
        const width = toNumber(size.w);
        const height = toNumber(size.h);
        if (width === null || height === null) continue;
        thumbs.push({ type: size.type || "", width, height, size: photoSizeBytes(size) });
    }
    thumbs.sort((a, b) => a.width * a.height - b.width * b.height);
    return { thumbs, stripped };
}

/**
 * Ищет атрибут документа по имени класса.
 * @param {object[]} attributes
 * @param {string} className
 * @returns {object|undefined}
 */
function attr(attributes, className) {
    return attributes.find((a) => a?.className === className);
}

/**
 * Пустое описание с полным набором полей.
 *
 * Форма ответа одинакова для любого вида медиа намеренно: клиент разбирает
 * один DTO, а не десяток вариантов, и отсутствующее поле — это `null`, а не
 * отсутствующий ключ.
 * @param {string} kind
 * @returns {object}
 */
function blank(kind) {
    return {
        kind,
        mimeType: null,
        fileName: null,
        size: null,
        width: null,
        height: null,
        duration: null,
        waveform: null,
        title: null,
        performer: null,
        emoji: null,
        isAnimated: false,
        supportsStreaming: false,
        spoiler: false,
        downloadable: false,
        thumbs: [],
        stripped: null,
    };
}

/**
 * Описывает медиа документа: тип определяется атрибутами, а не mime-типом.
 * @param {object} media
 * @param {object} out
 */
function describeDocument(media, out) {
    const document = media.document || {};
    const attributes = Array.isArray(document.attributes) ? document.attributes : [];

    out.mimeType = document.mimeType || null;
    out.size = toNumber(document.size);
    out.fileName = attr(attributes, "DocumentAttributeFilename")?.fileName || null;

    const sticker = attr(attributes, "DocumentAttributeSticker") || attr(attributes, "DocumentAttributeCustomEmoji");
    const animated = attr(attributes, "DocumentAttributeAnimated");
    const audio = attr(attributes, "DocumentAttributeAudio");
    const video = attr(attributes, "DocumentAttributeVideo");
    const image = attr(attributes, "DocumentAttributeImageSize");

    if (video) {
        out.duration = toNumber(video.duration);
        out.width = toNumber(video.w);
        out.height = toNumber(video.h);
        out.supportsStreaming = Boolean(video.supportsStreaming);
    } else if (image) {
        out.width = toNumber(image.w);
        out.height = toNumber(image.h);
    }
    if (audio) {
        out.duration = toNumber(audio.duration);
        out.title = audio.title || null;
        out.performer = audio.performer || null;
        out.waveform = decodeWaveform(audio.waveform);
    }

    // Порядок проверок — не стилистика. Видеостикер несёт и Video, и Sticker;
    // «гифка» приходит как video/mp4 и от обычного видео отличается только
    // атрибутом Animated. Ошибка в приоритете рисует плеер там, где должен
    // быть стикер.
    if (sticker) {
        out.kind = "sticker";
        out.emoji = sticker.alt || null;
        out.isAnimated = Boolean(animated) || out.mimeType === "application/x-tgsticker" || out.mimeType === "video/webm";
    } else if (animated) {
        out.kind = "gif";
        out.isAnimated = true;
    } else if (audio?.voice || media.voice) {
        out.kind = "voice";
    } else if (audio) {
        out.kind = "audio";
    } else if (video?.roundMessage || media.round) {
        out.kind = "round";
    } else if (video) {
        out.kind = "video";
    } else {
        out.kind = "document";
    }

    const { thumbs, stripped } = splitSizes(document.thumbs);
    out.thumbs = thumbs;
    out.stripped = stripped;
}

/**
 * Разбирает сырое медиа сообщения в описание для клиента.
 *
 * Возвращает `null`, если медиа нет вовсе: `MessageMediaEmpty` — это не
 * вложение, а признак его отсутствия.
 *
 * @param {object|null|undefined} media сырое `message.media`
 * @returns {object|null}
 */
export function describeMedia(media) {
    const className = media?.className;
    if (!className || className === "MessageMediaEmpty") return null;

    if (className === "MessageMediaPhoto") {
        const out = blank("photo");
        out.downloadable = true;
        out.spoiler = Boolean(media.spoiler);
        const { thumbs, stripped } = splitSizes(media.photo?.sizes);
        out.thumbs = thumbs;
        out.stripped = stripped;
        // Оригинал — самый большой из размеров: отдельного «полного» файла у
        // фотографии нет, есть только набор её версий.
        const largest = thumbs[thumbs.length - 1];
        if (largest) {
            out.width = largest.width;
            out.height = largest.height;
            out.size = largest.size;
        }
        return out;
    }

    if (className === "MessageMediaDocument") {
        const out = blank("document");
        out.downloadable = true;
        out.spoiler = Boolean(media.spoiler);
        describeDocument(media, out);
        return out;
    }

    // Всё остальное файла за собой не тянет. Незнакомый класс доезжает
    // заглушкой: новые типы медиа появляются раньше их поддержки, и падать
    // на них — значит терять весь чат из-за одного сообщения.
    return blank(KIND_BY_CLASS[className] || "unsupported");
}

// upload.getFile принимает только выровненное смещение. 4096 — тот же шаг, что
// у запрашиваемых чанков, поэтому выравнивание никогда не удлиняет загрузку
// больше чем на один лишний участок в начале.
const DOWNLOAD_ALIGN = 4096;

/** Сколько загрузок одного аккаунта шлюз тянет одновременно. */
export const DOWNLOADS_PER_ACCOUNT = 2;

/**
 * План загрузки под запрошенный диапазон байтов.
 *
 * Telegram отдаёт файл только с выровненного смещения, а клиент просит
 * произвольное. Разницу («голову») отбрасываем уже у себя.
 *
 * @param {number} start первый нужный байт
 * @param {number} end последний нужный байт, включительно
 * @returns {{offset: number, skip: number, length: number}}
 */
export function chunkPlan(start, end) {
    const offset = Math.floor(start / DOWNLOAD_ALIGN) * DOWNLOAD_ALIGN;
    return { offset, skip: start - offset, length: end - start + 1 };
}

/**
 * Отдаёт из потока чанков ровно `length` байт, пропустив первые `skip`.
 *
 * Генератор обрывается, как только длина набрана: продолжать тянуть чанки
 * значит качать из Telegram то, что уже никому не нужно — а платит за это
 * канал шлюза, общий для всех аккаунтов.
 *
 * @param {AsyncIterable<Buffer>} chunks
 * @param {number} skip
 * @param {number} length
 * @returns {AsyncGenerator<Buffer>}
 */
export async function* sliceChunks(chunks, skip, length) {
    let toSkip = skip;
    let left = length;
    if (left <= 0) return;
    for await (const raw of chunks) {
        let chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (toSkip > 0) {
            if (chunk.length <= toSkip) {
                toSkip -= chunk.length;
                continue;
            }
            chunk = chunk.subarray(toSkip);
            toSkip = 0;
        }
        if (chunk.length > left) chunk = chunk.subarray(0, left);
        left -= chunk.length;
        if (chunk.length) yield chunk;
        if (left <= 0) return;
    }
}

/**
 * Счётчик одновременных загрузок с очередью, отдельной на каждый аккаунт.
 *
 * Без него один клиент, открывший чат с десятком видео, занимает всю память и
 * весь канал шлюза — остальные аккаунты при этом просто перестают получать
 * файлы, без единой ошибки в логе.
 *
 * @param {number} [limit]
 * @returns {{acquire: (accountId: string) => Promise<() => void>}}
 */
export function createDownloadGate(limit = DOWNLOADS_PER_ACCOUNT) {
    /** @type {Map<string, {active: number, queue: (() => void)[]}>} */
    const lanes = new Map();

    const laneOf = (accountId) => {
        let lane = lanes.get(accountId);
        if (!lane) {
            lane = { active: 0, queue: [] };
            lanes.set(accountId, lane);
        }
        return lane;
    };

    const release = (accountId) => {
        const lane = laneOf(accountId);
        const next = lane.queue.shift();
        if (next) return next();
        lane.active -= 1;
        // Пустую дорожку выбрасываем: аккаунтов за время жизни процесса
        // проходит много, а карта иначе растёт вечно.
        if (lane.active <= 0 && lane.queue.length === 0) lanes.delete(accountId);
    };

    return {
        async acquire(accountId) {
            const lane = laneOf(accountId);
            if (lane.active < limit) {
                lane.active += 1;
            } else {
                await new Promise((resolve) => lane.queue.push(resolve));
            }
            // Повторный вызов release ничего не открывает: иначе прерванная
            // и потом закрытая загрузка выдала бы два места вместо одного.
            let released = false;
            return () => {
                if (released) return;
                released = true;
                release(accountId);
            };
        },
    };
}

/**
 * Выбирает обрезку под запрошенный размер.
 *
 * `s` — самая мелкая: списку диалогов важен вес, а не детали. `m` — самая
 * крупная из доступных обрезок: пузырь в чате не должен быть мыльным.
 *
 * @param {{type: string, width: number, height: number}[]} [thumbs]
 * @param {string} want "s" | "m"
 * @returns {string|null} тип обрезки для thumbSize
 */
export function pickThumbType(thumbs, want) {
    const list = Array.isArray(thumbs) ? thumbs.filter((t) => t && t.type) : [];
    if (list.length === 0) return null;
    return want === "s" ? list[0].type : list[list.length - 1].type;
}

/**
 * Сырые размеры медиа — там, где нужен не разбор, а сам TL-объект обрезки:
 * `downloadMedia` принимает именно его, а не тип строкой.
 * @param {object} media
 * @returns {object[]}
 */
export function rawMediaSizes(media) {
    if (media?.className === "MessageMediaPhoto") {
        return Array.isArray(media.photo?.sizes) ? media.photo.sizes : [];
    }
    if (media?.className === "MessageMediaDocument") {
        return Array.isArray(media.document?.thumbs) ? media.document.thumbs : [];
    }
    return [];
}
