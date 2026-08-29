import { EventEmitter } from "node:events";
import { buildClient, apiCredentials } from "./client.js";
import { ProtocolError } from "./errors.js";

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
        /** @type {Array<(accountId: string, bus: EventEmitter) => void>} наблюдатели за созданием каналов */
        this.channelObservers = [];
    }

    /**
     * Подписка на появление нового канала аккаунта (нужна логу обновлений,
     * который должен цепляться к каналам, созданным уже после старта).
     * @param {(accountId: string, bus: EventEmitter) => void} observer
     */
    onChannelCreated(observer) {
        this.channelObservers.push(observer);
    }

    /** @returns {{ apiId: number, apiHash: string }} */
    apiCredentials() {
        return apiCredentials();
    }

    /** @param {string} accountId */
    channel(accountId) {
        if (!this.channels.has(accountId)) {
            const bus = new EventEmitter();
            bus.setMaxListeners(0);
            this.channels.set(accountId, bus);
            for (const observer of this.channelObservers) {
                try { observer(accountId, bus); } catch { /* наблюдатель не должен ломать канал */ }
            }
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
            throw new ProtocolError("not_authorized", "Аккаунт не авторизован в Telegram.", {
                hint: "POST /v1/accounts/:id/auth/send-code",
            });
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
                throw new ProtocolError(
                    "session_invalid",
                    "Сессия недействительна или отозвана. Нужен повторный логин.",
                    { hint: "POST /v1/accounts/:id/auth/send-code" }
                );
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
            this.pendingAuth.delete(accountId);
            Promise.resolve(entry.client.disconnect?.()).catch(() => {});
            Promise.resolve(entry.client.destroy?.()).catch(() => {});
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
     * Логаут: отзывает сессию в Telegram, отключает и убирает клиент из пула.
     * Канал событий НЕ удаляется — вместо этого в него уходит терминальное
     * событие, чтобы подписанные WS-клиенты корректно закрылись. Иначе после
     * повторного логина создался бы новый EventEmitter, а старые сокеты
     * навсегда остались бы на «мёртвом».
     * @param {string} accountId
     */
    async release(accountId) {
        await this.#teardown(accountId, { logOut: true });
        this.channel(accountId).emit("account_event", {
            accountEvent: true,
            type: "session_closed",
            reason: "logout",
        });
    }

    /**
     * Отключает клиент аккаунта, НЕ отзывая сессию в Telegram (остановка сервиса).
     * @param {string} accountId
     */
    async detach(accountId) {
        await this.#teardown(accountId, { logOut: false });
    }

    /**
     * Отключает все клиенты без логаута — для graceful shutdown.
     * @returns {Promise<void>}
     */
    async disconnectAll() {
        const ids = [...this.clients.keys(), ...this.pendingAuth.keys()];
        await Promise.all([...new Set(ids)].map((id) => this.detach(id)));
    }

    /**
     * @param {string} accountId
     * @param {{ logOut: boolean }} opts
     */
    async #teardown(accountId, { logOut }) {
        this.clearPending(accountId);
        const entry = this.clients.get(accountId);
        if (!entry) return;
        this.clients.delete(accountId);
        entry.stopListener?.();
        if (logOut) {
            await Promise.resolve(entry.client.logOut?.()).catch(() => {});
        }
        await Promise.resolve(entry.client.disconnect?.()).catch(() => {});
        await Promise.resolve(entry.client.destroy?.()).catch(() => {});
    }
}

export const sessionManager = new SessionManager();
