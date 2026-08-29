import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./json.js";

/**
 * Append-лог событий в формате JSON Lines с ротацией по размеру.
 */
export class JsonlLog {
    /**
     * @param {string} filePath
     * @param {number} [maxMb=50] порог ротации
     */
    constructor(filePath, maxMb = 50) {
        this.filePath = filePath;
        this.maxBytes = maxMb * 1024 * 1024;
        this.fd = null;
    }

    _ensure() {
        if (this.fd) return;
        ensureDir(path.dirname(this.filePath));
        this.fd = fs.openSync(this.filePath, "a");
    }

    /**
     * Ротирует файл при превышении порога: переименовывает с timestamp, открывает новый.
     */
    _rotateIfNeeded() {
        if (!fs.existsSync(this.filePath)) return;
        const stat = fs.statSync(this.filePath);
        if (stat.size < this.maxBytes) return;
        try {
            fs.closeSync(this.fd);
            fs.renameSync(this.filePath, `${this.filePath}.${Date.now()}`);
            this.fd = fs.openSync(this.filePath, "a");
        } catch {
            // Игнорируем ошибки ротации
        }
    }

    /**
     * Дописывает одну JSON-строку.
     * @param {unknown} entry
     */
    append(entry) {
        this._ensure();
        this._rotateIfNeeded();
        fs.writeSync(this.fd, JSON.stringify(entry) + "\n");
    }

    /** Закрывает файловый дескриптор. */
    close() {
        if (this.fd) {
            try { fs.closeSync(this.fd); } catch { /* ignore */ }
            this.fd = null;
        }
    }
}
