import { toHttpError } from "../server/httpErrors.js";

/**
 * Оборачивает tool-хендлер: MCP ожидает ошибку инструмента как часть
 * результата (`isError: true`), а не как транспортный сбой. Внутри
 * переиспользуется тот же маппинг кодов и сообщений, что и у REST
 * (`toHttpError`), чтобы агент и HTTP-клиент видели одинаковый текст ошибки.
 * @param {(args: object) => Promise<{content: Array<object>}>} handler
 * @returns {(args: object) => Promise<{content: Array<object>, isError?: true}>}
 */
export function withToolError(handler) {
    return async (args) => {
        try {
            return await handler(args);
        } catch (err) {
            const { body } = toHttpError(err);
            return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
        }
    };
}
