/**
 * Разбор `PROXY_URL` — единственной ручки настройки прокси.
 *
 * Модуль намеренно без зависимостей проекта: его тянет `config.js`, лежащий в
 * основании графа импортов, и втаскивать через него teleproto в каждый модуль
 * незачем. Тот же приём, что и с `parseOrigins` из `server/cors.js`.
 */
import { Buffer } from "node:buffer";

/** Порт по умолчанию: в строках прокси его почти всегда опускают. */
const DEFAULT_PORTS = { socks5: 1080, socks4: 1080, http: 80, https: 443, mtproxy: 443 };

/**
 * Псевдонимы из мира curl. Резолв имени на стороне прокси нам безразличен:
 * teleproto ходит к дата-центрам по IP, резолвить нечего.
 */
const SCHEME_ALIASES = { socks: "socks5", socks5h: "socks5", socks4a: "socks4" };

const SUPPORTED = "socks5://, socks4://, http://, https://, mtproxy://";

/**
 * Переменные окружения, из которых можно взять прокси, в порядке убывания
 * приоритета.
 *
 * `HTTPS_PROXY` впереди `ALL_PROXY`, как у curl: протокольная переменная важнее
 * общей. MTProto — не HTTP, но по TCP на 443 через CONNECT это ровно тот же путь,
 * что и https-запрос, поэтому `HTTP_PROXY` идёт последним: семантически он про
 * другое, и выставляют его обычно заодно, а не осознанно.
 * Строчные варианты первыми — на Unix они встречаются чаще.
 */
const ENV_CANDIDATES = ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "http_proxy", "HTTP_PROXY"];

/**
 * Выбирает, откуда брать настройки прокси.
 *
 * `PROXY_URL` всегда важнее окружения. Разбор системных переменных включается
 * отдельным `PROXY_FROM_ENV`: молча пускать боевые сессии Telegram через прокси,
 * выставленный в шелле для совсем других задач, шлюз не должен.
 *
 * @param {Record<string, string|undefined>} env обычно `process.env`
 * @param {boolean} allowEnv разрешено ли смотреть на HTTPS_PROXY/ALL_PROXY/HTTP_PROXY
 * @returns {{ name: string, value: string }} пустое имя — прокси не настроен
 */
export function pickProxySource(env, allowEnv) {
    const explicit = String(env.PROXY_URL || "").trim();
    if (explicit) return { name: "PROXY_URL", value: explicit };
    if (!allowEnv) return { name: "", value: "" };
    for (const name of ENV_CANDIDATES) {
        const value = String(env[name] || "").trim();
        if (value) return { name, value };
    }
    return { name: "", value: "" };
}

/** Секрет MTProxy: 16 байт, либо 0xdd + 16, либо 0xee + 16 + домен (fake-TLS). */
const MT_SECRET_LEN = 16;

/**
 * @typedef {object} ProxySettings
 * @property {"socks"|"http"|"mtproxy"} kind способ включения в teleproto
 * @property {string} scheme исходная схема — только для логов
 * @property {string} host без квадратных скобок даже для IPv6
 * @property {number} port
 * @property {number} timeout секунды
 * @property {string} username пустая строка — авторизации нет
 * @property {string} password
 * @property {4|5} [socksType] только для `kind === "socks"`
 * @property {string} [secret] только для `kind === "mtproxy"`
 * @property {boolean} [tls] только для `kind === "http"`: TLS до самого прокси
 * @property {boolean} [insecureTls] не проверять сертификат прокси
 */

/**
 * Разбирает `PROXY_URL` в настройки прокси.
 *
 * Бросает, а не возвращает `null`, на любом мусоре: молчаливый откат на прямое
 * соединение отдал бы Telegram настоящий IP там, где пользователь этого не хотел.
 *
 * @param {string|undefined} raw значение `PROXY_URL`; пусто — прямое подключение
 * @param {number} [timeoutSeconds=5] значение `PROXY_TIMEOUT`
 * @param {string} [source="PROXY_URL"] имя переменной — подставляется в текст ошибок
 * @returns {ProxySettings|null}
 * @throws {Error} схема не поддержана, нет хоста, битый percent-encoding, плохой секрет
 */
export function parseProxyUrl(raw, timeoutSeconds = 5, source = "PROXY_URL") {
    const value = String(raw || "").trim();
    if (!value) return null;

    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(
            `${source}: "${value}" не похоже на URL. Нужна схема и хост, например socks5://127.0.0.1:1080.\n` +
            `  Поддерживаются: ${SUPPORTED}`
        );
    }

    const rawScheme = url.protocol.replace(/:$/, "").toLowerCase();
    const scheme = SCHEME_ALIASES[rawScheme] || rawScheme;
    if (!(scheme in DEFAULT_PORTS)) {
        throw new Error(`${source}: схема "${rawScheme}://" не поддерживается. Доступны: ${SUPPORTED}`);
    }

    // WHATWG-URL оставляет IPv6-хост в скобках, а net.connect ждёт голый адрес.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!host) throw new Error(`${source}: в "${value}" не разобран хост прокси.`);

    // Порт за пределами 1..65535 WHATWG-URL отвергает сам, ещё в new URL выше.
    const port = url.port ? Number(url.port) : DEFAULT_PORTS[scheme];

    const timeout = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 5;
    const base = { scheme, host, port, timeout, username: "", password: "" };

    if (scheme === "mtproxy") {
        // Секрет ставят и в userinfo (mtproxy://SECRET@host:443), и в query
        // (?secret=…) — ссылки tg://proxy раздают его вторым способом.
        const secret = decodePart(url.searchParams.get("secret") || url.username, "секрет", source);
        assertMtSecret(secret, source);
        return { ...base, kind: "mtproxy", secret };
    }

    // Авторизация опциональна для всех схем. Пустая строка, а не undefined:
    // так проще и сравнивать, и печатать.
    const username = decodePart(url.username, "имя пользователя", source);
    const password = decodePart(url.password, "пароль", source);

    if (scheme === "http" || scheme === "https") {
        return {
            ...base,
            kind: "http",
            username,
            password,
            // https:// — TLS до самого прокси, туннель MTProto уже внутри него.
            tls: scheme === "https",
            // Поблажка для корпоративных прокси с самоподписанным сертификатом.
            insecureTls: /^(1|true|yes)$/i.test(url.searchParams.get("insecure") || ""),
        };
    }

    // У SOCKS4 в протоколе есть только userId, пароля нет — библиотека socks его
    // просто не отправит, ронять из-за этого старт незачем.
    return { ...base, kind: "socks", socksType: scheme === "socks5" ? 5 : 4, username, password };
}

/**
 * Снимает percent-encoding. Спецсимволы в пароле (`@`, `:`, `/`) обязаны быть
 * закодированы, иначе URL распарсится не там, где задумано.
 * @param {string} value
 * @param {string} what подставляется в текст ошибки
 * @param {string} source имя переменной окружения
 * @returns {string}
 * @throws {Error}
 */
function decodePart(value, what, source) {
    try {
        return decodeURIComponent(value || "");
    } catch {
        throw new Error(
            `${source}: не разобрать ${what} — одиночный "%" вне escape-последовательности.\n` +
            "  Спецсимволы кодируются percent-encoding: @ → %40, : → %3A, / → %2F."
        );
    }
}

/**
 * Проверяет секрет MTProxy до первого соединения: teleproto разберёт его и сам,
 * но сделает это уже внутри запущенного клиента, и ошибка всплывёт невнятным
 * отказом подключения, а не как проблема конфигурации.
 * @param {string} secret hex или base64/base64url
 * @param {string} source имя переменной окружения
 * @throws {Error}
 */
function assertMtSecret(secret, source) {
    if (!secret) {
        throw new Error(`${source}: для mtproxy:// нужен секрет — mtproxy://<секрет>@host:port или ?secret=…`);
    }
    // Node принимает и base64, и base64url в режиме "base64" — ссылки tg://proxy
    // раздают именно base64url, отдельная ветка не нужна.
    const raw = /^[0-9a-f]+$/i.test(secret) ? Buffer.from(secret, "hex") : Buffer.from(secret, "base64");
    const ok =
        raw.length === MT_SECRET_LEN ||                            // «голые» 16 байт
        (raw.length === MT_SECRET_LEN + 1 && raw[0] === 0xdd) ||   // dd-секрет, паддинг
        (raw.length > MT_SECRET_LEN + 1 && raw[0] === 0xee);       // ee-секрет, fake-TLS + домен
    if (!ok) {
        throw new Error(
            `${source}: секрет mtproxy распознан как ${raw.length} байт. Ожидается ` +
            `${MT_SECRET_LEN}, либо ${MT_SECRET_LEN + 1} с префиксом dd, либо ee + ${MT_SECRET_LEN} + домен.`
        );
    }
}

/**
 * Строка прокси для логов. Пароль и секрет наружу не идут никогда: логи уезжают
 * в journalctl и в чужие issue. Хост и порт секретом не являются, а без них
 * диагностика бессмысленна.
 * @param {ProxySettings|null} proxy
 * @returns {string}
 */
export function describeProxy(proxy) {
    if (!proxy) return "выключен";
    if (proxy.kind === "mtproxy") return `mtproxy://***@${proxy.host}:${proxy.port}`;
    const auth = proxy.username ? `${proxy.username}:***@` : "";
    const tail = proxy.username ? "" : " (без авторизации)";
    const insecure = proxy.insecureTls ? " [проверка TLS выключена]" : "";
    return `${proxy.scheme}://${auth}${proxy.host}:${proxy.port}${tail}${insecure}`;
}
