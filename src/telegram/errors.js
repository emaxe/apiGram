/**
 * Ошибка протокольного слоя с машиночитаемым кодом. HTTP-статусы слой `telegram/`
 * не знает — их проставляет `server/http.js` по коду.
 */
export class ProtocolError extends Error {
    /**
     * @param {string} code машиночитаемый код (`peer_not_found`, `not_authorized`, ...)
     * @param {string} message человекочитаемое сообщение
     * @param {{ step?: string, hint?: string, cause?: unknown }} [opts]
     */
    constructor(code, message, { step, hint, cause } = {}) {
        super(message);
        this.name = "ProtocolError";
        this.code = code;
        if (step) this.step = step;
        if (hint) this.hint = hint;
        if (cause !== undefined) this.cause = cause;
    }
}
