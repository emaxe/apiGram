/**
 * Подписка на поток обновлений Telegram и трансляция их в канал аккаунта.
 *
 * Всё, что здесь испускается, уходит подписчикам как есть — в WebSocket и в
 * updates-лог. Поэтому события нормализуются сразу: наружу не должны попадать
 * ни TL-классы, ни BigInt.
 */
import { Api } from "teleproto";
import { NewMessage, EditedMessage, DeletedMessage, Raw } from "teleproto/events/index.js";
import { normalizeMessage } from "./messages.js";
import { toMarkedId } from "./entities.js";
import { idToString } from "./serialize.js";

/**
 * Достаёт ID чата из сырого апдейта. Поле зависит от типа: у одних `peer`,
 * у других только `channelId`/`chatId`, из которых peer надо собрать вручную.
 * @returns {string} marked id либо пустая строка, если чат определить не удалось
 */
function updateChatId(update) {
    if (update.peer) return toMarkedId(update.peer);
    if (update.channelId) return toMarkedId(new Api.PeerChannel({ channelId: update.channelId }));
    if (update.chatId) return toMarkedId(new Api.PeerChat({ chatId: update.chatId }));
    return "";
}

/**
 * Запускает фоновое прослушивание событий Telegram для аккаунта
 * и транслирует их в канал аккаунта (EventEmitter из sessionManager).
 * @param {import("teleproto").TelegramClient} client
 * @param {import("node:events").EventEmitter} channel
 * @returns {() => void} функция остановки
 */
export function startAccountListener(client, channel) {
    // Копим ссылки на обработчики: снять их можно только по той же ссылке,
    // а без снятия повторный логин навесил бы второй комплект на тот же клиент.
    const handlers = [];
    const on = (handler, evt) => { client.addEventHandler(handler, evt); handlers.push(handler); };

    on(async (event) => {
        const msg = event.message;
        if (!msg) return;
        const normalized = normalizeMessage(msg);
        channel.emit("account_event", { accountEvent: true, type: "new_message", message: normalized });
    }, new NewMessage({}));

    on(async (event) => {
        const msg = event.message;
        if (!msg) return;
        channel.emit("account_event", { accountEvent: true, type: "edited_message", message: normalizeMessage(msg) });
    }, new EditedMessage({}));

    on(async (event) => {
        channel.emit("account_event", {
            accountEvent: true,
            type: "deleted_messages",
            peerId: toMarkedId(event.chatId),
            deletedIds: event.deletedIds || [],
        });
    }, new DeletedMessage({}));

    // Набора и отметок о прочтении нет среди типизированных событий teleproto —
    // ловим их из сырого потока по className.
    on(async (update) => {
        const className = update?.className;
        if (!className) return;
        if (className === "UpdateUserTyping" || className === "UpdateChatUserTyping" || className === "UpdateChannelUserTyping") {
            channel.emit("account_event", {
                accountEvent: true,
                type: "typing",
                // В личке чата как такового нет — идентификатором служит сам собеседник.
                chatId: updateChatId(update) || idToString(update.userId || update.fromId?.userId),
                userId: idToString(update.userId || update.fromId?.userId),
                action: update.action?.className || "SendMessageTypingAction",
            });
        } else if (className === "UpdateReadHistoryInbox" || className === "UpdateReadChannelInbox") {
            channel.emit("account_event", {
                accountEvent: true,
                type: "read_inbox",
                peerId: updateChatId(update),
                maxId: update.maxId,
            });
        }
    }, new Raw({}));

    return () => {
        for (const handler of handlers) {
            // Клиент мог быть уже уничтожен — снятие обработчика тогда бросает,
            // и это нормальный путь при остановке.
            try { client.removeEventHandler(handler); } catch { /* ignore */ }
        }
    };
}
