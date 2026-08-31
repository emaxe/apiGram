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
- [Браузерные клиенты](#браузерные-клиенты)
- [Прокси](#прокси)
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
| `CORS_ORIGINS` | пусто | источники, которым разрешены браузерные запросы (через запятую); пусто = CORS выключен |
| `PROXY_URL` | пусто | прокси для MTProto: `socks5://`, `socks4://`, `http://`, `https://`, `mtproxy://`; пусто = прямое подключение |
| `PROXY_TIMEOUT` | `5` | таймаут подключения к прокси, секунды |
| `PROXY_FROM_ENV` | `false` | при пустом `PROXY_URL` брать прокси из `https_proxy` → `all_proxy` → `http_proxy` (регистр любой) |

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
GET    /v1/accounts/:id/chat/:peer/messages/:msgId/file    скачать медиа (Range)
GET    /v1/accounts/:id/chat/:peer/messages/:msgId/thumb?size=s|m   превью (ETag)
```

`:peer` — `@username`, `username`, числовой ID (`-1001234567890`) или `me`.
Значение подставляйте через `encodeURIComponent`.

### Медиа

`GET …/messages/:msgId/file` отдаёт файл потоком и понимает `Range`: ответ на
диапазон — `206` с `Content-Range`, на запрос за пределами файла — `416`.
Одновременных загрузок на аккаунт не больше двух, остальные ждут очереди.
Оборвавшееся соединение прекращает и загрузку из Telegram.

`GET …/messages/:msgId/thumb?size=s|m` отдаёт JPEG-обрезку: `s` — самую
мелкую, `m` — самую крупную из доступных. У ответа сильный `ETag`; при
совпадении `If-None-Match` возвращается `304`, и обрезка не качается из
Telegram вовсе. У вложения без обрезок — `404 no_thumb`; мгновенное размытое
превью в этом случае лежит прямо в сообщении, в поле `media.stripped`.

Само сообщение теперь описывает вложение целиком: `media.{kind, mimeType,
fileName, size, width, height, duration, waveform, thumbs, stripped,
downloadable}`. Размеры известны до загрузки — заглушку можно нарисовать
сразу. Рядом появились `chatId` (всегда маркированный), `groupedId`
(альбомы), `fwdFrom`, `viaBotId` и `senderName`.

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
| `read_inbox` | `peerId`, `maxId` — мы прочитали чужие сообщения |
| `read_outbox` | `peerId`, `maxId` — собеседник прочитал наши |
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
| 502 | прокси отказал или оборвал туннель (`proxy_unreachable`, `proxy_auth_required`, `proxy_forbidden`, `proxy_connect_failed`, `proxy_protocol_error`) |
| 504 | `proxy_timeout` — прокси не ответил за `PROXY_TIMEOUT` |

## Браузерные клиенты

По умолчанию CORS выключен, и ни одна веб-страница обратиться к шлюзу не может.
Это состояние по умолчанию выбрано осознанно: шлюз держит боевые сессии Telegram.

Чтобы разрешить веб-клиента, перечислите источники:

```bash
CORS_ORIGINS=http://127.0.0.1:8080
```

Список, а не `*`. При пустом `ADMIN_TOKEN` эндпоинт `POST /v1/accounts` открыт,
поэтому со звёздочкой любая посещённая пользователем страница смогла бы создавать
аккаунты на его локальном шлюзе. Значение `*` поддержано, но выводит предупреждение
при старте.

Проверка `Origin` распространяется и на WebSocket: правила CORS на рукопожатие
не действуют, поэтому источник сверяется вручную. Клиенты, не присылающие
`Origin` (`curl`, мобильные и десктопные сборки, `scripts/smoke.mjs`),
работают как прежде — ни проверка, ни заголовки их не касаются.

## Прокси

MTProto можно пустить через прокси. Одна переменная покрывает все схемы; авторизация везде
опциональна, спецсимволы в пароле кодируются percent-encoding (`@` → `%40`, `:` → `%3A`):

```bash
PROXY_URL=socks5://user:pass@127.0.0.1:1080   # и socks4://
PROXY_URL=http://user:pass@127.0.0.1:3128     # HTTP CONNECT
PROXY_URL=https://127.0.0.1:8443              # то же, но TLS до самого прокси
PROXY_URL=mtproxy://<секрет>@1.2.3.4:443      # прокси Telegram (или ?secret=…)
PROXY_TIMEOUT=5                               # таймаут подключения, секунды
```

`socks4`/`socks5` и `mtproxy` идут штатным транспортом teleproto. `http`/`https` библиотека не
умеет вовсе, поэтому реализованы здесь — туннелем `CONNECT` поверх `node:net` / `node:tls`, без
новых зависимостей. Самоподписанный сертификат прокси принимается только по явному
`https://host:8443?insecure=1`.

Прокси общий: через него ходят все аккаунты, включая скачивание медиа из других
дата-центров. Битое значение роняет старт, а не откатывается молча на прямое соединение —
это была бы утечка настоящего IP. Пароль и секрет MTProxy в логи не попадают никогда.

Системные `https_proxy` / `all_proxy` / `http_proxy` читаются только при
`PROXY_FROM_ENV=true`, в этом порядке и в любом регистре; `PROXY_URL` в любом случае важнее.
Включение явное, потому что такие переменные часто выставлены в шелле для посторонних задач,
а шлюз с боевыми сессиями Telegram не должен уходить туда молча. В строке при старте видно,
из какой переменной взяты настройки:

```
apiGram proxy: socks5://10.0.0.9:1080 (без авторизации) (из all_proxy, таймаут 5 с)
```

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
- **Нет TLS.** Перед выставлением наружу ставьте шлюз за обратный прокси.
  CORS есть, но по умолчанию выключен — см. «Браузерные клиенты».

## Ограничения

- Сессии хранятся в `StringSession` без кэша сущностей: после рестарта обращение к чату
  по числовому ID может вернуть `peer_not_found` — сначала вызовите `GET /dialogs`,
  это прогреет кэш.
- Регистрация новых номеров, звонки, секретные чаты и вход по email не поддерживаются.
- Прокси общий: все аккаунты ходят через одно соединение, настройки на аккаунт нет.
- Системные `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY` игнорируются, пока не выставлен
  `PROXY_FROM_ENV=true`. Их часто задают в шелле для посторонних задач, и боевые сессии
  Telegram не должны уходить туда молча; `PROXY_URL` в любом случае важнее. В строке при
  старте видно, из какой переменной взяты настройки.
- HTTP-прокси обязан поддерживать `CONNECT`; прокси, разрешающие его только на порт 443,
  отвечают `proxy_forbidden`. Ошибки прокси отдаются как `502` (`504` при таймауте).
- У `mtproxy://` нет собственного таймаута подключения: teleproto на этом пути игнорирует
  `PROXY_TIMEOUT`, и мёртвый MTProxy держит соединение до таймаута ОС (~75 с).
- CORS по умолчанию выключен: браузерный клиент не достучится до шлюза, пока его источник
  не перечислен в `CORS_ORIGINS` — см. «Браузерные клиенты».

## Тесты

```bash
npm test
```

Внимание: тесты реестра сейчас пишут в боевой `data/accounts.json` (см. `test/unit.test.js`).

## Changelog

См. [CHANGELOG.md](./CHANGELOG.md).

## Лицензия

ISC
