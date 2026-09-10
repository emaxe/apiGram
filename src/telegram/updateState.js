/**
 * Персистентность локального состояния обновлений (`pts`/`qts`/`date`/`seq`)
 * между рестартами шлюза.
 *
 * `teleproto` синхронизирует это состояние в процессе сам (`UpdateManager`,
 * `client.updates`), но хранит его только в памяти: при каждом новом
 * подключении оно обнуляется на текущее, и всё, что пришло за время простоя
 * процесса, теряется безвозвратно. Здесь — только чтение/запись на диск,
 * без обращений к teleproto; проводка в `client.updateManager`/`client.updates`
 * живёт в `sessionManager.js`. См. docs/report/pts-sync-design.md.
 */
import { config } from "../config.js";
import { readJson, writeJson } from "../storage/json.js";

/** Не чаще, чем раз в это окно, пишем состояние на диск при живом потоке апдейтов. */
export const STATE_FLUSH_INTERVAL_MS = 5000;

/**
 * Состояние аккаунта из файла, либо `null`, если ещё не сохранялось.
 * @param {string} accountId
 * @param {string} [filePath]
 * @returns {{ pts: number, qts: number, date: number, seq: number, savedAt: number } | null}
 */
export function loadUpdateState(accountId, filePath = config.updateStateFile) {
    const all = readJson(filePath, {});
    return all[accountId] || null;
}

/**
 * Сохраняет состояние одного аккаунта, не трогая записи остальных — файл общий.
 * @param {string} accountId
 * @param {{ pts: number, qts: number, date: number, seq: number }} state
 * @param {string} [filePath]
 */
export function saveUpdateState(accountId, state, filePath = config.updateStateFile) {
    const all = readJson(filePath, {});
    all[accountId] = {
        pts: state.pts,
        qts: state.qts,
        date: state.date,
        seq: state.seq,
        savedAt: Date.now(),
    };
    writeJson(filePath, all);
}

/**
 * Удаляет состояние аккаунта. Вызывается при logout и при удалении аккаунта —
 * отозванная сессия не должна оставлять на диске мёртвый pts.
 * @param {string} accountId
 * @param {string} [filePath]
 */
export function deleteUpdateState(accountId, filePath = config.updateStateFile) {
    const all = readJson(filePath, {});
    if (!(accountId in all)) return;
    delete all[accountId];
    writeJson(filePath, all);
}

/**
 * Пора ли сбросить состояние на диск: не чаще одного раза за окно.
 * @param {number} lastSavedAt мс эпохи, `0` — ещё не сохраняли
 * @param {number} now мс эпохи
 * @param {number} [intervalMs]
 * @returns {boolean}
 */
export function shouldFlush(lastSavedAt, now, intervalMs = STATE_FLUSH_INTERVAL_MS) {
    return lastSavedAt === 0 || now - lastSavedAt >= intervalMs;
}
