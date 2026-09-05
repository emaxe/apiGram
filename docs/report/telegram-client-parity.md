# Паритет apiGram с официальным клиентом Telegram

Исследование возможностей шлюза [apiGram](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/README.ru.md) в сравнении с полнофункциональными клиентами Telegram (Desktop, Mobile, Web), текущий статус реализации и чеклист для отслеживания прогресса.

---

## 1. Текущее позиционирование проекта

На текущий момент **apiGram** представляет собой **минималистичный многопользовательский шлюз (API Gateway)**:
- REST API под `/v1` для отправки сообщений, файлов, чтения истории и базового управления аккаунтами.
- WebSocket-поток под `/v1/ws` для событий в реальном времени.
- Пул сессий MTProto на базе `teleproto` (один клиент на аккаунт).
- Базовое кэширование медиа-информации и стриминг файлов с поддержкой HTTP `Range`.

Официальные клиенты Telegram развиваются более 10 лет и включают в себя развитую оффлайн-синхронизацию, E2E-шифрование, WebRTC-звонки, поддержку бот-платформы, Stories, форумов и каталогов стикеров.

---

## 2. Чеклист функционала и паритета

### 2.1. Авторизация, сессии и безопасность

- [x] Авторизация по номеру телефона (код из SMS/Telegram): [src/telegram/auth.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/auth.js#L26-L54)
- [x] Поддержка двухфакторной аутентификации (2FA / Cloud Password): [src/telegram/auth.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/auth.js#L56-L84)
- [x] Завершение текущей сессии (Logout) с отзывом в Telegram: [src/telegram/auth.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/auth.js#L86-L95)
- [x] Многопользовательский режим с изоляцией по API-токенам: [src/server/bearer.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/server/bearer.js)
- [ ] Вход по QR-коду (`auth.exportLoginToken`, `auth.acceptLoginToken`)
- [ ] Регистрация новых пользователей (`auth.signUp`)
- [ ] Альтернативные способы получения кода (флеш-звонки, email, SMS-ретрансляция)
- [ ] Управление активными сессиями/устройствами (`account.getAuthorizations`, `account.resetAuthorization`)
- [ ] Смена облачного пароля 2FA и привязка резервного email (`account.updatePasswordSettings`)
- [ ] Настройки приватности (`account.getPrivacy`, `account.setPrivacy`: онлайн, номер, пересылка, фото)
- [ ] Чёрный список пользователей (`contacts.block`, `contacts.unblock`, `contacts.getBlocked`)
- [ ] Самоуничтожение аккаунта по неактивности (`account.setAccountTTL`)

### 2.2. Архитектура MTProto и синхронизация

- [x] Подключение через прокси (SOCKS4/5, MTProxy, HTTP/HTTPS CONNECT): [src/telegram/proxySocket.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/proxySocket.js)
- [x] Пул сессий и переиспользование клиентов: [src/telegram/sessionManager.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/sessionManager.js)
- [x] Корректная сериализация BigInt и TL-структур: [src/telegram/serialize.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/serialize.js)
- [ ] Синхронизация состояния по `pts` / `qts` / `seq` (`updates.getDifference`, `updates.getChannelDifference`)
  > *Сейчас пропущенные за время оффлайна события не доставляются.*
- [ ] Персистентное хранилище кэша сущностей (`Peer/Entity Cache` в SQLite/LevelDB)
  > *Сейчас используется `StringSession`, из-за чего после рестарта требуется прогрев через `/dialogs`.*
- [ ] Секретные чаты с E2E-шифрованием (Diffie-Hellman MTProto E2E)
- [ ] Параллельные соединения к разным DC для медиа (Multi-DC download)

### 2.3. Сообщения и работа с чатами

- [x] Отправка простого текстового сообщения: [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L180-L186)
- [x] Редактирование текста сообщения: [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L189-L192)
- [x] Удаление сообщений (для себя / для всех `revoke`): [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L194-L198)
- [x] Базовый ответ на сообщение (`replyToMsgId`): [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L183)
- [x] Пересылка сообщений: [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L273-L286)
- [x] Отправка реакций (эмодзи): [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L246-L259)
- [x] Отметка о прочтении истории (`markAsRead`): [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L262-L270)
- [x] Получение истории сообщений (`limit`, `offsetId`, `reverse`): [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L149-L170)
- [x] Форматирование текста (Markdown / HTML / `MessageEntity` через `parseMode`): [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L180-L215)
- [x] Цитирование конкретной части текста при ответе (`quoteText`, `quoteOffset`): [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L180-L203)
- [x] Топики и ветки в супергруппах (`forumTopic` / `topMsgId`): [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L180-L203)
- [x] Закрепление и открепление сообщений (`pinMessage`, `unpinMessage`): [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L231-L256)
- [ ] Отложенная отправка сообщений (`scheduleDate`) и просмотр очереди
- [ ] Отправка без звука (`silent`) и отправка «когда адресат будет в сети»
- [ ] Синхронизация черновиков между клиентами (`messages.saveDraft`, `messages.getAllDrafts`)
- [ ] Пересылка без указания авторства (`dropAuthor`)
- [ ] Опросы и викторины (создание, получение результатов, голосование)
- [ ] Полноценный поиск по сообщениям (глобальный `searchGlobal` и контекстный в чате по фильтрам медиа/дат)

### 2.4. Медиа, файлы и стикеры

- [x] Отправка файлов и альбомов (до 10 файлов за раз): [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L295-L330)
- [x] Потоковое скачивание файлов с поддержкой HTTP `Range`: [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L475-L495)
- [x] Скачивание превью (thumbs) с `ETag` и `304 Not Modified`: [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L540-L580)
- [x] Скачивание аватаров пользователей, чатов и каналов (`GET /chat/:peer/avatar`): [src/telegram/messages.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/messages.js#L258-L293)
- [x] Ограничение конкурентных загрузок на аккаунт (download gate): [src/telegram/media.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/media.js)
- [ ] Потоковая чанковая отправка больших файлов (до 2 ГБ / 4 ГБ) без вычитки всего файла в RAM (`upload.saveBigFilePart`)
- [ ] Отправка голосовых сообщений с атрибутами аудио (`voice: true`, `waveform`)
- [ ] Отправка видеосообщений («кружочков» `videoNote`)
- [ ] Поддержка стикеров (TGS Lottie, WebM, WebP) и каталогов стикеров (`messages.getStickerSet`)
- [ ] Кастомные эмодзи (Telegram Premium)
- [ ] Управление превью ссылок (Link Previews: размер превью, отключение `noWebpage`)
- [ ] Преобразование голосовых в текст (Voice-to-Text для Premium)

### 2.5. Диалоги, чаты, каналы и контакты

- [x] Получение списка диалогов (активные/архив, пагинация, фильтр): [src/telegram/dialogs.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/dialogs.js#L85-L106)
- [x] Границы прочитанного в диалогах (`readInboxMaxId`, `readOutboxMaxId`): [src/telegram/dialogs.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/dialogs.js#L33-L34)
- [x] Получение информации о чате/пользователе: [src/telegram/dialogs.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/dialogs.js#L52-L70)
- [x] Редактирование своего профиля (имя, био, аватар): [src/telegram/profile.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/profile.js#L26-L50)
- [x] Установка онлайн/оффлайн статуса присутствия: [src/telegram/profile.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/profile.js#L53-L59)
- [ ] Папки чатов / фильтры (`messages.getDialogFilters`, создание, обновление)
- [ ] Создание групп и каналов (`messages.createChat`, `channels.createChannel`)
- [ ] Управление администраторами и правами (`channels.editAdmin`, `channels.editBanned`)
- [ ] Список участников чата с фильтрами (`channels.getParticipants`)
- [ ] Пригласительные ссылки и заявки на вступление (Join Requests)
- [ ] Синхронизация контактов (`contacts.getContacts`, `contacts.importContacts`)
- [ ] Настройки медленного режима (Slow Mode) и разрешенных реакций в канале

### 2.6. Боты, клавиатуры и интерактивность

- [ ] Обработка и рендеринг инлайн-кнопок (`InlineKeyboardMarkup`, `ReplyKeyboardMarkup`)
- [ ] Нажатие на инлайн-кнопки (`messages.getBotCallbackAnswer` / callback data)
- [ ] Инлайн-режим ботов (`messages.getInlineBotResults`, отправка результата)
- [ ] Запуск Telegram Mini Apps (Web Apps, генерация `initData`)
- [ ] Работа с бот-командами и меню (`botInfo`, `botCommands`)

### 2.7. WebSocket (Real-time события)

- [x] Новое сообщение (`new_message`): [src/telegram/listener.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/listener.js#L148-L153)
- [x] Редактирование сообщения (`edited_message`): [src/telegram/listener.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/listener.js#L155-L159)
- [x] Удаление сообщений (`deleted_messages`): [src/telegram/listener.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/listener.js#L161-L163)
- [x] Индикатор набора текста (`typing`): [src/telegram/listener.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/listener.js#L40-L49)
- [x] Статусы прочтения (`read_inbox`, `read_outbox`): [src/telegram/listener.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/listener.js#L51-L69)
- [x] Обновление реакций на сообщениях (`reactions`): [src/telegram/listener.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/listener.js#L71-L85)
- [x] Изменение онлайн-статуса пользователей (`user_status`): [src/telegram/listener.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/listener.js#L98-L110)
- [x] Закрепление / открепление сообщений (`pinned_messages`): [src/telegram/listener.js](file:///Users/maksimklisin/Desktop/_JS/eFabrika/apiGram/src/telegram/listener.js#L87-L96)
- [ ] Обновление информации о чате / аватарки чата (`UpdateChat`, `UpdateChannel`)
- [ ] Черновики в реальном времени (`UpdateDraftMessage`)

### 2.8. Звонки и медиа-сервисы

- [ ] 1-on-1 голосовые и видеозвонки (MTProto VoIP signaling + WebRTC)
- [ ] Групповые голосовые чаты и видеоконференции в каналах/группах (WebRTC Group Calls)
- [ ] Истории (Telegram Stories: загрузка, просмотр, реакция)
- [ ] Платежи, Telegram Stars и подарки
- [ ] Бусты каналов (Channel Boosts)

---

## 3. Рекомендуемый роадмап для развития шлюза

Если цель — сделать из **apiGram** надёжную платформу для создания полноценных Telegram-клиентов (Web / Desktop / Mobile), рекомендуется внедрять недостающий функционал по фазам:

### Фаза 1: Качество базовой переписки (Выполнено ✅)
1. [x] **Поддержка entities и Markdown/HTML:** добавлена поддержка `parseMode` в `sendMessage` и `editMessage`.
2. [x] **Скачивание аватаров чатов и контактов:** эндпоинт `GET /chat/:peer/avatar` с ETag и кэшированием.
3. [x] **Цитаты и форумы:** поддержка `quoteText`, `quoteOffset` и `topMsgId` (ветки супергрупп).
4. [x] **Закрепление сообщений:** эндпоинты `POST /chat/:peer/messages/:msgId/pin`, `DELETE /chat/:peer/messages/:msgId/pin` и `DELETE /chat/:peer/pin`.
5. [x] **WS-события:** реакции (`reactions`), закрепление (`pinned_messages`), онлайн-статус (`user_status`).

### Фаза 2: Надёжность и транспорт (Reliability)
1. **Синхронизация по `pts`:** хранение `pts` и вызов `updates.getDifference` при переподключении/рестарте.
2. **Персистентный кэш сущностей:** сохранение пар `peerId -> accessHash` на диск для мгновенного резолва без `/dialogs`.
3. **Потоковая отправка файлов:** стриминг больших файлов напрямую в Telegram частями (`upload.saveBigFilePart`).
1. **Синхронизация по `pts`:** хранение `pts` и вызов `updates.getDifference` при переподключении/рестарте.
2. **Персистентный кэш сущностей:** сохранение пар `peerId -> accessHash` на диск для мгновенного резолва без `/dialogs`.
3. **Потоковая отправка файлов:** стриминг больших файлов напрямую в Telegram частями (`upload.saveBigFilePart`).

### Фаза 3: Интерактивность и боты (Platform)
1. **Инлайн-клавиатуры:** обработка нажатий на кнопки (`callback_data`) через `POST /chat/:peer/messages/:msgId/callback`.
2. **Расширенные события WS:** реакции, статусы онлайна собеседников, изменения чатов.
3. **Голосовые и видео-заметки:** эндпоинты для отправки voice с waveform и video note.

### Фаза 4: Управление и администрирование (Full Client)
1. **Папки чатов:** синхронизация `dialogFilters`.
2. **Вход по QR-коду:** генерация и подтверждение токена логина.
3. **Администрирование групп:** права, бан, участники, инвайты.
