import { getPeerId } from "teleproto/Utils.js";
import { idToString } from "./serialize.js";
import { ProtocolError } from "./errors.js";

/**
 * Приводит пир к "маркированному" строковому ID, как его отдаёт teleproto для
 * диалогов: пользователь -> "123", группа -> "-456", канал -> "-100789".
 * @param {unknown} peer
 * @returns {string}
 */
export function toMarkedId(peer) {
    if (peer === null || peer === undefined) return "";
    try {
        const id = getPeerId(peer);
        if (id !== null && id !== undefined && id !== "") return String(id);
    } catch {
        // не Peer-объект — падаем на строковое представление
    }
    return idToString(peer);
}

/**
 * Преобразует пользовательский ввод в формат MTProto.
 * @param {string} raw "@username" | "username" | "-1001234567890" | "me"
 * @returns {string|bigint}
 */
export function parsePeer(raw) {
    const value = String(raw || "").trim();
    if (!value) throw new ProtocolError("peer_required", "Не указан идентификатор чата (peer).");
    if (value === "me" || value === "self") return "me";
    // Числовой ID отдаём BigInt: ID каналов и супергрупп давно вышли за 2^53,
    // и обычный Number терял бы последние цифры.
    if (/^-?\d+$/.test(value)) {
        return BigInt(value);
    }
    // Собачку добавляем сами: getEntity отличает username от строкового ID
    // именно по ней, и без префикса «durov» ушёл бы резолвиться как ID.
    return value.startsWith("@") ? value : `@${value}`;
}

/**
 * Разрешает сущность чата по строковому представлению.
 * @param {import("teleproto").TelegramClient} client
 * @param {string} rawPeer
 * @returns {Promise<object>}
 */
export async function resolveEntity(client, rawPeer) {
    const peer = parsePeer(rawPeer);
    try {
        return await client.getEntity(peer);
    } catch (err) {
        const msg = String(err?.errorMessage || err?.message || err);
        if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|USER_BANNED_IN_CHANNEL/i.test(msg)) {
            throw new ProtocolError(
                "peer_forbidden",
                `Нет доступа к ${rawPeer}: чат приватный или аккаунт в нём не состоит.`,
                { cause: err }
            );
        }
        if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|PEER_ID_INVALID|Cannot find any entity|Could not find the input entity/i.test(msg)) {
            throw new ProtocolError("peer_not_found", `Чат ${rawPeer} не найден.`, {
                hint: "Для чатов по числовому ID сначала загрузите список диалогов: GET /v1/accounts/:id/dialogs",
                cause: err,
            });
        }
        throw err;
    }
}
