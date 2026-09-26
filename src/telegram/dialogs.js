import { resolveEntity, toMarkedId } from "./entities.js";
import { idToString } from "./serialize.js";

/**
 * Нормализует диалог.
 * @param {object} dialog
 * @returns {object}
 */
export function normalizeDialog(dialog) {
    const entity = dialog.entity || {};
    const message = dialog.message;
    const type = detectType(dialog, entity);
    const title = (entity.title) ||
        [entity.firstName, entity.lastName].filter(Boolean).join(" ") ||
        (entity.username ? `@${entity.username}` : "Чат");
    return {
        id: toMarkedId(dialog.id),
        type,
        title,
        username: entity.username || null,
        pinned: Boolean(dialog.pinned),
        archived: Boolean(dialog.archived),
        unreadCount: dialog.unreadCount || 0,
        // Границы прочитанного: докуда прочитаны чужие сообщения (inbox) и
        // докуда собеседник прочитал наши (outbox). Обращение именно к
        // `dialog.dialog`: кастомная обёртка teleproto поднимает наверх только
        // `unreadCount`, а границы остаются в сыром TL-объекте. Данные уже
        // приехали в ответе `messages.getDialogs` — лишнего запроса нет.
        //
        // Без них клиент узнаёт о прочтении только из события `read_outbox`, а
        // оно приходит однократно: пропустил — и вторую галочку нарисовать уже
        // нечем до конца жизни переписки.
        readInboxMaxId: dialog.dialog?.readInboxMaxId ?? 0,
        readOutboxMaxId: dialog.dialog?.readOutboxMaxId ?? 0,
        date: (message?.date ? message.date * 1000 : dialog.date ? dialog.date * 1000 : Date.now()),
        lastMessage: message ? {
            id: message.id,
            date: message.date ? message.date * 1000 : Date.now(),
            text: message.message || "",
            out: Boolean(message.out),
            mediaType: message.media?.className || null,
        } : null,
        canPost: canPost(entity),
        participantsCount: entity.participantsCount ?? null,
        forum: Boolean(entity.forum),
        noforwards: Boolean(entity.noforwards),
    };
}

/**
 * Информация о чате/пользователе по его идентификатору.
 * @param {import("teleproto").TelegramClient} client
 * @param {string} rawPeer
 * @returns {Promise<object>}
 */
export async function fetchChat(client, rawPeer) {
    const entity = await resolveEntity(client, rawPeer);
    return {
        id: toMarkedId(entity),
        rawId: idToString(entity.id),
        type: detectType({}, entity),
        className: entity.className || null,
        title: entity.title ||
            [entity.firstName, entity.lastName].filter(Boolean).join(" ") ||
            (entity.username ? `@${entity.username}` : ""),
        username: entity.username || null,
        phone: entity.phone || null,
        bot: Boolean(entity.bot),
        verified: Boolean(entity.verified),
        scam: Boolean(entity.scam),
        participantsCount: entity.participantsCount ?? null,
        status: entity.status?.className || null,
    };
}

/**
 * Может ли аккаунт писать в этот чат. Упрощение: учитывает только права
 * администратора/создателя и дефолтные ограничения чата, но не персональный
 * `bannedRights` конкретного участника — тот в ответе `getDialogs` не приходит.
 * @param {object} entity
 * @returns {boolean}
 */
function canPost(entity) {
    if (!entity) return false;
    if (entity.className === "Channel" && entity.broadcast) {
        return Boolean(entity.creator) || Boolean(entity.adminRights?.postMessages);
    }
    if (entity.className === "User") return true;
    return Boolean(entity.creator) || Boolean(entity.adminRights) || !entity.defaultBannedRights?.sendMessages;
}

function detectType(dialog, entity) {
    if (dialog.isUser || entity.className === "User") return entity.bot ? "bot" : "user";
    if (dialog.isChannel || entity.className === "Channel") return entity.broadcast ? "channel" : "supergroup";
    if (dialog.isGroup || entity.className === "Chat") return entity.megagroup ? "supergroup" : "group";
    return "unknown";
}

/**
 * Список диалогов с постраничной загрузкой и защитой от FloodWait.
 * @param {import("teleproto").TelegramClient} client
 * @param {object} [opts] { limit=100, archived, query, offsetDate, offsetId, offsetPeer }
 * @returns {Promise<{ dialogs: Array<object>, next: { offsetDate: number, offsetId: number, offsetPeer: string }|null }>}
 */
export async function fetchDialogs(client, {
    limit = 100,
    archived,
    query,
    offsetDate = 0,
    offsetId = 0,
    offsetPeer,
} = {}) {
    const params = { limit };
    // Только явный boolean: undefined означает «и активные, и архивные».
    if (typeof archived === "boolean") params.archived = archived;
    if (offsetId) params.offsetId = offsetId;
    // TL ждёт секунды, клиенту наружу отдаём миллисекунды — как и везде в API.
    if (offsetDate) params.offsetDate = Math.floor(offsetDate / 1000);
    if (offsetPeer) params.offsetPeer = await resolveEntity(client, offsetPeer);

    const raw = [];
    const load = async () => {
        // Побочный, но важный эффект обхода: заодно прогревается кэш
        // сущностей, без которого чаты по числовому ID не резолвятся после
        // рестарта.
        for await (const dialog of client.iterDialogs(params)) raw.push(dialog);
    };
    try {
        await load();
    } catch (err) {
        const isFlood = typeof err?.seconds === "number" || err?.errorMessage?.includes?.("FLOOD_WAIT");
        if (!isFlood || (err.seconds || 0) > 30) throw err;
        const wait = (err.seconds || 5) + 1;
        await new Promise((r) => setTimeout(r, wait * 1000));
        raw.length = 0;
        await load();
    }

    const dialogs = raw.map(normalizeDialog);
    const next = raw.length === limit
        ? { offsetDate: dialogs[dialogs.length - 1].date, offsetId: raw[raw.length - 1].message?.id || 0, offsetPeer: dialogs[dialogs.length - 1].id }
        : null;

    // Поиска по диалогам в TL нет — фильтруем уже загруженную страницу.
    // Значит query ищет в пределах limit, а не по всему списку чатов.
    if (query) {
        const q = String(query).toLowerCase();
        return {
            dialogs: dialogs.filter((d) =>
                (d.title && d.title.toLowerCase().includes(q)) ||
                (d.username && d.username.toLowerCase().includes(q)) ||
                d.id.includes(q)
            ),
            next,
        };
    }
    return { dialogs, next };
}