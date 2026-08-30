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
import { config } from "./config.js";

config.assertCredentials();

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
