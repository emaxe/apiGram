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

function detectType(dialog, entity) {
    if (dialog.isUser || entity.className === "User") return entity.bot ? "bot" : "user";
    if (dialog.isChannel || entity.className === "Channel") return entity.broadcast ? "channel" : "supergroup";
    if (dialog.isGroup || entity.className === "Chat") return entity.megagroup ? "supergroup" : "group";
    return "unknown";
}

/**
 * Список диалогов.
 * @param {import("teleproto").TelegramClient} client
 * @param {object} [opts] { limit=100, archived, query }
 * @returns {Promise<Array<object>>}
 */
export async function fetchDialogs(client, { limit = 100, archived, query } = {}) {
    const params = { limit };
    // Только явный boolean: undefined означает «и активные, и архивные».
    if (typeof archived === "boolean") params.archived = archived;
    const dialogs = [];
    // Побочный, но важный эффект обхода: заодно прогревается кэш сущностей,
    // без которого чаты по числовому ID не резолвятся после рестарта.
    for await (const dialog of client.iterDialogs(params)) {
        dialogs.push(normalizeDialog(dialog));
        if (query && dialogs.length >= limit) break;
    }
    // Поиска по диалогам в TL нет — фильтруем уже загруженную страницу.
    // Значит query ищет в пределах limit, а не по всему списку чатов.
    if (query) {
        const q = String(query).toLowerCase();
        return dialogs.filter((d) =>
            (d.title && d.title.toLowerCase().includes(q)) ||
            (d.username && d.username.toLowerCase().includes(q)) ||
            d.id.includes(q)
        );
    }
    return dialogs;
}