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

export const config = {
    rootDir,
    dataDir,
    accountsFile,
    updatesFile,
    updatesMaxMb: parseInt(process.env.UPDATES_MAX_MB || "50", 10),
    apiId: parseInt(process.env.TELEGRAM_API_ID || "0", 10),
    apiHash: process.env.TELEGRAM_API_HASH || "",
    host: process.env.HOST || "127.0.0.1",
    port: parseInt(process.env.PORT || "3111", 10),
    adminToken: process.env.ADMIN_TOKEN || "",
    // Пишет тексты сообщений на диск — по умолчанию выключено намеренно.
    logUpdates: String(process.env.LOG_UPDATES || "false") === "true",

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
    }
};
