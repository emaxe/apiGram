const MAX_DEPTH = 8;

function isBigIntegerLike(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        typeof value.toString === "function" &&
        typeof value.isZero === "function" &&
        typeof value.add === "function"
    );
}

/**
 * Рекурсивно превращает что угодно в структуру, перевариваемую JSON.stringify.
 * Убирает BigInt/BigInteger/Buffer/Date и режет живые методы библиотеки.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function toPlain(value, depth = 0) {
    if (value === null || value === undefined) return null;

    const type = typeof value;
    if (type === "string" || type === "boolean") return value;
    if (type === "number") return Number.isFinite(value) ? value : String(value);
    if (type === "bigint") return value.toString();
    if (type === "function" || type === "symbol") return undefined;

    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return { error: value.message, name: value.name };
    if (Buffer.isBuffer(value)) return { _type: "buffer", base64: value.toString("base64") };
    if (value instanceof Uint8Array) return { _type: "bytes", base64: Buffer.from(value).toString("base64") };
    if (isBigIntegerLike(value)) return value.toString();

    if (depth >= MAX_DEPTH) return "[max depth]";

    if (Array.isArray(value)) {
        return value.map((item) => toPlain(item, depth + 1));
    }

    if (type === "object") {
        const out = {};
        if (value.className) out.className = value.className;
        for (const key of Object.keys(value)) {
            if (key.startsWith("_") && key !== "_type") continue;
            if (key === "client" || key === "originalUpdate") continue;
            const plain = toPlain(value[key], depth + 1);
            if (plain !== undefined) out[key] = plain;
        }
        return out;
    }

    return String(value);
}

/**
 * JSON-строка из чего угодно через toPlain.
 * @param {unknown} value
 * @param {boolean} [pretty]
 * @returns {string}
 */
export function stringify(value, pretty = false) {
    return JSON.stringify(toPlain(value), null, pretty ? 2 : 0);
}

/**
 * Время Telegram (unix-секунды) → ISO-строка.
 * @param {number|undefined} seconds
 * @returns {string|null}
 */
export function tgDate(seconds) {
    if (!seconds && seconds !== 0) return null;
    const n = Number(seconds);
    return Number.isFinite(n) ? new Date(n * 1000).toISOString() : null;
}

/**
 * Идентификатор в виде строки из чего угодно (BigInt/BigInteger/число/обёртка).
 * @param {unknown} value
 * @returns {string|null}
 */
export function idToString(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number" || typeof value === "string") return String(value);
    if (isBigIntegerLike(value)) return value.toString();
    if (typeof value.value !== "undefined") return idToString(value.value);
    return String(value);
}
