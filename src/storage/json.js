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
 * @param {string} filePath
 * @param {unknown} value
 */
export function writeJson(filePath, value) {
    const dir = path.dirname(filePath);
    ensureDir(dir);
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
}
