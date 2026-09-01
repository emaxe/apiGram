/**
 * Замер выдачи файла.
 *
 * Живёт отдельным модулем не ради красоты: «видео грузится долго» — это три
 * разные поломки с одинаковым видом снаружи. Долгое описание означает лишний
 * поход в Telegram перед первым байтом; долгий первый байт — задержку до
 * дата-центра; низкая скорость при быстром старте — узкий канал или слишком
 * мелкие куски. Без разбивки выбор лечения — гадание.
 */

/**
 * Строка замера одной выдачи файла.
 *
 * @param {{msgId: number, status: number, bytes: number, openMs: number,
 *          ttfbMs: number|null, totalMs: number}} sample
 * @returns {string}
 */
export function formatMediaTiming({ msgId, status, bytes, openMs, ttfbMs, totalMs }) {
    const parts = [
        `media msg=${msgId}`,
        `status=${status}`,
        `bytes=${bytes}`,
        `open=${Math.round(openMs)}ms`,
    ];
    // Первого байта у HEAD и 416 не бывает вовсе — пустое поле в журнале
    // читается как ноль, то есть как мгновенный ответ.
    if (ttfbMs !== null && ttfbMs !== undefined) parts.push(`ttfb=${Math.round(ttfbMs)}ms`);
    parts.push(`total=${Math.round(totalMs)}ms`);
    // Скорость по нулевому телу — не ноль, а бессмыслица: считать её не из
    // чего, а в журнале «0.0MB/s» выглядит как оборванный канал.
    if (bytes > 0 && totalMs > 0) {
        const rate = bytes / 1048576 / (totalMs / 1000);
        parts.push(`rate=${rate.toFixed(1)}MB/s`);
    }
    return parts.join(" ");
}
