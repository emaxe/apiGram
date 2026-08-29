import { config } from "../config.js";
import { JsonlLog } from "../storage/jsonl.js";
import { sessionManager } from "../telegram/sessionManager.js";
import { toPlain } from "../telegram/serialize.js";

/** @type {JsonlLog|null} */
let log = null;
/** @type {Map<string, Function>} подписки на каналы аккаунтов */
const subscriptions = new Map();

/**
 * Включает запись потока обновлений в JSONL с ротацией по размеру.
 * Управляется `LOG_UPDATES=true` — по умолчанию выключено, потому что в лог
 * попадают тексты сообщений.
 * @returns {boolean} включился ли лог
 */
export function startUpdatesLog() {
    if (!config.logUpdates || log) return Boolean(log);
    log = new JsonlLog(config.updatesFile, config.updatesMaxMb);
    sessionManager.onChannelCreated((accountId, bus) => subscribe(accountId, bus));
    for (const [accountId, bus] of sessionManager.channels) {
        subscribe(accountId, bus);
    }
    return true;
}

/**
 * @param {string} accountId
 * @param {import("node:events").EventEmitter} bus
 */
function subscribe(accountId, bus) {
    if (subscriptions.has(accountId)) return;
    const listener = (event) => {
        try {
            log?.append({ ts: Date.now(), accountId, event: toPlain(event) });
        } catch {
            // лог обновлений не должен ронять доставку событий клиентам
        }
    };
    bus.on("account_event", listener);
    subscriptions.set(accountId, listener);
}

/** Закрывает файловый дескриптор лога. */
export function stopUpdatesLog() {
    for (const [accountId, listener] of subscriptions) {
        sessionManager.channels.get(accountId)?.off("account_event", listener);
    }
    subscriptions.clear();
    log?.close();
    log = null;
}
