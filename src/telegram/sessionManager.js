import { EventEmitter } from "node:events";
import { buildClient, apiCredentials } from "./client.js";

/**
 * Пул TelegramClient по аккаунтам. Авторизованные клиенты живут в `clients`
 * (лениво подключаются при первом обращении), незавершённые логины — в
 * `pendingAuth` (полу-готовый клиент с phoneCodeHash между HTTP-шагами).
 */
class SessionManager {
    constructor() {
        /** @type {Map<string, object>} клиент + служебная инфо авторизованных аккаунтов */
        this.clients = new Map();
        /** @type {Map<string, object>} незавершённые логины { client, phoneCodeHash, phone } */
        this.pendingAuth = new Map();
        /** @type {Map<string, EventEmitter>} канал событий на аккаунт */
        this.channels = new Map();
        /** @type {Map<string, Promise<import("teleproto").TelegramClient>>} влетающие подключения */
        this.connecting = new Map();
    }

    /** @param {string} accountId */
    channel(accountId) {
        if (!this.channels.has(accountId)) {
            const bus = new EventEmitter();
            bus.setMaxListeners(0);
            this.channels.set(accountId, bus);
        }
        return this.channels.get(accountId);
    }

    /**
     * Возвращает авторизованный, подключённый и проверенный клиент аккаунта.
     * Лениво подключает при первом обращении.
     * @param {object} account
     * @returns {Promise<import("teleproto").TelegramClient>}
     */
    async getClient(account) {
        if (!account.sessionString) {
            throw new Error("Аккаунт не авторизован в Telegram.");
        }
        const existing = this.clients.get(account.accountId);
        if (existing) return existing.client;

        if (this.connecting.has(account.accountId)) {
            return this.connecting.get(account.accountId);
        }

        const promise = this.#connectClient(account);
        this.connecting.set(account.accountId, promise);
        try {
            return await promise;
        } finally {
            this.connecting.delete(account.accountId);
        }
    }

    /**
     * Подключает и проверяет клиент аккаунта, ставя его в пул `clients`.
     * @param {object} account
     * @returns {Promise<import("teleproto").TelegramClient>}
     */
    async #connectClient(account) {
        const client = buildClient(account.sessionString);
        try {
            await client.connect();
            const authorized = await client.isUserAuthorized();
            if (!authorized) {
                throw new Error("Сессия недействительна или отозвана. Нужен повторный логин.");
            }
            const { startAccountListener } = await import("./listener.js");
            const stopListener = startAccountListener(client, this.channel(account.accountId));
            this.clients.set(account.accountId, { client, stopListener });
            return client;
        } catch (err) {
            await client.disconnect().catch(() => {});
            await client.destroy?.().catch(() => {});
            throw err;
        }
    }

    /**
     * Начинает (или возвращает существующий) незавершённый логин.
     * @param {object} account
     * @param {string} phone
     * @returns {Promise<import("teleproto").TelegramClient>} подключённый клиент
     */
    async startLogin(account, phone) {
        let entry = this.pendingAuth.get(account.accountId);
        if (!entry) {
            const client = buildClient("");
            await client.connect();
            entry = { client, phone, phoneCodeHash: null };
            this.pendingAuth.set(account.accountId, entry);
        }
        entry.phone = phone;
        return entry.client;
    }

    /** @param {string} accountId */
    getPending(accountId) {
        return this.pendingAuth.get(accountId);
    }

    /** @param {string} accountId */
    clearPending(accountId) {
        const entry = this.pendingAuth.get(accountId);
        if (entry) {
            entry.client.disconnect().catch(() => {});
            entry.client.destroy?.().catch(() => {});
            this.pendingAuth.delete(accountId);
        }
    }

    /**
     * Убирает незавершённый логин без уничтожения его клиента (тот перешёл в пул).
     * @param {string} accountId
     */
    #adoptPending(accountId) {
        this.pendingAuth.delete(accountId);
    }

    /**
     * Регистрирует авторизованный клиент после успешного логина.
     * Никогда не уничтожает переданный клиент — если в `pendingAuth` лежит
     * тот же клиент, он просто «усыновляется» в пул.
     * @param {object} account
     * @param {import("teleproto").TelegramClient} client
     */
    async registerAuthorized(account, client) {
        const { startAccountListener } = await import("./listener.js");
        const previous = this.clients.get(account.accountId);
        previous?.stopListener?.();
        const stopListener = startAccountListener(client, this.channel(account.accountId));
        this.clients.set(account.accountId, { client, stopListener });
        const pending = this.pendingAuth.get(account.accountId);
        if (pending && pending.client === client) {
            this.#adoptPending(account.accountId);
        } else {
            this.clearPending(account.accountId);
        }
    }

    /**
     * Отключает и удаляет клиент аккаунта (при логауте/удалении).
     * @param {string} accountId
     */
    async release(accountId) {
        this.clearPending(accountId);
        const entry = this.clients.get(accountId);
        if (entry) {
            entry.stopListener?.();
            await entry.client.logOut?.().catch(() => {});
            await entry.client.disconnect().catch(() => {});
            await entry.client.destroy?.().catch(() => {});
            this.clients.delete(accountId);
        }
        const bus = this.channels.get(accountId);
        if (bus) {
            bus.removeAllListeners();
            this.channels.delete(accountId);
        }
    }
}

export const sessionManager = new SessionManager();
export { apiCredentials };
