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
    if (!config.adminToken && config.host !== "127.0.0.1" && config.host !== "localhost") {
        console.warn(
            "ВНИМАНИЕ: ADMIN_TOKEN не задан, а сервер слушает не только localhost —\n" +
            "  POST /v1/accounts открыт всем. Задайте ADMIN_TOKEN в .env."
        );
    }
});

const wss = attachWs(server);

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`apiGram: получен ${signal}, останавливаюсь…`);
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
