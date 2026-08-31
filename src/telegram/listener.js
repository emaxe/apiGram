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
 * Превращает сырой апдейт MTProto в событие аккаунта.
 *
 * Вынесено из обработчика намеренно: это единственная нетривиальная логика во
 * всём слушателе, и проверить её иначе можно было бы только с живым
 * подключением к Telegram.
 *
 * @param {object} update
 * @returns {object|null} событие для канала аккаунта либо null
 */
export function classifyRawUpdate(update) {
    const className = update?.className;
    if (!className) return null;

    if (className === "UpdateUserTyping" || className === "UpdateChatUserTyping" || className === "UpdateChannelUserTyping") {
        return {
            accountEvent: true,
            type: "typing",
            // В личке чата как такового нет — идентификатором служит сам собеседник.
            chatId: updateChatId(update) || idToString(update.userId || update.fromId?.userId),
            userId: idToString(update.userId || update.fromId?.userId),
            action: update.action?.className || "SendMessageTypingAction",
        };
    }
    // Мы прочитали чужие сообщения — возможно, на другом устройстве.
    if (className === "UpdateReadHistoryInbox" || className === "UpdateReadChannelInbox") {
        return {
            accountEvent: true,
            type: "read_inbox",
            peerId: updateChatId(update),
            maxId: update.maxId,
        };
    }
    // Собеседник прочитал наши сообщения. Без этого события клиент не может
    // честно нарисовать вторую галочку: отличить «доставлено» от «прочитано»
    // больше неоткуда.
    if (className === "UpdateReadHistoryOutbox" || className === "UpdateReadChannelOutbox") {
        return {
            accountEvent: true,
            type: "read_outbox",
            peerId: updateChatId(update),
            maxId: update.maxId,
        };
    }
    return null;
}

/**
 * Событие удаления сообщений.
 *
 * Вынесено из обработчика по той же причине, что и `classifyRawUpdate`:
 * маркировка `peerId` здесь зависит от версии teleproto, а расходится она
 * молча — клиент просто перестаёт находить чат и не удаляет ничего.
 *
 * @param {object} event DeletedMessageEvent
 * @returns {object} событие для канала аккаунта
 */
export function deletedMessagesEvent(event) {
    return {
        accountEvent: true,
        type: "deleted_messages",
        // Для личек и малых групп Telegram чат не сообщает вовсе — там
        // идентификаторы сообщений глобально уникальны. Пустая строка честнее
        // подставленного наугад чата.
        peerId: toMarkedId(event.chatId),
        deletedIds: event.deletedIds || [],
    };
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
        channel.emit("account_event", deletedMessagesEvent(event));
    }, new DeletedMessage({}));

    // Набора и отметок о прочтении нет среди типизированных событий teleproto —
    // ловим их из сырого потока по className.
    on(async (update) => {
        const event = classifyRawUpdate(update);
        if (event) channel.emit("account_event", event);
    }, new Raw({}));

    return () => {
        for (const handler of handlers) {
            // Клиент мог быть уже уничтожен — снятие обработчика тогда бросает,
            // и это нормальный путь при остановке.
            try { client.removeEventHandler(handler); } catch { /* ignore */ }
        }
    };
}
