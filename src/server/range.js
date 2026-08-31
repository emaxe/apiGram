/**
 * Разбор заголовка `Range` для отдачи медиа.
 *
 * Живёт в HTTP-слое намеренно: Telegram про диапазоны ничего не знает, это
 * договорённость между шлюзом и плеером на клиенте.
 */

/**
 * Разбирает `Range` в границы байтов.
 *
 * Возвращает `null`, если диапазона нет или он нам непонятен — тогда законный
 * ответ — весь файл целиком с кодом 200. Возвращает `"unsatisfiable"`, если
 * диапазон осмысленный, но лежит за пределами файла: на такой запрос нужен
 * 416, потому что пустой 206 плеер принимает за конец файла и останавливается.
 *
 * @param {string|undefined} header значение заголовка Range
 * @param {number|null} size полный размер файла в байтах
 * @returns {{start: number, end: number}|"unsatisfiable"|null}
 */
export function parseRange(header, size) {
    if (!header || typeof header !== "string") return null;
    // Размер файла неизвестен — от чего считать конец и суффикс, непонятно.
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return null;

    const match = /^bytes=(.*)$/i.exec(header.trim());
    if (!match) return null;
    const spec = match[1].trim();
    // Составные диапазоны требуют multipart/byteranges. Отдать весь файл
    // честнее, чем отдать первый кусок и выдать его за весь ответ.
    if (spec.includes(",")) return null;

    const parts = /^(\d*)-(\d*)$/.exec(spec);
    if (!parts) return null;
    const [, rawStart, rawEnd] = parts;

    let start;
    let end;
    if (rawStart === "") {
        // Суффиксная форма «последние N байт».
        if (rawEnd === "") return null;
        const suffix = Number(rawEnd);
        if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(rawStart);
        if (!Number.isFinite(start)) return null;
        if (start >= size) return "unsatisfiable";
        end = rawEnd === "" ? size - 1 : Number(rawEnd);
        if (!Number.isFinite(end)) return null;
        // Хвост за границей файла подрезается: это не ошибка запроса.
        end = Math.min(end, size - 1);
        if (end < start) return "unsatisfiable";
    }
    return { start, end };
}

/**
 * Статус и заголовки ответа на запрос файла.
 *
 * Собраны отдельно от маршрута намеренно: ошибка здесь не падает, а тихо
 * ломает проигрывание — плеер видит несогласованные длины и либо ждёт байты,
 * которых не будет, либо считает файл закончившимся.
 *
 * @param {{mimeType: string|null, fileName?: string|null, size: number|null}} info
 * @param {{start: number, end: number}|"unsatisfiable"|null} range
 * @returns {{status: number, headers: Record<string, string|number>}}
 */
export function mediaResponseHead(info, range) {
    if (range === "unsatisfiable") {
        // Тела у такого ответа нет — ни типа, ни длины объявлять нечему.
        return { status: 416, headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${info.size}` } };
    }

    const headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": info.mimeType || "application/octet-stream",
    };
    if (info.fileName) {
        // filename* с процентным кодированием — единственная форма, которая
        // доносит кириллицу и эмодзи в имени файла без потерь.
        headers["Content-Disposition"] =
            `attachment; filename*=UTF-8''${encodeURIComponent(info.fileName)}`;
    }

    if (range) {
        headers["Content-Range"] = `bytes ${range.start}-${range.end}/${info.size}`;
        headers["Content-Length"] = range.end - range.start + 1;
        return { status: 206, headers };
    }
    // Нулевую длину не объявляем: клиент читает её как пустой файл. Размер
    // неизвестен — поток закрывается концом соединения.
    if (info.size) headers["Content-Length"] = info.size;
    return { status: 200, headers };
}
