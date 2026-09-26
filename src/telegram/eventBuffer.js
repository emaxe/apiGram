/**
 * Кольцевой буфер событий аккаунта с монотонным `seq`.
 *
 * WS-клиент переподключается с последним увиденным `seq` (`?since=`) и вправе
 * рассчитывать, что пропущенные события придут при переподключении, а не
 * потеряются молча. Буфер держит только последние `size` событий на аккаунт —
 * дальше это не гарантия доставки, а окно; за его пределами клиенту нужно
 * долить историю через REST (backfill/gap-sync в `fabrika`).
 */

const DEFAULT_SIZE = 500;

export class AccountEventBuffer {
    /** @param {number} [size=DEFAULT_SIZE] */
    constructor(size = DEFAULT_SIZE) {
        this.size = size;
        /** @type {Array<object>} */
        this.events = [];
        this.seq = 0;
    }

    /**
     * Присваивает событию следующий `seq` и кладёт его в буфер. Мутирует и
     * возвращает переданный объект — тот же объект уходит в WS как есть.
     * @param {object} event
     * @returns {object}
     */
    push(event) {
        this.seq += 1;
        event.seq = this.seq;
        this.events.push(event);
        if (this.events.length > this.size) this.events.shift();
        return event;
    }

    /** @returns {number} */
    latestSeq() {
        return this.seq;
    }

    /**
     * Хвост буфера строго после `sinceSeq`.
     * @param {number} sinceSeq
     * @returns {{ events: Array<object>, gap: boolean }} `gap` — часть
     *   событий уже вытеснена из буфера, клиенту нужно долить пропуск через REST.
     */
    tail(sinceSeq) {
        if (sinceSeq > this.seq) {
            // since ссылается на seq, которого этот процесс никогда не производил.
            // Легитимно так быть не может — либо процесс перезапустился и счётчик
            // обнулился, либо since испорчен; в обоих случаях продолжать молча
            // нельзя, иначе всё, что случилось между рестартами, теряется без следа.
            return { events: [], gap: true };
        }
        if (this.events.length === 0) {
            return { events: [], gap: sinceSeq < this.seq };
        }
        const earliest = this.events[0].seq;
        if (sinceSeq < earliest - 1) {
            return { events: this.events.slice(), gap: true };
        }
        return { events: this.events.filter((e) => e.seq > sinceSeq), gap: false };
    }

    /**
     * Подписывает буфер на канал аккаунта первым слушателем (`prependListener`):
     * событие получает `seq` раньше, чем его увидит WS-слушатель, регистрируемый
     * позже, при подключении конкретного сокета.
     * @param {import("node:events").EventEmitter} channel
     * @returns {() => void} функция отписки
     */
    attach(channel) {
        const handler = (event) => this.push(event);
        channel.prependListener("account_event", handler);
        return () => channel.removeListener("account_event", handler);
    }
}
