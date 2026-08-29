import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { Logger, LogLevel } from "teleproto/extensions/Logger.js";
import { config } from "../config.js";

/**
 * Создаёт экземпляр MTProto-клиента для аккаунта.
 * @param {string} sessionString
 * @returns {import("teleproto").TelegramClient}
 */
export function buildClient(sessionString) {
    config.assertCredentials();
    return new TelegramClient(
        new StringSession(sessionString || ""),
        config.apiId,
        config.apiHash,
        {
            connectionRetries: 5,
            autoReconnect: true,
            retryDelay: 1000,
            baseLogger: new Logger(LogLevel.ERROR),
            useWSS: false,
        }
    );
}

/** @returns {{ apiId: number, apiHash: string }} */
export function apiCredentials() {
    config.assertCredentials();
    return { apiId: config.apiId, apiHash: config.apiHash };
}
