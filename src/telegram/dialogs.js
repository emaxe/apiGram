import { toMarkedId } from "./entities.js";

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
    if (typeof archived === "boolean") params.archived = archived;
    const dialogs = [];
    for await (const dialog of client.iterDialogs(params)) {
        dialogs.push(normalizeDialog(dialog));
        if (query && dialogs.length >= limit) break;
    }
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