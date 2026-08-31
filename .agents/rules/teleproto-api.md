# Вызовы teleproto

Проект работает через `teleproto@^1.229.0` (форк gramjs). Его высокоуровневые хелперы
местами непригодны, а сигнатуры расходятся с документацией gramjs. Четыре сценария из
спеки в своё время не работали именно из-за вызовов «по памяти».

## Правило

Перед первым вызовом незнакомого метода — открыть его реальную сигнатуру в
`node_modules/teleproto` (`.d.ts` или исходник) и убедиться, что типы аргументов и
поведение при ошибке совпадают с ожиданием. Документация gramjs и обучающие примеры здесь
не источник правды.

## Известные расхождения

| Хотелось | Почему не работает | Что вместо |
|---|---|---|
| `client.signInUser()` для 2FA | сам перехватывает `SESSION_PASSWORD_NEEDED` и без callback'а всегда бросает «Account has 2FA enabled» | raw TL: `Api.auth.SignIn` |
| `client.signInWithPassword(pwd)` | ждёт password **функцией**, не строкой | `account.GetPassword` + `computeCheck` + `Api.auth.CheckPassword` |
| `signInUser` без `onError` | `onError` обязателен; без него неверный код даёт `TypeError` вместо `PHONE_CODE_INVALID` | всегда передавать `onError` |
| `sendFile(peer, {name, buffer})` | простой объект не принимается, падает с «Cannot use [object Object] as file» | заворачивать в `CustomFile` |
| `sendReadAcknowledge()` | метода не существует | `markAsRead(entity, maxId)` |
| `proxy: { type: "http", … }` | поддержаны только SOCKS4/5 и MTProxy; `PromisedNetSockets` бросает «Invalid sockets params» без `socksType` | свой транспорт в `src/telegram/proxySocket.js` через опцию `networkSocket` |

`src/telegram/proxySocket.js` наследуется от `PromisedNetSockets` и опирается на его
внутренние поля (`chunks`, `headOffset`, `available`, `canRead`, `resolveRead`, `closed`,
`client`). При обновлении teleproto сверять `extensions/PromisedNetSockets.js` — сквозные
тесты прокси в `test/unit.test.js` упадут, если апстрим их переименует.

## Сериализация

Ответы TL содержат `BigInt` и классы `Api.*`, которые `JSON.stringify` не переваривает.
Всё, что уходит в HTTP-ответ или в сокет, проходит через `src/telegram/serialize.js`
(`toPlain` / `stringify`). Не сериализовать TL-объекты напрямую.

## Сессии и слушатели

- Клиент на аккаунт создаётся лениво в `sessionManager.getClient` и переиспользуется.
  Параллельные вызовы для одного аккаунта защищены — не обходить кэш.
- Слушатель обновлений регистрируется только внутри `sessionManager`. Любой новый путь,
  которому нужен поток событий (например, WS-подключение), обязан поднимать клиента через
  `getClient`, иначе события не придут.
- При остановке — `disconnect()`, **не** `logOut()`: логаут отзывает сессию в Telegram, и
  пользователю придётся логиниться заново.
