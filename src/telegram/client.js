/**
 * Фабрика MTProto-клиентов. Ничего не кэширует и не хранит: жизненным циклом
 * клиентов управляет sessionManager, сюда обращаются только через него.
 */
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { Logger, LogLevel } from "teleproto/extensions/Logger.js";
import { config } from "../config.js";

/**
 * Создаёт экземпляр MTProto-клиента для аккаунта.
 * @param {string} sessionString пустая строка — новый, ещё не авторизованный клиент
 * @returns {import("teleproto").TelegramClient}
 */
export function buildClient(sessionString) {
    config.assertCredentials();
    // StringSession вместо файловой: сессия хранится в реестре аккаунтов одной
    // строкой. Обратная сторона — нет кэша сущностей, и после рестарта чат по
    // числовому ID может не резолвиться, пока не позвали dialogs.
    return new TelegramClient(
        new StringSession(sessionString || ""),
        config.apiId,
        config.apiHash,
        {
            connectionRetries: 5,
            autoReconnect: true,
            retryDelay: 1000,
            // По умолчанию teleproto сыплет в stdout debug-логом протокола,
            // включая содержимое апдейтов. Оставляем только ошибки.
            baseLogger: new Logger(LogLevel.ERROR),
            // Обычный TCP: WSS нужен только в браузере и лишь добавляет накладные расходы.
            useWSS: false,
        }
    );
}

/** @returns {{ apiId: number, apiHash: string }} */
export function apiCredentials() {
    config.assertCredentials();
    return { apiId: config.apiId, apiHash: config.apiHash };
}
