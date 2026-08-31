/**
 * Транспорт через HTTP/HTTPS-прокси методом CONNECT.
 *
 * teleproto знает только SOCKS и MTProxy: базовый `PromisedNetSockets` на чужом
 * описании прокси бросает «Invalid sockets params». Поэтому HTTP-прокси
 * подключается через штатную точку расширения — опцию `networkSocket`.
 *
 * Наследуемся от `PromisedNetSockets` и переопределяем один только `connect`:
 * машинка чтения (`chunks`/`available`/`_consume`) там нетривиальная, и её копия
 * разъедется с апстримом при первом же обновлении библиотеки.
 */
import net from "node:net";
import tls from "node:tls";
import { Buffer } from "node:buffer";
import { PromisedNetSockets } from "teleproto/extensions/PromisedNetSockets.js";
import { ProtocolError } from "./errors.js";

/** Больше этого прокси на CONNECT не отвечает — дальше это уже не заголовок. */
const MAX_HEADER_BYTES = 8192;

/**
 * Собирает запрос CONNECT.
 * @param {{ host: string, port: number, username?: string, password?: string }} target
 *        host/port — адрес дата-центра Telegram: туда прокси и открывает туннель
 * @returns {Buffer}
 */
export function buildConnectRequest({ host, port, username, password }) {
    const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    const lines = [
        `CONNECT ${authority} HTTP/1.1`,
        `Host: ${authority}`,
        // Без keep-alive часть прокси закрывает соединение сразу после ответа.
        "Proxy-Connection: keep-alive",
    ];
    if (username) {
        // Отдаём авторизацию сразу, не дожидаясь 407: лишний round-trip на каждое
        // соединение (а их тут по одному на дата-центр плюс реконнекты) не нужен.
        const token = Buffer.from(`${username}:${password || ""}`, "utf8").toString("base64");
        lines.push(`Proxy-Authorization: Basic ${token}`);
    }
    return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "utf8");
}

/**
 * Разбирает статусную строку ответа прокси.
 * @param {Buffer} header всё до `\r\n\r\n` включительно
 * @returns {{ code: number, reason: string }}
 * @throws {ProtocolError} ответ не похож на HTTP
 */
export function parseConnectResponse(header) {
    // latin1, а не utf8: заголовки — это байты, и кривая кодировка в тексте
    // причины не должна превращаться в U+FFFD и мешать диагностике.
    const statusLine = header.toString("latin1").split("\r\n")[0];
    const match = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+([\s\S]*))?$/.exec(statusLine);
    if (!match) {
        throw new ProtocolError(
            "proxy_protocol_error",
            `Прокси ответил на CONNECT не по HTTP: "${statusLine.slice(0, 100)}"`,
            { hint: "Похоже, по адресу из PROXY_URL слушает не HTTP-прокси. Проверьте схему: socks5:// или mtproxy://?" }
        );
    }
    return { code: Number(match[1]), reason: (match[2] || "").trim() };
}

/**
 * Читает заголовок ответа побайтово, до пустой строки.
 *
 * Именно побайтово: в том же TCP-сегменте вслед за `\r\n\r\n` уже могут лежать
 * байты MTProto, и «прочитать чанк и отрезать хвост» означало бы этот хвост
 * потерять. Сотня микрообещаний однократно на соединение того стоит.
 *
 * @param {{ readExactly(n: number): Promise<Buffer> }} reader сокет teleproto
 * @param {number} [limit=8192]
 * @returns {Promise<Buffer>}
 * @throws {ProtocolError} заголовок не кончился за `limit` байт
 */
export async function readConnectResponse(reader, limit = MAX_HEADER_BYTES) {
    const bytes = [];
    while (bytes.length < limit) {
        const chunk = await reader.readExactly(1);
        bytes.push(chunk[0]);
        const n = bytes.length;
        if (n >= 4 && bytes[n - 4] === 0x0d && bytes[n - 3] === 0x0a && bytes[n - 2] === 0x0d && bytes[n - 1] === 0x0a) {
            return Buffer.from(bytes);
        }
    }
    throw new ProtocolError("proxy_protocol_error", `Прокси не закончил заголовок ответа за ${limit} байт.`);
}

/**
 * Превращает статус прокси в ошибку с внятным кодом.
 * @param {{ code: number, reason: string }} status
 * @param {{ host: string, port: number, username: string }} proxy
 * @param {string} target «адрес:порт» дата-центра
 * @returns {ProtocolError}
 */
function connectError(status, proxy, target) {
    if (status.code === 407) {
        return new ProtocolError(
            "proxy_auth_required",
            `Прокси ${proxy.host}:${proxy.port} требует авторизацию (407 ${status.reason}).`,
            {
                hint: proxy.username
                    ? "Логин и пароль из PROXY_URL не подошли."
                    : "Добавьте учётные данные: http://user:pass@host:port (спецсимволы — percent-encoding).",
            }
        );
    }
    if (status.code === 403 || status.code === 405) {
        return new ProtocolError(
            "proxy_forbidden",
            `Прокси ${proxy.host}:${proxy.port} запретил CONNECT к ${target} (${status.code} ${status.reason}).`,
            { hint: "Многие HTTP-прокси разрешают CONNECT только на порт 443." }
        );
    }
    return new ProtocolError(
        "proxy_connect_failed",
        `Прокси ${proxy.host}:${proxy.port} не открыл туннель к ${target}: ${status.code} ${status.reason}.`
    );
}

/**
 * Устанавливает соединение с самим прокси — TCP или TLS.
 *
 * Свой таймаут обязателен: у ОС дефолт на connect — десятки секунд, и на мёртвом
 * прокси клиент завис бы на каждой из пяти попыток подключения.
 *
 * @param {import("./proxyUrl.js").ProxySettings} proxy
 * @returns {Promise<import("node:net").Socket>}
 */
export function openProxySocket(proxy) {
    return new Promise((resolve, reject) => {
        const socket = proxy.tls
            ? tls.connect({
                host: proxy.host,
                port: proxy.port,
                // SNI имеет смысл только для доменного имени: с IP в servername
                // часть серверов рвёт рукопожатие.
                servername: net.isIP(proxy.host) ? undefined : proxy.host,
                rejectUnauthorized: !proxy.insecureTls,
            })
            : net.connect({ host: proxy.host, port: proxy.port });

        const readyEvent = proxy.tls ? "secureConnect" : "connect";
        const finish = (fn) => (arg) => {
            clearTimeout(timer);
            socket.removeListener("error", onError);
            socket.removeListener(readyEvent, onReady);
            fn(arg);
        };
        const onReady = () => finish(resolve)(socket);
        const onError = (err) => {
            socket.destroy();
            finish(reject)(new ProtocolError(
                "proxy_unreachable",
                `Не удалось подключиться к прокси ${proxy.host}:${proxy.port}: ${err.message}`,
                { cause: err, hint: err.code === "ECONNREFUSED" ? "Прокси не слушает этот порт." : undefined }
            ));
        };
        const timer = setTimeout(() => {
            socket.destroy();
            finish(reject)(new ProtocolError(
                "proxy_timeout",
                `Прокси ${proxy.host}:${proxy.port} не ответил за ${proxy.timeout} с.`,
                { hint: "Увеличьте PROXY_TIMEOUT или проверьте адрес прокси." }
            ));
        }, proxy.timeout * 1000);

        socket.once(readyEvent, onReady);
        socket.once("error", onError);
    });
}

/**
 * Делает класс-фабрику сокетов для опции `networkSocket` teleproto.
 *
 * Именно класс: teleproto зовёт `new socket(proxy, keepAliveInterval)` на каждое
 * соединение — главный сендер, отдельные сендеры дата-центров для медиа и каждый
 * реконнект, — поэтому настройки прокси захватываются замыканием.
 *
 * @param {import("./proxyUrl.js").ProxySettings} proxy описание с `kind: "http"`
 * @returns {Function} совместимо с `SocketFactory` из teleproto
 */
export function createProxySocketFactory(proxy) {
    return class HttpProxySocket extends PromisedNetSockets {
        /**
         * @param {unknown} _proxy всегда undefined: свой прокси мы teleproto не
         *        отдаём, иначе базовый класс бросит на незнакомом ему виде
         * @param {number} [keepAliveInterval]
         */
        constructor(_proxy, keepAliveInterval) {
            super(undefined, keepAliveInterval);
            // Страховка: SOCKS-ветка родителя должна остаться выключенной.
            this.proxy = undefined;
            this.proxySettings = proxy;
            this.lastSocketError = undefined;
        }

        /**
         * Соединяется с прокси и просит у него туннель до дата-центра.
         * @param {number} port порт дата-центра Telegram
         * @param {string} ip адрес дата-центра Telegram
         * @returns {Promise<this>}
         */
        async connect(port, ip) {
            const settings = this.proxySettings;
            const socket = await openProxySocket(settings);

            // Дальше — та же подготовка, что в PromisedNetSockets.connect: объект
            // переиспользуется при ретраях MTProtoSender, и хвост прошлой сессии
            // в буфере сломал бы кадрирование первого же пакета.
            this.chunks = [];
            this.headOffset = 0;
            this.available = 0;
            this.canRead = new Promise((resolve) => {
                this.resolveRead = resolve;
            });
            this.closed = false;
            this.lastSocketError = undefined;
            this.client = socket;
            socket.setNoDelay(true);
            socket.setKeepAlive(this.keepAliveInterval > 0, Math.max(0, this.keepAliveInterval));
            // Слушатель error обязателен: без него первый же RST уронит процесс.
            // Саму ошибку увидит read() — сокет закроется и бросит NetSocketClosedError.
            socket.on("error", (err) => {
                this.lastSocketError = err;
            });
            socket.on("close", () => {
                if (this.client && this.client.destroyed) {
                    if (this.resolveRead) this.resolveRead(false);
                    this.closed = true;
                }
            });
            await this.receive();

            const target = net.isIPv6(ip) ? `[${ip}]:${port}` : `${ip}:${port}`;
            // Молчащий после CONNECT прокси встречается редко, но повесить на нём
            // клиент навсегда нельзя: рвём соединение — чтение сразу разблокируется.
            const stall = setTimeout(() => socket.destroy(), settings.timeout * 1000);
            try {
                this.write(buildConnectRequest({
                    host: ip,
                    port,
                    username: settings.username,
                    password: settings.password,
                }));
                const status = parseConnectResponse(await readConnectResponse(this));
                if (status.code !== 200) throw connectError(status, settings, target);
            } catch (err) {
                await this.close().catch(() => {});
                // Разрыв на рукопожатии виден как «сокет закрыт»; настоящая причина
                // лежит в lastSocketError, и без неё диагностика бесполезна.
                if (this.lastSocketError && !(err instanceof ProtocolError)) {
                    throw new ProtocolError(
                        "proxy_connect_failed",
                        `Прокси ${settings.host}:${settings.port} разорвал соединение на CONNECT: ${this.lastSocketError.message}`,
                        { cause: this.lastSocketError }
                    );
                }
                if (err instanceof ProtocolError) throw err;
                throw new ProtocolError(
                    "proxy_connect_failed",
                    `Прокси ${settings.host}:${settings.port} не открыл туннель к ${target}: ${err.message}`,
                    { cause: err }
                );
            } finally {
                clearTimeout(stall);
            }
            return this;
        }
    };
}
