import { WebSocketServer } from "ws";
import { getAccount } from "./accounts.js";
import { sessionManager } from "../telegram/sessionManager.js";
import { stringify } from "../telegram/serialize.js";

/** Интервал keepalive-пинга, мс. */
const PING_INTERVAL_MS = 30_000;

/**
 * Привязывает WebSocket-сервер к HTTP-серверу.
 * Клиент подключается: WS /v1/ws?accountId=...&token=...
 * @param {import("http").Server} httpServer
 * @returns {import("ws").WebSocketServer}
 */
export function attachWs(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: "/v1/ws" });

    wss.on("connection", async (socket, req) => {
        socket.isAlive = true;
        socket.on("pong", () => { socket.isAlive = true; });
        socket.on("error", () => {});

        const url = new URL(req.url, "http://localhost");
        const token = url.searchParams.get("token") || "";
        const accountId = url.searchParams.get("accountId") || "";
        const account = getAccount(accountId, token);
        if (!account || account.status !== "authorized") {
            socket.close(4001, "unauthorized");
            return;
        }

        // Поднимаем клиента Telegram здесь же: слушатель обновлений регистрируется
        // только внутри sessionManager, поэтому без этого вызова свежезапущенный
        // сервер не отдал бы в сокет ни одного события до первого REST-запроса.
        try {
            await sessionManager.getClient(account);
        } catch (err) {
            if (socket.readyState === socket.OPEN) {
                socket.send(stringify({ accountEvent: true, type: "error", error: String(err?.message || err) }));
            }
            socket.close(4002, "session_unavailable");
            return;
        }
        if (socket.readyState !== socket.OPEN) return;

        const bus = sessionManager.channel(accountId);
        const listener = (event) => {
            if (socket.readyState === socket.OPEN) {
                socket.send(stringify(event));
            }
            if (event?.type === "session_closed") {
                socket.close(4003, "session_closed");
            }
        };
        bus.on("account_event", listener);
        socket.on("close", () => bus.off("account_event", listener));
        socket.send(stringify({ accountEvent: true, type: "connected", accountId }));
    });

    // Отстрел мёртвых соединений: без этого повисшие сокеты копятся до перезапуска.
    const heartbeat = setInterval(() => {
        for (const socket of wss.clients) {
            if (socket.isAlive === false) {
                socket.terminate();
                continue;
            }
            socket.isAlive = false;
            try { socket.ping(); } catch { /* ignore */ }
        }
    }, PING_INTERVAL_MS);
    heartbeat.unref();
    wss.on("close", () => clearInterval(heartbeat));

    return wss;
}
