import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const localEnvPath = path.join(rootDir, ".env");
if (fs.existsSync(localEnvPath)) {
    dotenv.config({ path: localEnvPath, quiet: true });
}

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
