import { WebSocketServer } from "ws";
import { findAccountByToken } from "../registry/accountsFile.js";
import { sessionManager } from "../telegram/sessionManager.js";
import { stringify } from "../telegram/serialize.js";

/**
 * Привязывает WebSocket-сервер к HTTP-серверу.
 * Клиент подключается: WS /v1/ws?accountId=...&token=...
 * @param {import("http").Server} httpServer
 */
export function attachWs(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: "/v1/ws" });

    wss.on("connection", (socket, req) => {
        const url = new URL(req.url, "http://localhost");
        const token = url.searchParams.get("token") || "";
        const accountId = url.searchParams.get("accountId") || "";
        const account = findAccountByToken(token);
        if (!account || account.accountId !== accountId || account.status !== "authorized") {
            socket.close(4001, "unauthorized");
            return;
        }

        const bus = sessionManager.channel(accountId);
        const listener = (event) => {
            if (socket.readyState === socket.OPEN) {
                socket.send(stringify(event));
            }
        };
        bus.on("account_event", listener);
        socket.on("close", () => bus.off("account_event", listener));
        socket.on("error", () => {});
        socket.send(stringify({ accountEvent: true, type: "connected" }));
    });

    return wss;
}