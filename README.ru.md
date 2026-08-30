# apiGram

[![npm version](https://img.shields.io/npm/v/apigram.svg)](https://www.npmjs.com/package/apigram)
[![node](https://img.shields.io/node/v/apigram.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/apigram.svg)](./LICENSE)

Multi-user Telegram API gateway (MTProto) — REST + WebSocket.

Один процесс держит пул `TelegramClient` по одному на аккаунт; любое клиентское приложение
подключается по HTTP и получает realtime-поток по WebSocket.

**English version: [README.md](./README.md)**

---

## Содержание

- [Установка](#установка)
- [Скрипт `run.sh`](#скрипт-runsh)
- [Переменные окружения](#переменные-окружения)
- [Быстрый старт](#быстрый-старт)
- [Эндпоинты](#эндпоинты)
- [WebSocket](#websocket)
- [Ошибки](#ошибки)
- [Безопасность](#безопасность)
- [Ограничения](#ограничения)
- [Тесты](#тесты)
- [Changelog](#changelog)

## Установка

```bash
npm install apigram
```

Либо склонировать и запустить из исходников:

```bash
git clone https://github.com/emaxe/apiGram.git
cd apiGram
npm install
cp .env.example .env      # задайте TELEGRAM_API_ID / TELEGRAM_API_HASH
npm start
```

Ключи API — на https://my.telegram.org → API development tools.

При установке пакетом шлюз доступен и как бинарник:

```bash
npx apigram
```

Требуется Node.js >= 18.

### Скрипт `run.sh`

В репозитории есть интерактивный помощник, покрывающий все режимы:

```bash
./run.sh              # меню
./run.sh <команда>    # прямой вызов, напр. ./run.sh dev
```

| Команда | Действие |
|---|---|
| `install` | `npm ci` (по lock-файлу) или `npm install` |
| `start` | запуск сервера с проверкой `.env`, зависимостей и занятости порта |
| `dev` | запуск с автоперезапуском (`node --watch src/index.js`) |
| `test` | юнит-тесты |
| `smoke` | сквозная проверка на живом аккаунте (`scripts/smoke.mjs`) |
| `env` | показать конфигурацию с маскированием секретов, создать `.env` из примера |
| `health` | `GET /v1/health` по адресу из `.env` |
| `doctor` | диагностика: версия Node, зависимости, ключи, каталог данных, порт |
| `clean` | удаление `node_modules` или лога обновлений |

Адрес для `start`/`health`/`smoke` берётся из `.env`, а не задан жёстко. `clean` не трогает
`data/accounts.json` — там сессии Telegram.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | — | обязательны |
| `HOST` / `PORT` | `127.0.0.1` / `3111` | адрес прослушивания |
| `ADMIN_TOKEN` | пусто | требуется для `POST /v1/accounts`; пусто = эндпоинт открыт (только для localhost) |
| `DATA_DIR` | `./data` | реестр аккаунтов и лог обновлений (режим `0600`) |
| `LOG_UPDATES` | `false` | писать поток обновлений в `data/updates.jsonl` |
| `UPDATES_MAX_MB` | `50` | порог ротации лога |

## Быстрый старт

```bash
BASE=http://127.0.0.1:3111/v1

# 1. Создать аккаунт — apiToken показывается один раз
curl -X POST $BASE/accounts -H 'content-type: application/json' -d '{"name":"my"}'
# -> { "accountId": "acc_…", "apiToken": "tok_…", "status": "no_session" }

ACC=acc_…; TOKEN=tok_…
AUTH="Authorization: Bearer $TOKEN"

# 2. Логин: телефон → код → (2FA, если включён)
curl -X POST $BASE/accounts/$ACC/auth/send-code   -H "$AUTH" -H 'content-type: application/json' -d '{"phone":"+79991234567"}'
curl -X POST $BASE/accounts/$ACC/auth/verify-code -H "$AUTH" -H 'content-type: application/json' -d '{"code":"12345"}'
# -> { "next": "done", "me": {…} }  либо  { "next": "password" }
curl -X POST $BASE/accounts/$ACC/auth/password    -H "$AUTH" -H 'content-type: application/json' -d '{"password":"…"}'

# 3. Отправить сообщение
curl -X POST $BASE/accounts/$ACC/chat/@username/messages -H "$AUTH" -H 'content-type: application/json' -d '{"text":"hello"}'

# 4. Отправить файлы (до 10 за раз, поле формы — files)
curl -X POST $BASE/accounts/$ACC/chat/@username/files -H "$AUTH" -F files=@photo.jpg -F caption=Привет
```

## Эндпоинты

Все, кроме `POST /v1/accounts` и `GET /v1/health`, требуют `Authorization: Bearer <apiToken>`.

```
GET    /v1/health                                     проверка живости

# Аккаунты и авторизация
POST   /v1/accounts                                   создать аккаунт (ADMIN_TOKEN, если задан)
GET    /v1/accounts                                   свои аккаунты
DELETE /v1/accounts/:id                               удалить аккаунт
POST   /v1/accounts/:id/auth/send-code                { phone } → код
POST   /v1/accounts/:id/auth/verify-code              { code } → { next: "done"|"password" }
POST   /v1/accounts/:id/auth/password                 { password } — 2FA
POST   /v1/accounts/:id/auth/logout                   логаут (сессия отзывается в Telegram)
GET    /v1/accounts/:id/auth/status                   { status, next?, me? }

# Профиль
GET    /v1/accounts/:id/me                            getMe
POST   /v1/accounts/:id/me                            JSON { firstName, lastName, about }
                                                      либо multipart с полем avatar
GET    /v1/accounts/:id/status                        { online, status }
POST   /v1/accounts/:id/status                        { online } — присутствие

# Диалоги и чаты
GET    /v1/accounts/:id/dialogs?limit&archived&query
GET    /v1/accounts/:id/chat/:peer                    информация о чате
GET    /v1/accounts/:id/chat/:peer/history?limit&offsetId&reverse

# Сообщения
POST   /v1/accounts/:id/chat/:peer/messages           { text, replyTo? }
POST   /v1/accounts/:id/chat/:peer/files              multipart: files[], caption, replyTo, forceDocument
PATCH  /v1/accounts/:id/chat/:peer/messages/:msgId    { text }
DELETE /v1/accounts/:id/chat/:peer/messages?ids=1,2&revoke=true
POST   /v1/accounts/:id/chat/:peer/messages/:msgId/react   { emoji }
POST   /v1/accounts/:id/chat/:peer/read               { maxId }
POST   /v1/accounts/:id/chat/:peer/forward            { ids, fromPeer }
GET    /v1/accounts/:id/chat/:peer/messages/:msgId/file    скачать медиа
```

`:peer` — `@username`, `username`, числовой ID (`-1001234567890`) или `me`.
Значение подставляйте через `encodeURIComponent`.

## WebSocket

```
ws://127.0.0.1:3111/v1/ws?accountId=<id>&token=<apiToken>
```

Подключение поднимает клиента Telegram для аккаунта, если он ещё не поднят.
Один аккаунт может держать несколько сокетов — поток получают все.

События (`JSON`, все с `accountEvent: true`):

| `type` | Полезная нагрузка |
|---|---|
| `connected` | `accountId` — подтверждение подписки |
| `new_message` / `edited_message` | `message` — нормализованное сообщение |
| `deleted_messages` | `peerId`, `deletedIds` |
| `typing` | `chatId`, `userId`, `action` |
| `read_inbox` | `peerId`, `maxId` |
| `session_closed` | `reason` — логаут, сокет закрывается кодом `4003` |
| `error` | `error` — сессия недоступна, сокет закрывается кодом `4002` |

Коды закрытия: `4001` — неверный токен или аккаунт не авторизован,
`4002` — сессия недоступна, `4003` — логаут.

## Ошибки

`{ error, message, step?, hint?, seconds? }`.

| Статус | Когда |
|---|---|
| 400 | неверные данные или нарушен порядок шагов логина (`step` укажет шаг) |
| 401 | нет/неверный `apiToken` |
| 403 | нет доступа к чату |
| 404 | чат, сообщение или медиа не найдены |
| 409 | аккаунт не авторизован или сессия отозвана |
| 429 | `flood_wait`, в `seconds` — сколько ждать |

## Безопасность

- **Сессия — это учётные данные.** В `data/accounts.json` лежат `sessionString`, дающие полный
  доступ к аккаунтам Telegram. Файл пишется с правами `0600`, весь каталог `data/` в
  `.gitignore`. Не коммитьте его и не кладите в синхронизируемую папку.
- **`ADMIN_TOKEN` закрывает создание аккаунтов.** Пока он пуст, `POST /v1/accounts` открыт всем,
  кто достучится до порта. Это допустимо только на `127.0.0.1`; при старте на другом адресе без
  токена сервер печатает предупреждение.
- **`apiToken` показывается ровно один раз** — в ответе `POST /v1/accounts`. Восстановить его
  нельзя: потеряли токен — удаляйте аккаунт и создавайте заново.
- **`LOG_UPDATES=true` пишет тексты сообщений на диск** (`data/updates.jsonl`). По умолчанию
  выключено; включайте, только если действительно нужен журнал.
- **Ни TLS, ни CORS.** Перед выставлением наружу ставьте шлюз за обратный прокси.

## Ограничения

- Сессии хранятся в `StringSession` без кэша сущностей: после рестарта обращение к чату
  по числовому ID может вернуть `peer_not_found` — сначала вызовите `GET /dialogs`,
  это прогреет кэш.
- Регистрация новых номеров, звонки, секретные чаты и вход по email не поддерживаются.
- CORS не настроен: браузерный клиент требует прокси.

## Тесты

```bash
npm test
```

Внимание: тесты реестра сейчас пишут в боевой `data/accounts.json` (см. `test/unit.test.js`).

## Changelog

См. [CHANGELOG.md](./CHANGELOG.md).

## Лицензия

ISC
