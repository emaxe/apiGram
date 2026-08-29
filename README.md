# apiGram

Multi-user Telegram API gateway (MTProto) — REST + WebSocket.

## Установка
npm install

## Запуск
cp .env.example .env   # задайте TELEGRAM_API_ID / TELEGRAM_API_HASH
npm start

## Быстрый старт (curl)
# 1. Создать аккаунт
curl -X POST http://127.0.0.1:3111/v1/accounts -H 'content-type: application/json' -d '{"name":"my"}'
#    -> { accountId, apiToken }
# 2. Логин: телефон → код → (2FA)
curl -X POST .../accounts/:id/auth/send-code -H "Authorization: Bearer $TOKEN" -d '{"phone":"+7999"}'
curl -X POST .../auth/verify-code -H "Authorization: Bearer $TOKEN" -d '{"code":"12345"}'
#    -> { next:"done", me:{...} }  (или { next:"password" })
curl -X POST .../auth/password -H "Authorization: Bearer $TOKEN" -d '{"password":"..."}'
# 3. Отправить сообщение
curl -X POST .../chat/@username/messages -H "Authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"text":"hello"}'
# 4. WebSocket для realtime
# ws://127.0.0.1:3111/v1/ws?accountId=:id&token=:token

## Эндпоинты
(см. docs/superpowers/specs/2026-08-29-apigram-design.md)
