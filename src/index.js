#!/usr/bin/env node
/**
 * Точка входа: поднимает HTTP-сервер, вешает на него WebSocket и обеспечивает
 * корректную остановку по сигналу.
 *
 * Порядок важен: сначала проверяем ключи (иначе первый же запрос упадёт невнятной
 * ошибкой teleproto), потом слушаем порт, и только затем привязываем WS — серверу
 * нужен уже созданный http.Server.
 */
import { createHttpApp } from "./server/http.js";
import { attachWs } from "./server/ws.js";
import { startUpdatesLog, stopUpdatesLog } from "./server/updatesLog.js";
import { sessionManager } from "./telegram/sessionManager.js";
import { describeProxy } from "./telegram/proxyUrl.js";
import { config } from "./config.js";

config.assertCredentials();
// Кривой PROXY_URL — ошибка конфигурации, а не рантайма: лучше не подняться
// совсем, чем молча ходить в Telegram напрямую, раскрывая настоящий IP.
config.assertProxy();

const app = createHttpApp();
const server = app.listen(config.port, config.host, () => {
    console.log(`apiGram listening on http://${config.host}:${config.port}`);
    if (startUpdatesLog()) {
        console.log(`apiGram updates log: ${config.updatesFile} (ротация ${config.updatesMaxMb} MB)`);
    }
    // Пустой ADMIN_TOKEN оставляет POST /v1/accounts открытым. На localhost это
    // осознанное удобство, на любом другом адресе — дыра, о которой нужно сказать вслух.
    if (!config.adminToken && config.host !== "127.0.0.1" && config.host !== "localhost") {
        console.warn(
            "ВНИМАНИЕ: ADMIN_TOKEN не задан, а сервер слушает не только localhost —\n" +
            "  POST /v1/accounts открыт всем. Задайте ADMIN_TOKEN в .env."
        );
    }
    if (config.corsOrigins.length > 0) {
        console.log(`apiGram CORS: ${config.corsOrigins.join(", ")}`);
        // С «*» запрос к шлюзу может отправить любая открытая пользователем
        // страница. Без ADMIN_TOKEN она заодно сможет создавать аккаунты.
        if (config.corsOrigins.includes("*")) {
            console.warn(
                "ВНИМАНИЕ: CORS_ORIGINS=* разрешает запросы с любого сайта.\n" +
                "  Укажите конкретные источники, например http://127.0.0.1:8080." +
                (config.adminToken ? "" : "\n  Вдобавок ADMIN_TOKEN пуст: создание аккаунтов открыто всем.")
            );
        }
    }
    if (config.proxy) {
        // Источник называем, когда он не PROXY_URL: прокси из системной переменной
        // в .env не виден, и без подсказки непонятно, откуда он вообще взялся.
        const from = config.proxySource === "PROXY_URL" ? "" : `из ${config.proxySource}, `;
        console.log(`apiGram proxy: ${describeProxy(config.proxy)} (${from}таймаут ${config.proxy.timeout} с)`);
        // Basic-авторизация — это кодировка, а не шифрование: по http:// пароль от
        // прокси уходит открытым текстом. Сам MTProto внутри туннеля зашифрован.
        if (config.proxy.kind === "http" && !config.proxy.tls && config.proxy.username) {
            console.warn(
                `ВНИМАНИЕ: ${config.proxySource}=http:// с логином — Proxy-Authorization передаётся открытым текстом.\n` +
                "  Для прокси за пределами локальной сети используйте https://."
            );
        }
        if (config.proxy.insecureTls) {
            console.warn(
                `ВНИМАНИЕ: ${config.proxySource} с ?insecure=1 — сертификат прокси не проверяется.\n` +
                "  Пароль от прокси в этом режиме уязвим к перехвату."
            );
        }
    }
});

const wss = attachWs(server);

let shuttingDown = false;

/**
 * Graceful shutdown: закрыть сокеты, отключить клиентов Telegram, дождаться
 * закрытия HTTP-сервера. Повторные сигналы игнорируются.
 * @param {string} signal
 */
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`apiGram: получен ${signal}, останавливаюсь…`);
    // Страховка от зависшего disconnect: через 5 секунд выходим в любом случае.
    // unref, чтобы сам таймер не держал event loop, если всё закрылось раньше.
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    try {
        stopUpdatesLog();
        for (const socket of wss.clients) socket.close(1001, "server_shutdown");
        wss.close();
        // Именно disconnect, а не release: логаут отозвал бы сессии в Telegram.
        await sessionManager.disconnectAll();
        await new Promise((resolve) => server.close(resolve));
    } catch (err) {
        console.error("apiGram: ошибка при остановке", err);
    }
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
