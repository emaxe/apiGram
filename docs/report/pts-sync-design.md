# Персистентность pts/qts/seq (Фаза 2 паритета с Telegram)

Статус: одобрено, готово к плану реализации.
Связано: [docs/report/telegram-client-parity.md](./telegram-client-parity.md) — раздел 2.2, пункт «Синхронизация состояния по pts/qts/seq».

## 1. Проблема

После рестарта шлюза события, пришедшие в Telegram, пока процесс был выключен, теряются
безвозвратно. Причина — не в протоколе (`teleproto` уже реализует полноценную
pts/qts/seq-синхронизацию в процессе, см. ниже), а в том, что это состояние живёт только
в памяти и обнуляется при каждом новом подключении клиента.

## 2. Что уже даёт teleproto (не переизобретаем)

`teleproto` (форк gramjs), `client/updates/manager.js` (`UpdateManager`) и
`client/updates/composer.js` (`client.updates`, публичный API):

- отслеживает разрывы по `pts`/`qts`/`seq` в реальном времени, буферизует и разруливает
  гонки контейнеров обновлений;
- умеет дозаливать разницу через `updates.getDifference` (`client.updates.catchUp()`);
- сам восстанавливается после `PERSISTENT_TIMESTAMP_INVALID` (сбрасывает состояние) и
  `DifferenceTooLong` (частичная потеря с предупреждением в лог) — ничего доделывать не
  нужно;
- сам восстанавливается после 15 минут тишины на соединении (`recoverIfStale`);
- диспатчит довылившиеся при catch-up сообщения как обычные `UpdateNewMessage` /
  `UpdateEditMessage` / … — через тот же путь, что и живые апдейты, значит
  `src/telegram/listener.js` увидит их без изменений.

Дыра ровно одна: `client.updateManager.state` не переживает рестарт процесса.
`_updateLoop` (`client/updates/dispatch.js`) при каждом `connect()` вызывает
`ensureState()`, которая берёт **свежий** `pts` с сервера, если локального состояния ещё
нет — то есть решение всегда «начать с текущего момента», а не «дозалить пропущенное».

## 3. Область (scope)

**Входит:** личные чаты и обычные (не супергруппы/не каналы) группы — общее pts/qts/seq
пространство, `updates.getDifference`.

**Не входит (осознанно, отдельный шаг позже):** супергруппы и каналы. У них отдельное
pts-пространство на канал и отдельный вызов `updates.getChannelDifference`
(`client.updates.watch()`/`watchChannel` в teleproto). Это требует перечисления диалогов,
персистентного per-channel pts и постоянных фоновых поллеров на каждый канал — заметно
дороже и по коду, и по ресурсам. Инфраструктура для этого в teleproto уже есть, так что
следующий шаг будет дешёвым, но сейчас это отдельная задача.

**Ограничение, которое не решается в этом шаге:** WS-клиент подписывается на канал событий
аккаунта (`bus.on("account_event", …)`) уже **после** `await sessionManager.getClient(...)`
(см. `src/server/ws.js`). Если докачка пропущенного происходит внутри этого вызова, событие
в сокет, подключившийся сразу следом, не попадёт — тот же класс ограничения, что уже
описан для `read_outbox` в README («клиент, который в тот момент не слушал — не узнает»).
Не регрессия: просто то же свойство архитектуры теперь верно и для довылившейся истории.
Событие всё равно попадёт в `data/updates.jsonl`, если включён `LOG_UPDATES`.

## 4. Компоненты

### 4.1 `src/telegram/updateState.js` (новый)

Чистый модуль персистентности, без обращений к teleproto:

- `loadUpdateState(accountId)` → `{ pts, qts, date, seq, savedAt } | null`
- `saveUpdateState(accountId, state)` — пишет весь файл (читает, мёржит по `accountId`,
  пишет обратно), атомарно через существующий `writeJson`.
- `deleteUpdateState(accountId)` — вызывается при удалении аккаунта (`deleteAccount`) и
  при logout (`sessionManager.release`), чтобы не оставлять состояние от отозванной сессии.
- Формат хранения: `data/updateState.json`, вид `{ [accountId]: { pts, qts, date, seq,
  savedAt } }`. Отдельный файл, не `accounts.json` — там боевые сессии, а это состояние
  пишется многократно за время работы аккаунта.
- `config.js`: добавить `updateStateFile = path.join(dataDir, "updateState.json")` по
  аналогии с `accountsFile`/`updatesFile`.

### 4.2 Подсев состояния перед подключением

В `sessionManager.#connectClient(account)`, до `client.connect()`:

```js
const persisted = loadUpdateState(account.accountId);
if (persisted) {
    client.updateManager.refreshFromState(persisted); // см. 4.4 — недокументированный метод
}
```

`refreshFromState` — метод `UpdateManager`, не выставленный в публичном `client.updates`,
но обычный метод объекта (см. `.agents/rules/teleproto-api.md` — в проекте уже есть
прецедент прямого обращения к внутренностям `teleproto`, когда публичного API не хватает).
Он синхронно кладёт `state` и инициализирует `globalPts` — важно, что это происходит **до**
`connect()`, потому что `_updateLoop` внутри `connect()` синхронно проверяет `if
(this.state) return;` в `ensureState()` до первого await. Если состояние уже подсеяно,
`ensureState()` не станет запрашивать текущее с сервера и не затрёт наше значение.

### 4.3 Явный catch-up после регистрации слушателя

После `client.connect()`, проверки авторизации и **после**
`startAccountListener(client, channel)` (порядок важен — иначе довылившиеся апдейты уйдут
до того, как на клиенте появятся обработчики):

```js
if (persisted) {
    try {
        await client.updates.catchUp(); // публичный API, гоняет getDifference в цикле сама
    } catch (err) {
        // залогировать и не мешать клиенту нормально стартовать
    }
}
```

Если персистентного состояния не было (первый логин аккаунта) — ничего не меняется,
`ensureState()` как раньше берёт состояние с текущего момента, `catchUp()` не вызывается.

### 4.4 Сохранение состояния во время работы

Мидлварь через `client.updates.use()` (публичный API, видит каждый диспатченный апдейт,
выполняется после `addEventHandler`-обработчиков из `listener.js`):

```js
client.updates.use(async (update, next) => {
    await next();
    scheduleSave(account.accountId, client); // debounce, см. ниже
});
```

- Debounce ~5 секунд на аккаунт: не чаще одного `saveUpdateState` за окно, даже если
  апдейтов много. Политика debounce выносится в чистую функцию
  `shouldFlush(lastSavedAt, now, intervalMs)` в `updateState.js` — тестируема без реальных
  таймеров.
- Безусловный flush (минуя debounce) в `sessionManager.#teardown` — до `disconnect()`,
  пока `client.updates.state` ещё доступен. Покрывает graceful shutdown (`disconnectAll`),
  `detach` и `release` (logout — но см. 4.1, при logout состояние сразу же удаляется, так
  что финальный flush там избыточен, но не вреден: `deleteUpdateState` идёт следом и
  выигрывает).
- Запись в файл оборачивается в try/catch, ошибка только логируется — как и остальная
  фоновая логика в проекте (например, `channelObservers` в `sessionManager.js`: «наблюдатель
  не должен ломать канал»).

## 5. Данные и файлы

| Файл | Что меняется |
|---|---|
| `src/telegram/updateState.js` | новый: `loadUpdateState`, `saveUpdateState`, `deleteUpdateState`, `shouldFlush` |
| `src/config.js` | + `updateStateFile` |
| `src/telegram/sessionManager.js` | `#connectClient`: подсев состояния до `connect()`, `catchUp()` после регистрации слушателя, debounced save через `client.updates.use()`; `#teardown`: безусловный flush |
| `src/telegram/auth.js` или `sessionManager.release` | `deleteUpdateState` при logout |
| `src/registry/accountsFile.js` (`deleteAccount`) либо вызывающий код | `deleteUpdateState` при удалении аккаунта |
| `.agents/rules/teleproto-api.md` | + строка про `updateManager.refreshFromState` как ещё одно недокументированное, но используемое обращение к внутренностям |
| `test/unit.test.js` | юнит-тесты `updateState.js` на временном `DATA_DIR` |
| `docs/report/telegram-client-parity.md` | отметить пункт «Синхронизация состояния по pts/qts/seq» как выполненный (для личек/групп), уточнить, что каналы — отдельно |
| `CHANGELOG.md` | запись о новой фиче |

## 6. Тестирование

- Юнит: `updateState.js` — запись/чтение/удаление на временном `DATA_DIR`; `shouldFlush`
  на граничных значениях интервала без реальных таймеров.
- Проводка через `client.updateManager`/`client.updates.catchUp()` не юнит-тестируется без
  живого MTProto (как и весь остальной `sessionManager` сегодня). Опираемся на
  `scripts/smoke.mjs`: можно дополнить сценарием логин → отправка сообщения себе →
  имитация рестарта (detach + новый `getClient`) → проверка, что сообщение всё равно
  доставлено в канал/лог.
- Ручная проверка: полный рестарт процесса с `LOG_UPDATES=true`, отправка сообщения аккаунту
  во время простоя, проверка `data/updates.jsonl` после следующего обращения к аккаунту.

## 7. Самопроверка спеки

- Плейсхолдеров/TODO нет.
- Внутренних противоречий нет: раздел 3 (scope) согласован с разделом 4 (компоненты) и
  разделом 6 (тесты) — везде явно «личка/группы, не каналы».
- Область достаточно узкая для одного плана реализации.
- Неоднозначностей, требующих выбора «на месте», не осталось: порядок операций в
  `#connectClient`, место debounce, обработка ошибок записи — всё зафиксировано.
