# apiGram — Дизайн: Multi-user Telegram API Gateway

Дата: 2026-08-29
Статус: утверждён
База: построен на `tgUserbotDemo` и `TuiGram` (оба используют `teleproto`).

## Цель

Полноценный REST + WebSocket API на Node.js поверх MTProto (`teleproto`) для работы
с Telegram от имени **личных аккаунтов** многих пользователей. Каждый пользователь —
отдельный аккаунт со своим `StringSession`, все сессии работают параллельно в одном
процессе. К apiGram можно подключать любое клиентское приложение и полноценно
пользоваться Telegram: авторизация аккаунтов, профиль, диалоги, история, CRUD
сообщений, файлы, реакции, realtime-события.

## Ключевые решения

- **Библиотека:** `teleproto` `^1.229.0` (MTProto, GramJS-форк) — та же, что в обоих
  базовых проектах. Аккаунт виден серверу как в официальном приложении.
- **Параллельность:** один процесс, пул из N `TelegramClient` — по одному на аккаунт,
  каждый со своим `StringSession`. Достаточно на сотни аккаунтов.
- **Интерфейс:** Express (REST) + `ws` (WebSocket-поток обновлений).
- **Авторизация аккаунтов:** пошаговая state-machine через REST
  (`sendCode → verify-code → password`), т.к. в API нет TTY — в отличие от
  интерактивного `client.start()` в TuiGram.
- **Аутентификация клиентов API:** API-токен на аккаунт, `Authorization: Bearer`.
- **Файлы:** multipart/form-data через `multer`.
- **Сессии/реестр:** JSON-файлы с правами `0600`; session = полный доступ к аккаунту.

## Архитектура (слои)

```
src/
├── telegram/            # слой протокола — знает ТОЛЬКО teleproto
│   ├── client.js        # buildClient(sessionString) + assertCredentials
│   ├── sessionManager.js# пул TelegramClient: жизненный цикл, ленивый connect,
│   │                    #   pendingAuth (незавершённый логин), авторизованные
│   ├── auth.js          # step-login: sendCode/signInUser/signInWithPassword,
│   │                    #   logout, status
│   ├── messages.js      # sendMessage/sendFile/editMessage/deleteMessages,
│   │                    #   sendReaction/markAsRead/forward/downloadMedia, история
│   ├── dialogs.js       # iterDialogs, поиск по диалогам
│   ├── profile.js       # getMe, обновление профиля, аватарка, online-статус
│   ├── listener.js      # addEventHandler → канал событий аккаунта (EventEmitter)
│   ├── entities.js      # parsePeer / resolveEntity / idToString / getPeerId
│   └── serialize.js     # toPlain(): BigInt/BigInteger/Buffer/Date → JSON-safe
├── server/              # слой API — знает HTTP/WS, НЕ знает teleproto
│   ├── http.js          # Express app, Bearer-авторизация, монтирование роутера
│   ├── router.js        # REST-эндпоинты, вызов функций telegram/*
│   ├── ws.js            # WebSocket-сервер, подписка на канал аккаунта
│   └── accounts.js      # слой реестра аккаунтов поверх registry/*
├── registry/
│   └── accountsFile.js  # create/read/update/delete аккаунтов, токены (0600)
├── storage/
│   ├── json.js          # readJson/writeJson/ensureDir (0600)
│   └── jsonl.js         # JSONL-лог обновлений с ротацией
├── config.js            # .env, пути, валидация кредов
└── index.js             # точка входа: поднять HTTP + WS, graceful shutdown
```

### Правила границ

- `server/*` не импортируют `teleproto`.
- `telegram/*` не знают про Express/ws.
- `registry/*` и `storage/*` — чистое файловое IO, без teleproto.
- Связка: `sessionManager` отдаёт готовый `TelegramClient`, `server/router.js`
  вызывает функции из `telegram/*`.

## Реестр аккаунтов

Файл `data/accounts.json` (режим 0600):

```json
{
  "accounts": [
    {
      "accountId": "acc_8f3a2b",
      "name": "user@mail",
      "apiToken": "tok_xxxx",
      "phone": "+79991234567",
      "sessionString": "1BQAN....",
      "status": "authorized",
      "auth": { "phoneCodeHash": null, "pendingClient": false },
      "me": { "id": 123, "firstName": "Анна", "username": null }
    }
  ]
}
```

- `accountId` — внутренний ID (не путать с telegram user id), генерируется.
- `apiToken` — секрет клиента для доступа (можно перевыпустить).
- `status`: `no_session` → `code_sent` → `awaiting_2fa` → `authorized`.
- `sessionString` — полный доступ к аккаунту; хранится только 0600, не логируется.

## State-machine авторизации

Состояние между шагами держит `sessionManager.pendingAuth` (полу-готовый клиент с
`phoneCodeHash`), чтобы `authKey` пережил между HTTP-запросами. `session.save()`
записываем только после перехода в `authorized`.

| Шаг | Метод | Действие (teleproto) |
|-----|-------|----------------------|
| 0   | `POST /v1/accounts` | создать аккаунт → `accountId` + `apiToken` |
| 1   | `POST /v1/accounts/:id/auth/send-code` | `client.sendCode()`; `status=code_sent`; хранит hash |
| 2   | `POST /v1/accounts/:id/auth/verify-code` | `client.signInUser()`; если `SESSION_PASSWORD_NEEDED` → `status=awaiting_2fa`, `{next:'password'}`; иначе `session.save()` → `authorized` |
| 3   | `POST /v1/accounts/:id/auth/password` | `client.signInUserWithPassword()`; `session.save()` → `authorized` |
| —   | `POST /v1/accounts/:id/auth/logout` | `client.logOut()`; чистим session → `no_session` |
| —   | `GET  /v1/accounts/:id/auth/status` | `{ status, next?, me? }` |

Обработка `FloodWaitError`: поймать `err.seconds`, спать, повторить (из истории
`tgUserbotDemo`). Ошибки кода/пароля → понятный HTTP-ответ с указанием шага.

## REST-эндпоинты

Все под `Authorization: Bearer <apiToken>` и с префиксом аккаунта.

```
# Аккаунты и авторизация
POST   /v1/accounts                                  создать аккаунт
GET    /v1/accounts                                  список своих аккаунтов
POST   /v1/accounts/:id/auth/send-code               телефон → код
POST   /v1/accounts/:id/auth/verify-code             код → (2FA?)
POST   /v1/accounts/:id/auth/password                пароль 2FA
POST   /v1/accounts/:id/auth/logout                  логаут
GET    /v1/accounts/:id/auth/status                  статус логина

# Профиль
GET    /v1/accounts/:id/me                           getMe
POST   /v1/accounts/:id/me                           update profile (name/bio/avatar)

# Диалоги и история
GET    /v1/accounts/:id/dialogs?limit&archived&query
GET    /v1/accounts/:id/chat/:peer                   entity info
GET    /v1/accounts/:id/chat/:peer/history?limit&offsetId&reverse

# Сообщения (CRUD + файлы + реакции + read + forward)
POST   /v1/accounts/:id/chat/:peer/messages          sendMessage (text/reply)
POST   /v1/accounts/:id/chat/:peer/files             multipart sendFile (+caption)
POST   /v1/accounts/:id/chat/:peer/messages/:msgId/react   sendReaction
PATCH  /v1/accounts/:id/chat/:peer/messages/:msgId   editMessage
DELETE /v1/accounts/:id/chat/:peer/messages          deleteMessages (ids)
POST   /v1/accounts/:id/chat/:peer/read              markAsRead
POST   /v1/accounts/:id/chat/:peer/forward           forwardMessages
GET    /v1/accounts/:id/chat/:peer/messages/:msgId/file  downloadMedia

# Статус
GET    /v1/accounts/:id/status                       online/offline
```

Все ответы проходят через `toPlain()` (BigInt/Buffer/Date-безопасно).

## WebSocket-поток обновлений

- Endpoint: `WS /v1/ws?accountId=...&token=...` (токен проверяется при апгрейде).
- `listener.js` на каждый авторизованный аккаунт регистрирует
  `client.addEventHandler(handler, NewMessage|EditedMessage|DeletedMessage|Raw)`.
- События кладутся в **канал аккаунта** (`EventEmitter` per account), создаваемый
  `sessionManager`. WS-сервер подписывает каждое соединение на канал нужного аккаунта.
- Один аккаунт может иметь несколько WS-клиентов — все получают поток.
- События сериализуются через `toPlain()`. Удаляемые/добавляемые клиенты безопасны.
- Слушатель включается лениво при первом авторизованном соединении и выключается
  при логауте/удалении аккаунта.

## Сериализация и хранение

- `serialize.js:toPlain()` — рекурсивно превращает BigInteger/BigInt/Buffer/Date в
  JSON-безопасные значения и режет живые методы (`reply`/`respond`) — копия логики
  из `tgUserbotDemo`.
- JSONL-лог обновлений с ротацией по размеру (`UPDATES_MAX_MB`, default 50) —
  из `tgUserbotDemo`.
- Сессии и реестр — режим 0600, токены и session-строки не попадают в логи.

## Обработка ошибок

- `FloodWaitError` → сон `seconds+1`, повтор (история/диалоги).
- Ошибки авторизации → HTTP 400 с `{ step, message, hint? }`.
- Неверный/отсутствующий токен → 401. Нет такого аккаунта → 404.
- Разрыв WS-соединения — тихое отписывание, повторное подключение переподписывает.

## Конфигурация (.env)

```
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
HOST=127.0.0.1
PORT=3111
DATA_DIR=./data
UPDATES_MAX_MB=50
```

## Зависимости

`teleproto`, `express`, `ws`, `dotenv`, `multer`. Всё остальное — стандартная Node.
Стиль: чистый ESM, 4 пробела, двойные кавычки, точка с запятой, JSDoc на русском.

## Тестирование

`test/unit.test.js` на `node:assert/strict`, без сети и без аккаунта. Проверяются
чистые функции: `toPlain`, `parsePeer`/`idToString`, реестр аккаунтов
(create/read/update/token), state-machine авторизации на замоканном клиенте,
валидация эндпоинтов/токенов.

## Скоуп MVP («полный функционал»)

Авторизация аккаунтов, профиль, диалоги, история, CRUD сообщений, файлы (multipart),
реакции, markAsRead, forward, online-статус, realtime-события по WebSocket.
Вне скоупа первой версии: звонки, секретные чаты, боты (admin), сложная каталогизация
медиа в базу.
