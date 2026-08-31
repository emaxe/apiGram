/**
 * Фабрика MTProto-клиентов. Ничего не кэширует и не хранит: жизненным циклом
 * клиентов управляет sessionManager, сюда обращаются только через него.
 */
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { Logger, LogLevel } from "teleproto/extensions/Logger.js";
import { config } from "../config.js";
import { createProxySocketFactory } from "./proxySocket.js";

/**
 * Переводит настройки прокси в опции конструктора teleproto.
 * Отдельной функцией — чтобы выбор транспорта проверялся юнит-тестом.
 * @param {import("./proxyUrl.js").ProxySettings|null} proxy
 * @returns {{ proxy?: object, networkSocket?: Function }}
 */
export function proxyClientOptions(proxy) {
    if (!proxy) return {};

    if (proxy.kind === "socks") {
        return {
            proxy: {
                ip: proxy.host,
                port: proxy.port,
                socksType: proxy.socksType,
                timeout: proxy.timeout,
                // Пустая строка включила бы в SOCKS5 аутентификацию с пустыми
                // учётными данными, а прокси без авторизации на такое отвечает отказом.
                username: proxy.username || undefined,
                password: proxy.password || undefined,
            },
        };
    }

    if (proxy.kind === "mtproxy") {
        // Секрет отдаём как есть: teleproto сам разбирает hex/base64 и префиксы dd/ee.
        return {
            proxy: {
                MTProxy: true,
                ip: proxy.host,
                port: proxy.port,
                secret: proxy.secret,
                timeout: proxy.timeout,
            },
        };
    }

    // HTTP CONNECT: опцию `proxy` teleproto не отдаём совсем — базовый
    // PromisedNetSockets на незнакомом ему виде прокси бросает «Invalid sockets
    // params». Подменяем сам транспорт, настройки живут в замыкании фабрики.
    return { networkSocket: createProxySocketFactory(proxy) };
}

// Считаем один раз на процесс: конфигурация неизменна, а фабрику сокета
// teleproto инстанцирует на каждое соединение сам.
const proxyOptions = proxyClientOptions(config.proxy);

/**
 * Создаёт экземпляр MTProto-клиента для аккаунта.
 * @param {string} sessionString пустая строка — новый, ещё не авторизованный клиент
 * @returns {import("teleproto").TelegramClient}
 */
export function buildClient(sessionString) {
    config.assertCredentials();
    config.assertProxy();
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
            ...proxyOptions,
        }
    );
}

/** @returns {{ apiId: number, apiHash: string }} */
export function apiCredentials() {
    config.assertCredentials();
    return { apiId: config.apiId, apiHash: config.apiHash };
}
