/**
 * Конфигурация процесса: читается один раз при импорте и дальше неизменна.
 *
 * Источник значений — переменные окружения; `.env` в корне проекта подхватывается,
 * если существует. Переменные, выставленные снаружи (systemd, docker, CI), имеют
 * приоритет: dotenv по умолчанию не перетирает уже заданные.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { parseOrigins } from "./server/cors.js";
import { parseProxyUrl, pickProxySource } from "./telegram/proxyUrl.js";

// Корень пакета, а не cwd: сервер должен находить свои .env и data/ независимо
// от того, из какого каталога его запустили (важно для `npx apigram`).
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const localEnvPath = path.join(rootDir, ".env");
if (fs.existsSync(localEnvPath)) {
    dotenv.config({ path: localEnvPath, quiet: true });
}

// DATA_DIR разрешается относительно корня пакета. Здесь лежат боевые учётные
// данные (сессии Telegram), поэтому каталог и файлы в нём — под 0600 и в .gitignore.
const dataDir = path.resolve(rootDir, process.env.DATA_DIR || "./data");
const accountsFile = path.join(dataDir, "accounts.json");
const updatesFile = path.join(dataDir, "updates.jsonl");

// Версию берём из package.json, а не из строки в коде: её показывает
// `GET /v1/health`, и клиент по ней сверяет совместимость контракта. Зашитая
// копия рано или поздно разъезжается с настоящей, причём молча.
export const version = readVersion();

/**
 * Читает версию пакета. Отсутствие или порча package.json не должны валить
 * старт сервера — версия здесь справочная, а не рабочая.
 * @returns {string}
 */
function readVersion() {
    try {
        return JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}

// PROXY_FROM_ENV разрешает взять прокси из системных HTTPS_PROXY/ALL_PROXY/HTTP_PROXY.
// По умолчанию выключено: эти переменные часто выставлены в шелле для совсем других
// задач, и молча уводить туда боевые сессии Telegram шлюз не вправе.
const proxySourceInfo = pickProxySource(process.env, String(process.env.PROXY_FROM_ENV || "false") === "true");

// Разбор прокси не должен ронять сам импорт конфигурации: её тянут и тесты, и
// вспомогательные скрипты, а кривое значение в локальном .env положило бы их все.
// Ошибку показываем на старте — там от неё есть польза (см. assertProxy).
let proxy = null;
let proxyError = "";
try {
    proxy = parseProxyUrl(
        proxySourceInfo.value,
        parseInt(process.env.PROXY_TIMEOUT || "5", 10),
        proxySourceInfo.name || "PROXY_URL"
    );
} catch (err) {
    proxyError = err.message;
}

export const config = {
    rootDir,
    version,
    dataDir,
    accountsFile,
    updatesFile,
    updatesMaxMb: parseInt(process.env.UPDATES_MAX_MB || "50", 10),
    apiId: parseInt(process.env.TELEGRAM_API_ID || "0", 10),
    apiHash: process.env.TELEGRAM_API_HASH || "",
    host: process.env.HOST || "127.0.0.1",
    port: parseInt(process.env.PORT || "3111", 10),
    adminToken: process.env.ADMIN_TOKEN || "",
    // Источники, которым разрешены браузерные запросы. Пусто — CORS выключен,
    // и ни одна веб-страница обратиться к шлюзу не может.
    corsOrigins: parseOrigins(process.env.CORS_ORIGINS),
    // Пишет тексты сообщений на диск — по умолчанию выключено намеренно.
    logUpdates: String(process.env.LOG_UPDATES || "false") === "true",
    // Прокси для MTProto — общий на все аккаунты. null — прямое подключение.
    proxy,
    // Имя переменной, откуда взяты настройки: без него неясно, почему шлюз вообще
    // пошёл через прокси, если в .env пусто.
    proxySource: proxy ? proxySourceInfo.name : "",
    // Текст ошибки разбора: значение задано, но не разобрано.
    proxyError,

    /**
     * Бросает, если ключи Telegram не заданы.
     * Вызывается и на старте, и перед созданием каждого клиента: без ключей
     * MTProto-соединение всё равно не поднимется, а ошибка teleproto будет невнятной.
     * @throws {Error}
     */
    assertCredentials() {
        if (!config.apiId || !config.apiHash) {
            throw new Error(
                "Не заданы TELEGRAM_API_ID / TELEGRAM_API_HASH.\n" +
                "  Получите ключи на https://my.telegram.org (API development tools)\n" +
                "  и задайте их в .env или через переменные окружения."
            );
        }
    },

    /**
     * Бросает, если прокси задан, но не разобран.
     * Молчаливый откат на прямое соединение недопустим: пользователь получил бы
     * утечку настоящего IP там, где просил ходить через прокси.
     * @throws {Error}
     */
    assertProxy() {
        if (config.proxyError) throw new Error(config.proxyError);
    }
};
