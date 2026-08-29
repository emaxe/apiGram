import fs from "node:fs";
import path from "node:path";

/**
 * Создаёт директорию, если её ещё нет.
 * @param {string} dirPath
 */
export function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * Читает JSON-файл или возвращает значение по умолчанию.
 * @template T
 * @param {string} filePath
 * @param {T} [defaultValue=null]
 * @returns {T}
 */
export function readJson(filePath, defaultValue = null) {
    try {
        if (!fs.existsSync(filePath)) return defaultValue;
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return defaultValue;
    }
}

/**
 * Пишет JSON-файл с правами 0600, создавая родительские папки.
 *
 * Запись атомарная (временный файл + rename): падение посреди записи иначе
 * оставило бы битый JSON, а `readJson` молча вернул бы значение по умолчанию —
 * то есть реестр аккаунтов со всеми сессиями выглядел бы пустым.
 * @param {string} filePath
 * @param {unknown} value
 */
export function writeJson(filePath, value) {
    const dir = path.dirname(filePath);
    ensureDir(dir);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw err;
    }
}
