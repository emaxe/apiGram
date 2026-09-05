import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { readJson, writeJson } from "../src/storage/json.js";
import { ensureDir } from "../src/storage/json.js";
import {
    createAccount,
    findAccount,
    findAccountByToken,
    updateAccount,
    deleteAccount,
} from "../src/registry/accountsFile.js";
import { sessionManager } from "../src/telegram/sessionManager.js";
import { authStatus } from "../src/telegram/auth.js";
import { Api } from "teleproto";
import { _downloadPhoto } from "teleproto/client/downloads.js";
import {
    normalizeMessage,
    sendFiles,
    openMedia,
    createMediaOpener,
    streamMedia,
    downloadThumb,
    sendMessage,
    pinMessage,
    unpinMessage,
    downloadAvatar,
} from "../src/telegram/messages.js";
import { describeMedia, chunkPlan, sliceChunks, createDownloadGate, pickThumbType } from "../src/telegram/media.js";
import { parseRange, mediaResponseHead } from "../src/server/range.js";
import { formatMediaTiming } from "../src/server/mediaTiming.js";
import { normalizeDialog } from "../src/telegram/dialogs.js";
import { toPlain } from "../src/telegram/serialize.js";
import { ProtocolError } from "../src/telegram/errors.js";
import { toHttpError } from "../src/server/httpErrors.js";
import { parseOrigins, isOriginAllowed, corsMiddleware } from "../src/server/cors.js";
import { classifyRawUpdate, deletedMessagesEvent } from "../src/telegram/listener.js";
import { DeletedMessage } from "teleproto/events/index.js";
import { createHttpApp } from "../src/server/http.js";
import net from "node:net";
import { parseProxyUrl, describeProxy, pickProxySource } from "../src/telegram/proxyUrl.js";
import {
    buildConnectRequest,
    parseConnectResponse,
    readConnectResponse,
    createProxySocketFactory,
} from "../src/telegram/proxySocket.js";
import { proxyClientOptions } from "../src/telegram/client.js";
import { PromisedNetSockets } from "teleproto/extensions/PromisedNetSockets.js";

test("json: writeJson/readJson round-trip с 0600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apigram-"));
    const file = path.join(dir, "nested", "data.json");
    writeJson(file, { a: 1, b: [2, 3] });
    assert.deepEqual(readJson(file), { a: 1, b: [2, 3] });
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(readJson(path.join(dir, "missing.json"), "def"), "def");
    assert.equal(readJson(path.join(dir, "broken.json")), null);
});

test("registry: create/find/update/delete", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apigram-"));
    const account = createAccount("test");
    assert.ok(account.accountId.startsWith("acc_"));
    assert.ok(account.apiToken.startsWith("tok_"));
    assert.equal(account.status, "no_session");

    const found = findAccount(account.accountId);
    assert.equal(found.accountId, account.accountId);
    assert.equal(found.apiToken, account.apiToken);

    const byToken = findAccountByToken(account.apiToken);
    assert.equal(byToken.accountId, account.accountId);
    assert.equal(findAccountByToken("nope"), undefined);

    updateAccount(account.accountId, { phone: "+7999" });
    assert.equal(findAccount(account.accountId).phone, "+7999");

    assert.equal(deleteAccount(account.accountId), true);
    assert.equal(findAccount(account.accountId), undefined);
    assert.equal(deleteAccount(account.accountId), false);
});

test("sessionManager: channel переиспользуется и переживает release", async () => {
    const c1 = sessionManager.channel("acc_x");
    const c2 = sessionManager.channel("acc_x");
    assert.equal(c1, c2);
    let got = 0;
    c1.on("ping", () => got++);
    c1.emit("ping");
    assert.equal(got, 1);

    // release шлёт терминальное событие, но НЕ выбрасывает канал: иначе
    // подписанные WS-сокеты остались бы на emitter'е, который после повторного
    // логина никто уже не использует.
    const closed = [];
    c1.on("account_event", (e) => closed.push(e));
    await sessionManager.release("acc_x");
    assert.equal(sessionManager.channels.get("acc_x"), c1);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].type, "session_closed");
    sessionManager.channels.delete("acc_x");
});

test("sessionManager: onChannelCreated срабатывает только на новый канал", () => {
    const seen = [];
    sessionManager.onChannelCreated((id) => seen.push(id));
    sessionManager.channel("acc_obs");
    sessionManager.channel("acc_obs");
    assert.deepEqual(seen, ["acc_obs"]);
    sessionManager.channelObservers.length = 0;
    sessionManager.channels.delete("acc_obs");
});

test("auth: authStatus по состояниям", () => {
    assert.deepEqual(authStatus({ status: "authorized", me: { id: "1" } }), {
        status: "authorized",
        me: { id: "1" },
    });
    assert.deepEqual(authStatus({ status: "awaiting_2fa" }), {
        status: "awaiting_2fa",
        next: "password",
    });
    assert.deepEqual(authStatus({ status: "code_sent" }), {
        status: "code_sent",
        next: "code",
    });
    assert.deepEqual(authStatus({ status: "no_session" }), {
        status: "no_session",
        next: "phone",
    });
});

test("messages: normalizeMessage сворачивает даты и peerId", () => {
    const msg = normalizeMessage({
        id: 12,
        date: 1700000000,
        out: true,
        message: "hi",
        peerId: { value: 123 },
        fromId: { userId: 7 },
    });
    assert.equal(msg.id, 12);
    assert.equal(msg.text, "hi");
    assert.equal(msg.out, true);
    assert.equal(msg.peerId, "123");
    assert.equal(msg.fromId, "7");
    assert.ok(msg.date > 0);
    assert.equal(normalizeMessage(null), null);
});

test("messages: normalizeMessage сворачивает entities в JSON-safe", () => {
    const msg = normalizeMessage({
        id: 13,
        message: "@user hi",
        peerId: { value: 1 },
        entities: [
            { className: "MessageEntityMentionName", offset: 0, length: 5, userId: 123456789n },
            { className: "MessageEntityTextUrl", offset: 7, length: 2, url: "https://x.test" },
        ],
    });
    assert.ok(Array.isArray(msg.entities));
    assert.equal(msg.entities.length, 2);
    assert.equal(msg.entities[0].userId, "123456789");
    assert.doesNotThrow(() => JSON.stringify(msg));
});

test("dialogs: normalizeDialog отдаёт компактный объект", () => {
    const d = normalizeDialog({
        id: { value: -100789 },
        entity: { className: "Channel", broadcast: true, title: "Канал" },
        message: { id: 1, date: 1700000000, message: "yep" },
        pinned: true,
    });
    assert.equal(d.id, "-100789");
    assert.equal(d.type, "channel");
    assert.equal(d.title, "Канал");
    assert.equal(d.pinned, true);
    assert.equal(d.lastMessage.text, "yep");
});

test("dialogs: границы прочитанного берутся из сырого TL-объекта", () => {
    // Обёртка teleproto поднимает наверх только unreadCount, поэтому границы
    // читаются из dialog.dialog. Обращение к dialog.readOutboxMaxId молча
    // давало бы undefined, и клиент остался бы без второй галочки.
    const d = normalizeDialog({
        id: { value: 12345 },
        entity: { className: "User", firstName: "Анна" },
        message: { id: 40, date: 1700000000, message: "привет" },
        unreadCount: 3,
        dialog: { readInboxMaxId: 37, readOutboxMaxId: 39 },
    });
    assert.equal(d.readInboxMaxId, 37);
    assert.equal(d.readOutboxMaxId, 39);

    // Сырого объекта может не быть — тогда сведений нет, а не «прочитано».
    const bare = normalizeDialog({ id: { value: 12345 }, entity: {} });
    assert.equal(bare.readInboxMaxId, 0);
    assert.equal(bare.readOutboxMaxId, 0);
});

test("httpErrors: коды ProtocolError → HTTP-статусы, а не тотальный 500", () => {
    const notFound = toHttpError(new ProtocolError("peer_not_found", "Чат не найден."));
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error, "peer_not_found");

    const badCode = toHttpError(new ProtocolError("phone_code_invalid", "Неверный код.", {
        step: "verify-code",
    }));
    assert.equal(badCode.status, 400);
    assert.equal(badCode.body.step, "verify-code");

    const notAuth = toHttpError(new ProtocolError("not_authorized", "Не авторизован.", {
        hint: "send-code",
    }));
    assert.equal(notAuth.status, 409);
    assert.equal(notAuth.body.hint, "send-code");

    const flood = toHttpError(Object.assign(new Error("FLOOD_WAIT_42"), { seconds: 42 }));
    assert.equal(flood.status, 429);
    assert.equal(flood.body.seconds, 42);

    const raw = toHttpError(Object.assign(new Error("boom"), { errorMessage: "CHAT_WRITE_FORBIDDEN" }));
    assert.equal(raw.status, 403);

    assert.equal(toHttpError(new Error("что-то пошло не так")).status, 500);
});

test("serialize: toPlain обезвреживает BigInt, Buffer, Date и методы", () => {
    const plain = toPlain({
        className: "Message",
        id: 5,
        big: 123456789012345678901234567890n,
        buf: Buffer.from("hi"),
        when: new Date("2024-01-02T03:04:05.000Z"),
        reply: () => {},
        _private: "скрыто",
        nested: { arr: [1n, "x"] },
    });
    assert.equal(plain.className, "Message");
    assert.equal(plain.big, "123456789012345678901234567890");
    assert.equal(plain.buf.base64, Buffer.from("hi").toString("base64"));
    assert.equal(plain.when, "2024-01-02T03:04:05.000Z");
    assert.equal("reply" in plain, false);
    assert.equal("_private" in plain, false);
    assert.deepEqual(plain.nested.arr, ["1", "x"]);
    assert.doesNotThrow(() => JSON.stringify(plain));
});

test("messages: sendFiles заворачивает {name, buffer} в CustomFile", async () => {
    const { CustomFile } = await import("teleproto/client/uploads.js");
    let passed;
    const client = {
        getEntity: async () => ({ className: "User", id: 1 }),
        sendFile: async (entity, params) => { passed = params; return [{ id: 1, message: "" }]; },
    };
    await sendFiles(client, "me", [{ name: "a.txt", buffer: Buffer.from("hi") }]);
    // Простой объект teleproto не принимает — раньше сюда уходил {name, buffer}
    // и sendFile падал с "Cannot use [object Object] as file".
    assert.ok(passed.file instanceof CustomFile);
    assert.equal(passed.file.name, "a.txt");
    assert.equal(passed.file.size, 2);

    await sendFiles(client, "me", [
        { name: "a.txt", buffer: Buffer.from("a") },
        { name: "b.txt", buffer: Buffer.from("bb") },
    ]);
    assert.ok(Array.isArray(passed.file));
    assert.ok(passed.file.every((f) => f instanceof CustomFile));

    await assert.rejects(() => sendFiles(client, "me", []), /Не указан ни один файл/);
    await assert.rejects(
        () => sendFiles(client, "me", new Array(11).fill({ name: "x", buffer: Buffer.from("x") })),
        /не больше 10 файлов/
    );
});

// ── CORS ──────────────────────────────────────────────────────────────────────

test("cors: parseOrigins разбирает список и чистит хвостовые слэши", () => {
    assert.deepEqual(parseOrigins("http://a.example , https://b.example/ "), [
        "http://a.example",
        "https://b.example",
    ]);
    assert.deepEqual(parseOrigins(""), []);
    assert.deepEqual(parseOrigins(undefined), []);
    assert.deepEqual(parseOrigins("*"), ["*"]);
});

test("cors: пустой список запрещает всё", () => {
    // Состояние по умолчанию: браузерные клиенты к шлюзу не допускаются.
    assert.equal(isOriginAllowed("http://a.example", []), false);
});

test("cors: источник сверяется точно, поддомен не подходит", () => {
    const allowed = ["http://127.0.0.1:8080"];
    assert.equal(isOriginAllowed("http://127.0.0.1:8080", allowed), true);
    assert.equal(isOriginAllowed("http://127.0.0.1:8080/", allowed), true);
    assert.equal(isOriginAllowed("http://127.0.0.1:9090", allowed), false);
    assert.equal(isOriginAllowed("https://127.0.0.1:8080", allowed), false);
    assert.equal(isOriginAllowed("http://evil.127.0.0.1:8080", allowed), false);
});

test("cors: звёздочка разрешает любой источник", () => {
    assert.equal(isOriginAllowed("https://anything.example", ["*"]), true);
});

/** Минимальная имитация req/res для проверки middleware. */
function fakeExchange({ method = "GET", origin } = {}) {
    const headersSent = {};
    let statusCode = 200;
    let ended = false;
    let nextCalled = false;
    const res = {
        setHeader: (name, value) => { headersSent[name] = value; },
        status(code) { statusCode = code; return res; },
        end() { ended = true; return res; },
    };
    const req = { method, headers: origin ? { origin } : {} };
    return {
        req, res, headers: headersSent,
        get statusCode() { return statusCode; },
        get ended() { return ended; },
        get nextCalled() { return nextCalled; },
        next: () => { nextCalled = true; },
    };
}

test("cors: без заголовка Origin запрос проходит нетронутым", () => {
    // Так ходят не-браузерные клиенты: smoke.mjs, мобильные сборки, curl.
    const x = fakeExchange();
    corsMiddleware(["http://a.example"])(x.req, x.res, x.next);
    assert.equal(x.nextCalled, true);
    assert.deepEqual(x.headers, {});
});

test("cors: разрешённому источнику выдаются заголовки и Vary", () => {
    const x = fakeExchange({ origin: "http://a.example" });
    corsMiddleware(["http://a.example"])(x.req, x.res, x.next);
    assert.equal(x.nextCalled, true);
    assert.equal(x.headers["Access-Control-Allow-Origin"], "http://a.example");
    // Без Vary промежуточный кеш отдал бы заголовки одного источника другому.
    assert.equal(x.headers["Vary"], "Origin");
    // Без этого клиент не прочитает имя и размер скачиваемого вложения.
    assert.match(x.headers["Access-Control-Expose-Headers"], /Content-Disposition/);
});

test("cors: предварительный запрос завершается 204 и не идёт в маршруты", () => {
    const x = fakeExchange({ method: "OPTIONS", origin: "http://a.example" });
    corsMiddleware(["http://a.example"])(x.req, x.res, x.next);
    assert.equal(x.statusCode, 204);
    assert.equal(x.ended, true);
    assert.equal(x.nextCalled, false);
    assert.match(x.headers["Access-Control-Allow-Headers"], /Authorization/);
    assert.match(x.headers["Access-Control-Allow-Methods"], /PATCH/);
});

test("cors: предварительный запрос чужого источника отклоняется", () => {
    const x = fakeExchange({ method: "OPTIONS", origin: "http://evil.example" });
    corsMiddleware(["http://a.example"])(x.req, x.res, x.next);
    assert.equal(x.statusCode, 403);
    assert.equal(x.nextCalled, false);
});

test("cors: обычный запрос чужого источника идёт дальше, но без заголовков", () => {
    // Ответ браузер всё равно не отдаст странице — заголовков разрешения нет.
    const x = fakeExchange({ origin: "http://evil.example" });
    corsMiddleware(["http://a.example"])(x.req, x.res, x.next);
    assert.equal(x.nextCalled, true);
    assert.equal(x.headers["Access-Control-Allow-Origin"], undefined);
});

// ── классификация сырых апдейтов ──────────────────────────────────────────────

test("listener: набор текста превращается в событие typing", () => {
    const event = classifyRawUpdate({
        className: "UpdateUserTyping",
        userId: 1000000002,
        action: { className: "SendMessageRecordAudioAction" },
    });
    assert.equal(event.type, "typing");
    // В личке чата нет — идентификатором служит сам собеседник.
    assert.equal(event.chatId, "1000000002");
    assert.equal(event.userId, "1000000002");
    assert.equal(event.action, "SendMessageRecordAudioAction");
});

test("listener: действие по умолчанию — набор текста", () => {
    const event = classifyRawUpdate({ className: "UpdateChatUserTyping", userId: 5 });
    assert.equal(event.action, "SendMessageTypingAction");
});

test("listener: мы прочитали чужие сообщения — read_inbox", () => {
    const event = classifyRawUpdate({
        className: "UpdateReadHistoryInbox",
        peer: { value: 1000000002 },
        maxId: 512,
    });
    assert.equal(event.type, "read_inbox");
    assert.equal(event.peerId, "1000000002");
    assert.equal(event.maxId, 512);
});

test("listener: собеседник прочитал наши сообщения — read_outbox", () => {
    // Без этого события клиент не может отличить «доставлено» от «прочитано»
    // и вынужден не рисовать вторую галочку вовсе.
    const event = classifyRawUpdate({
        className: "UpdateReadHistoryOutbox",
        peer: { value: 1000000002 },
        maxId: 88213,
    });
    assert.equal(event.type, "read_outbox");
    assert.equal(event.peerId, "1000000002");
    assert.equal(event.maxId, 88213);
    assert.equal(event.accountEvent, true);
});

test("listener: read_outbox канала приходит с маркированным id", () => {
    const event = classifyRawUpdate({
        className: "UpdateReadChannelOutbox",
        channelId: 1500000001,
        maxId: 40,
    });
    assert.equal(event.type, "read_outbox");
    // Канал обязан быть промаркирован: клиент ищет чат именно по такому id.
    assert.equal(event.peerId, "-1001500000001");
});

test("listener: посторонние апдейты отбрасываются", () => {
    assert.equal(classifyRawUpdate({ className: "UpdateSomethingElse" }), null);
    assert.equal(classifyRawUpdate({}), null);
    assert.equal(classifyRawUpdate(null), null);
    assert.equal(classifyRawUpdate(undefined), null);
});

test("health: версия берётся из package.json, а не из строки в коде", async () => {
    // Версию из /v1/health клиент показывает на экране подключения и по ней же
    // сверяет контракт. Зашитая в код копия расходится с настоящей молча,
    // поэтому единственный источник — package.json.
    const expected = JSON.parse(
        fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ).version;

    const server = createHttpApp().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
        const { port } = server.address();
        const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.version, expected);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

// ── описание медиа ────────────────────────────────────────────────────────────

test("media: фотография отдаёт размеры и инлайн-превью до загрузки", () => {
    // Пузырь рисует заглушку по width/height ещё до первого байта файла —
    // иначе список дёргается на каждой подгруженной картинке.
    const info = describeMedia({
        className: "MessageMediaPhoto",
        photo: {
            className: "Photo",
            id: 1,
            sizes: [
                { className: "PhotoStrippedSize", type: "i", bytes: Buffer.from([1, 2, 3]) },
                { className: "PhotoSize", type: "m", w: 320, h: 240, size: 8000 },
                { className: "PhotoSizeProgressive", type: "x", w: 1280, h: 960, sizes: [1000, 90000] },
            ],
        },
    });
    assert.equal(info.kind, "photo");
    assert.equal(info.width, 1280);
    assert.equal(info.height, 960);
    // У прогрессивного размера вес — последний элемент sizes, а не сам массив.
    assert.equal(info.size, 90000);
    assert.equal(info.downloadable, true);
    assert.equal(info.stripped, Buffer.from([1, 2, 3]).toString("base64"));
    // Обрезки перечислены по возрастанию, без служебных stripped/path.
    assert.deepEqual(info.thumbs, [
        { type: "m", width: 320, height: 240, size: 8000 },
        { type: "x", width: 1280, height: 960, size: 90000 },
    ]);
});

test("media: размер документа приходит BigInteger'ом и обязан стать числом", () => {
    // teleproto отдаёт long как BigInteger; без приведения размер уезжает в
    // ответ объектом, и клиент не может решить, стоит ли качать файл.
    const big = { toString: () => "209715200", isZero: () => false, add: () => big };
    const info = describeMedia({
        className: "MessageMediaDocument",
        document: {
            className: "Document",
            mimeType: "video/mp4",
            size: big,
            attributes: [
                { className: "DocumentAttributeFilename", fileName: "clip.mp4" },
                { className: "DocumentAttributeVideo", duration: 12.5, w: 1920, h: 1080, supportsStreaming: true },
            ],
        },
    });
    assert.equal(info.kind, "video");
    assert.equal(info.size, 209715200);
    assert.equal(info.fileName, "clip.mp4");
    assert.equal(info.mimeType, "video/mp4");
    assert.equal(info.duration, 12.5);
    assert.equal(info.width, 1920);
    assert.equal(info.height, 1080);
    assert.equal(info.supportsStreaming, true);
});

test("media: кружок отличается от обычного видео", () => {
    const info = describeMedia({
        className: "MessageMediaDocument",
        document: {
            className: "Document",
            mimeType: "video/mp4",
            size: 300000,
            attributes: [{ className: "DocumentAttributeVideo", duration: 5, w: 384, h: 384, roundMessage: true }],
        },
    });
    assert.equal(info.kind, "round");
});

test("media: голосовое отдаёт развёрнутую waveform, а не буфер", () => {
    // Сырая waveform упакована по 5 бит; в JSON она ушла бы как
    // {_type:"buffer"} и клиенту пришлось бы распаковывать её самому.
    const info = describeMedia({
        className: "MessageMediaDocument",
        document: {
            className: "Document",
            mimeType: "audio/ogg",
            size: 4096,
            attributes: [{
                className: "DocumentAttributeAudio",
                voice: true,
                duration: 3,
                waveform: Buffer.from([0x1f, 0x00, 0x00, 0x00, 0x00]),
            }],
        },
    });
    assert.equal(info.kind, "voice");
    assert.equal(info.duration, 3);
    assert.deepEqual(info.waveform, [31, 0, 0, 0, 0, 0, 0, 0]);
});

test("media: музыка — не голосовое, у неё есть исполнитель", () => {
    const info = describeMedia({
        className: "MessageMediaDocument",
        document: {
            className: "Document",
            mimeType: "audio/mpeg",
            size: 5000000,
            attributes: [{
                className: "DocumentAttributeAudio",
                duration: 245,
                title: "Песня",
                performer: "Кто-то",
            }],
        },
    });
    assert.equal(info.kind, "audio");
    assert.equal(info.title, "Песня");
    assert.equal(info.performer, "Кто-то");
    assert.equal(info.waveform, null);
});

test("media: gif опознаётся по атрибуту, а не по mime", () => {
    // Telegram отдаёт «гифки» как video/mp4 без звука: по mime они
    // неотличимы от обычного видео, отличает их DocumentAttributeAnimated.
    const info = describeMedia({
        className: "MessageMediaDocument",
        document: {
            className: "Document",
            mimeType: "video/mp4",
            size: 120000,
            attributes: [
                { className: "DocumentAttributeAnimated" },
                { className: "DocumentAttributeVideo", duration: 2, w: 400, h: 300 },
            ],
        },
    });
    assert.equal(info.kind, "gif");
    assert.equal(info.isAnimated, true);
});

test("media: стикер важнее изображения и видео", () => {
    // Видеостикер несёт и DocumentAttributeVideo, и DocumentAttributeSticker;
    // нарисовать его как видео значит показать пузырь с плеером.
    const info = describeMedia({
        className: "MessageMediaDocument",
        document: {
            className: "Document",
            mimeType: "video/webm",
            size: 30000,
            attributes: [
                { className: "DocumentAttributeVideo", duration: 3, w: 512, h: 512 },
                { className: "DocumentAttributeSticker", alt: "🔥", stickerset: { className: "InputStickerSetEmpty" } },
            ],
        },
    });
    assert.equal(info.kind, "sticker");
    assert.equal(info.emoji, "🔥");
});

test("media: обрезки документа перечисляются отдельно от самого файла", () => {
    const info = describeMedia({
        className: "MessageMediaDocument",
        document: {
            className: "Document",
            mimeType: "application/pdf",
            size: 700000,
            thumbs: [
                { className: "PhotoStrippedSize", type: "i", bytes: Buffer.from([9]) },
                { className: "PhotoSize", type: "m", w: 90, h: 128, size: 3000 },
            ],
            attributes: [{ className: "DocumentAttributeFilename", fileName: "договор.pdf" }],
        },
    });
    assert.equal(info.kind, "document");
    assert.equal(info.size, 700000);
    assert.deepEqual(info.thumbs, [{ type: "m", width: 90, height: 128, size: 3000 }]);
    assert.equal(info.stripped, Buffer.from([9]).toString("base64"));
    // Размеров у произвольного файла нет — заглушка рисуется как строка, а не
    // как прямоугольник наугад.
    assert.equal(info.width, null);
    assert.equal(info.height, null);
});

test("media: спойлер доходит до клиента", () => {
    const info = describeMedia({
        className: "MessageMediaPhoto",
        spoiler: true,
        photo: { className: "Photo", sizes: [{ className: "PhotoSize", type: "m", w: 10, h: 10, size: 100 }] },
    });
    assert.equal(info.spoiler, true);
});

test("media: гео, контакт и опрос описываются, но не качаются", () => {
    for (const [raw, kind] of [
        [{ className: "MessageMediaGeo" }, "geo"],
        [{ className: "MessageMediaGeoLive" }, "geo"],
        [{ className: "MessageMediaVenue" }, "venue"],
        [{ className: "MessageMediaContact" }, "contact"],
        [{ className: "MessageMediaPoll" }, "poll"],
        [{ className: "MessageMediaDice" }, "dice"],
        [{ className: "MessageMediaWebPage" }, "webpage"],
    ]) {
        const info = describeMedia(raw);
        assert.equal(info.kind, kind);
        // Кнопки «скачать» у такого медиа быть не должно: файла за ним нет.
        assert.equal(info.downloadable, false, kind);
    }
});

test("media: пустое и незнакомое медиа не роняют нормализацию", () => {
    assert.equal(describeMedia(null), null);
    assert.equal(describeMedia(undefined), null);
    assert.equal(describeMedia({ className: "MessageMediaEmpty" }), null);
    // Новый тип медиа появляется раньше, чем его поддержка: он обязан доехать
    // до клиента заглушкой, а не исключением.
    const unknown = describeMedia({ className: "MessageMediaGiveawayResults" });
    assert.equal(unknown.kind, "unsupported");
    assert.equal(unknown.downloadable, false);
});

test("media: описание переживает JSON.stringify", () => {
    // Всё, что уходит в HTTP-ответ, обязано быть JSON-safe: буферы и
    // BigInteger в описании — это молчаливая порча ответа.
    const info = describeMedia({
        className: "MessageMediaDocument",
        document: {
            className: "Document",
            mimeType: "audio/ogg",
            size: 4096,
            thumbs: [{ className: "PhotoStrippedSize", type: "i", bytes: Buffer.from([1, 2]) }],
            attributes: [{ className: "DocumentAttributeAudio", voice: true, duration: 1, waveform: Buffer.from([255, 255, 255, 255, 255]) }],
        },
    });
    const restored = JSON.parse(JSON.stringify(info));
    assert.deepEqual(restored.waveform, new Array(8).fill(31));
    assert.equal(typeof restored.stripped, "string");
});

// ── сообщение: привязка к чату, альбомы, пересылка ────────────────────────────

test("messages: chatId маркирован и не пуст даже без peerId", () => {
    // Привязка сообщения к чату — главная ловушка контракта: peerId
    // маркирован, fromId нет. chatId закрывает её на сервере, чтобы клиенту
    // не приходилось угадывать по форме числа.
    const inChannel = normalizeMessage({
        id: 1,
        peerId: new Api.PeerChannel({ channelId: 1500000001 }),
        fromId: new Api.PeerUser({ userId: 7 }),
    });
    assert.equal(inChannel.chatId, "-1001500000001");

    // Личка без peerId: у входящего чат — это отправитель.
    const incoming = normalizeMessage({
        id: 2,
        out: false,
        fromId: new Api.PeerUser({ userId: 7 }),
    });
    assert.equal(incoming.chatId, "7");

    // У исходящего без peerId опереться не на что — врать нельзя.
    const outgoing = normalizeMessage({ id: 3, out: true });
    assert.equal(outgoing.chatId, null);
});

test("messages: groupedId остаётся строкой — альбом теряется при округлении", () => {
    // groupedId — long порядка 10^18: Number обрезал бы младшие цифры, и два
    // разных альбома слились бы в один.
    const grouped = { toString: () => "13950237418741241", isZero: () => false, add: () => grouped };
    const msg = normalizeMessage({ id: 4, peerId: { value: 1 }, groupedId: grouped });
    assert.equal(msg.groupedId, "13950237418741241");
    assert.equal(normalizeMessage({ id: 5, peerId: { value: 1 } }).groupedId, null);
});

test("messages: медиа описывается прямо в сообщении", () => {
    // Иначе клиент узнаёт о вложении только по строке mediaType и не может
    // ни нарисовать заглушку, ни решить, качать ли файл.
    const msg = normalizeMessage({
        id: 6,
        peerId: { value: 1 },
        media: {
            className: "MessageMediaPhoto",
            photo: { className: "Photo", sizes: [{ className: "PhotoSize", type: "x", w: 800, h: 600, size: 50000 }] },
        },
    });
    assert.equal(msg.mediaType, "MessageMediaPhoto");
    assert.equal(msg.media.kind, "photo");
    assert.equal(msg.media.width, 800);
    assert.equal(normalizeMessage({ id: 7, peerId: { value: 1 } }).media, null);
});

test("messages: пересылка отдаёт источник, а скрытый — только имя", () => {
    const msg = normalizeMessage({
        id: 8,
        peerId: { value: 1 },
        fwdFrom: {
            className: "MessageFwdHeader",
            fromId: new Api.PeerChannel({ channelId: 1500000001 }),
            date: 1700000000,
            channelPost: 42,
            postAuthor: "Автор",
        },
    });
    assert.equal(msg.fwdFrom.fromId, "-1001500000001");
    assert.equal(msg.fwdFrom.channelPost, 42);
    assert.equal(msg.fwdFrom.postAuthor, "Автор");
    assert.ok(msg.fwdFrom.date > 1_000_000_000_000, "дата пересылки в миллисекундах");

    // У пользователя, закрывшего ссылку на свой профиль, есть только имя.
    const hidden = normalizeMessage({
        id: 9,
        peerId: { value: 1 },
        fwdFrom: { className: "MessageFwdHeader", fromName: "Аноним", date: 1700000000 },
    });
    assert.equal(hidden.fwdFrom.fromId, null);
    assert.equal(hidden.fwdFrom.fromName, "Аноним");
    assert.equal(normalizeMessage({ id: 10, peerId: { value: 1 } }).fwdFrom, null);
});

test("messages: viaBotId доезжает строкой", () => {
    const msg = normalizeMessage({ id: 11, peerId: { value: 1 }, viaBotId: 123456789n });
    assert.equal(msg.viaBotId, "123456789");
    assert.equal(normalizeMessage({ id: 12, peerId: { value: 1 } }).viaBotId, null);
});

test("messages: senderName берётся из сущности, а у канала — из подписи", () => {
    // В группе рядом с пузырём нужно имя, а не идентификатор. Сущность уже
    // разрешена внутри getMessages — второй запрос за ней был бы лишним.
    const user = normalizeMessage({
        id: 13,
        peerId: { value: 1 },
        sender: { className: "User", firstName: "Иван", lastName: "Петров" },
    });
    assert.equal(user.senderName, "Иван Петров");

    const noName = normalizeMessage({
        id: 14,
        peerId: { value: 1 },
        sender: { className: "User", username: "durov" },
    });
    assert.equal(noName.senderName, "durov");

    const channel = normalizeMessage({
        id: 15,
        peerId: { value: 1 },
        sender: { className: "Channel", title: "Канал" },
    });
    assert.equal(channel.senderName, "Канал");

    // Подписанный пост канала: сущность — сам канал, а автор указан отдельно.
    const signed = normalizeMessage({
        id: 16,
        peerId: { value: 1 },
        post: true,
        postAuthor: "Редактор",
        sender: { className: "Channel", title: "Канал" },
    });
    assert.equal(signed.senderName, "Редактор");

    assert.equal(normalizeMessage({ id: 17, peerId: { value: 1 } }).senderName, null);
});

test("listener: удаление в канале приходит маркированным", () => {
    // План волны 5 требовал починить здесь маркировку через Api.PeerChannel.
    // В текущем teleproto DeletedMessageEvent уже строит peer сам, и chatId
    // выходит маркированным. Тест закрепляет это: обновление библиотеки —
    // единственное, что может вернуть ошибку, и молча.
    const built = new DeletedMessage({}).build(new Api.UpdateDeleteChannelMessages({
        channelId: 1500000001,
        messages: [10, 11],
        pts: 1,
        ptsCount: 2,
    }));
    const event = deletedMessagesEvent(built);
    assert.equal(event.type, "deleted_messages");
    assert.equal(event.peerId, "-1001500000001");
    assert.deepEqual(event.deletedIds, [10, 11]);
});

test("listener: в личке чат удаления неизвестен — поле пусто, а не выдумано", () => {
    // Telegram не сообщает чат для личек и малых групп: идентификаторы там
    // глобально уникальны. Пустой peerId честнее подставленного наугад.
    const built = new DeletedMessage({}).build(new Api.UpdateDeleteMessages({
        messages: [5],
        pts: 1,
        ptsCount: 1,
    }));
    const event = deletedMessagesEvent(built);
    assert.equal(event.peerId, "");
    assert.deepEqual(event.deletedIds, [5]);
});

// ── диапазоны и потоковая отдача файлов ───────────────────────────────────────

test("range: обычные формы заголовка", () => {
    assert.deepEqual(parseRange("bytes=0-499", 1000), { start: 0, end: 499 });
    // Открытый конец — до последнего байта, а не до size.
    assert.deepEqual(parseRange("bytes=500-", 1000), { start: 500, end: 999 });
    // Суффикс: последние N байт. Плеер спрашивает так про хвост контейнера.
    assert.deepEqual(parseRange("bytes=-300", 1000), { start: 700, end: 999 });
    // Конец за пределами файла подрезается, а не отвергается.
    assert.deepEqual(parseRange("bytes=900-5000", 1000), { start: 900, end: 999 });
});

test("range: неразобранный заголовок означает «отдать целиком»", () => {
    // Возврат null — это не ошибка, а «диапазона нет»: ответ 200 с полным
    // телом остаётся законным для любого клиента.
    assert.equal(parseRange(undefined, 1000), null);
    assert.equal(parseRange("", 1000), null);
    assert.equal(parseRange("items=0-10", 1000), null);
    assert.equal(parseRange("bytes=abc", 1000), null);
    // Составной диапазон отдавать multipart мы не умеем — честнее весь файл.
    assert.equal(parseRange("bytes=0-1,5-6", 1000), null);
    // Размер неизвестен — считать проценты не от чего.
    assert.equal(parseRange("bytes=0-10", null), null);
});

test("range: запрос за пределами файла — 416, а не пустое тело", () => {
    // Пустой 206 плеер трактует как конец файла и останавливает проигрывание.
    assert.equal(parseRange("bytes=1000-", 1000), "unsatisfiable");
    assert.equal(parseRange("bytes=5000-6000", 1000), "unsatisfiable");
    // Нулевой суффикс тоже бессмыслен.
    assert.equal(parseRange("bytes=-0", 1000), "unsatisfiable");
});

test("media: план загрузки выравнивает смещение, а не режет по живому", () => {
    // upload.getFile принимает только выровненное смещение; лишние байты
    // головы отбрасываются уже у нас.
    assert.deepEqual(chunkPlan(0, 999, 4096), { offset: 0, skip: 0, length: 1000 });
    assert.deepEqual(chunkPlan(5000, 5999, 4096), { offset: 4096, skip: 904, length: 1000 });
    assert.deepEqual(chunkPlan(4096, 8191, 4096), { offset: 4096, skip: 0, length: 4096 });
});

test("media: по умолчанию план выравнивается по куску, а не по 4096", () => {
    // Правило upload.getFile жёстче протокольных 4096: кусок обязан целиком
    // лежать внутри одного мегабайта файла. От смещения, кратного 4096, но не
    // кратного размеру куска, каждый второй запрос перешагивает мегабайт.
    const PART = 512 * 1024;
    assert.deepEqual(chunkPlan(5000, 5999), { offset: 0, skip: 5000, length: 1000 });
    assert.deepEqual(chunkPlan(5_000_000, 5_000_999), {
        offset: 9 * PART,
        skip: 5_000_000 - 9 * PART,
        length: 1000,
    });
});

test("media: нарезка отдаёт ровно запрошенные байты", async () => {
    async function* source() {
        yield Buffer.from("abcdefghij");
        yield Buffer.from("klmnopqrst");
    }
    const out = [];
    for await (const chunk of sliceChunks(source(), 3, 5)) out.push(chunk);
    assert.equal(Buffer.concat(out).toString(), "defgh");

    // Через границу чанка.
    const across = [];
    for await (const chunk of sliceChunks(source(), 8, 6)) across.push(chunk);
    assert.equal(Buffer.concat(across).toString(), "ijklmn");

    // Хвост короче запрошенного — отдаём что есть, без ожидания.
    const tail = [];
    for await (const chunk of sliceChunks(source(), 15, 999)) tail.push(chunk);
    assert.equal(Buffer.concat(tail).toString(), "pqrst");
});

test("media: нарезка перестаёт тянуть чанки, как только набрала длину", async () => {
    // Иначе Range на первый килобайт видео выкачал бы весь файл: клиент уже
    // отключился, а шлюз продолжает платить за трафик.
    let pulled = 0;
    async function* source() {
        for (let i = 0; i < 100; i++) { pulled++; yield Buffer.alloc(10, i); }
    }
    const out = [];
    for await (const chunk of sliceChunks(source(), 0, 15)) out.push(chunk);
    assert.equal(Buffer.concat(out).length, 15);
    assert.equal(pulled, 2, "лишние чанки не запрашиваются");
});

test("media: на аккаунт приходится не больше двух загрузок сразу", async () => {
    // Память шлюза — общий ресурс: без ограничения одна вкладка с десятком
    // видео забирает её целиком у всех аккаунтов.
    const gate = createDownloadGate(2);
    const first = await gate.acquire("acc_a");
    const second = await gate.acquire("acc_a");

    let thirdEntered = false;
    const third = gate.acquire("acc_a").then((release) => { thirdEntered = true; return release; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(thirdEntered, false, "третья загрузка ждёт освободившегося места");

    // Другой аккаунт считается отдельно и не стоит в чужой очереди.
    const other = await gate.acquire("acc_b");
    other();

    first();
    (await third)();
    second();
    assert.equal(thirdEntered, true);
});

test("media: место освобождается даже если загрузка упала", async () => {
    const gate = createDownloadGate(1);
    const release = await gate.acquire("acc_a");
    release();
    // Повторное освобождение не должно открывать лишнее место.
    release();
    const again = await gate.acquire("acc_a");
    let entered = false;
    gate.acquire("acc_a").then(() => { entered = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(entered, false);
    again();
});

test("media: обрезка выбирается по запрошенному размеру", () => {
    const thumbs = [
        { type: "s", width: 90, height: 60, size: 1500 },
        { type: "m", width: 320, height: 213, size: 9000 },
        { type: "x", width: 800, height: 533, size: 40000 },
    ];
    // «s» — самая мелкая: она нужна списку диалогов, где важен вес, а не вид.
    assert.equal(pickThumbType(thumbs, "s"), "s");
    // «m» — самая крупная из обрезок: пузырь в чате должен быть чётким.
    assert.equal(pickThumbType(thumbs, "m"), "x");
    assert.equal(pickThumbType(thumbs, "что-то"), "x");
    assert.equal(pickThumbType([], "m"), null);
    assert.equal(pickThumbType(undefined, "s"), null);
});

// ── загрузка медиа ────────────────────────────────────────────────────────────

/**
 * Клиент-обманка: настоящий требует живой сессии Telegram, а проверять здесь
 * надо не MTProto, а наше обращение с ним — смещения, границы и отказы.
 */
function fakeClient({ message, chunkSize = 10, total = 100 }) {
    const calls = { iterDownload: [], downloadMedia: [] };
    return {
        calls,
        async getEntity() { return { className: "User", id: 1 }; },
        async getMessages() { return message ? [message] : []; },
        async *iterDownload(file, params) {
            calls.iterDownload.push(params);
            for (let sent = params.offset; sent < total; sent += chunkSize) {
                // Байт равен своему смещению по модулю 251 — так видно, какой
                // именно участок файла доехал до клиента.
                const chunk = Buffer.alloc(Math.min(chunkSize, total - sent));
                for (let i = 0; i < chunk.length; i++) chunk[i] = (sent + i) % 251;
                yield chunk;
            }
        },
        async downloadMedia(file, params) {
            calls.downloadMedia.push(params);
            return Buffer.from("jpeg");
        },
    };
}

const photoMessage = {
    id: 5,
    media: {
        className: "MessageMediaPhoto",
        photo: {
            className: "Photo",
            id: 777,
            sizes: [
                { className: "PhotoStrippedSize", type: "i", bytes: Buffer.from([1]) },
                { className: "PhotoSize", type: "s", w: 90, h: 60, size: 20 },
                { className: "PhotoSize", type: "x", w: 800, h: 533, size: 100 },
            ],
        },
    },
};

test("media: без диапазона файл тянется с начала и целиком", async () => {
    const client = fakeClient({ message: photoMessage });
    const opened = await openMedia(client, "me", 5);
    assert.equal(opened.info.size, 100);
    assert.equal(opened.info.kind, "photo");
    const body = [];
    for await (const chunk of streamMedia(client, opened)) body.push(chunk);
    assert.equal(Buffer.concat(body).length, 100);
    assert.equal(client.calls.iterDownload[0].offset, 0);
});

test("media: диапазон просит выровненное смещение, а отдаёт запрошенное", async () => {
    // Телеграму нельзя дать произвольное смещение, а плееру нельзя отдать
    // лишние байты головы: он считает их частью кадра.
    const client = fakeClient({ message: photoMessage, total: 20000 });
    const opened = await openMedia(client, "me", 5);
    const body = [];
    for await (const chunk of streamMedia(client, opened, { range: { start: 5000, end: 5099 } })) body.push(chunk);
    const bytes = Buffer.concat(body);
    assert.equal(bytes.length, 100);
    assert.equal(bytes[0], 5000 % 251, "первый байт — ровно запрошенный");
    // Ноль, а не 4096: выравнивание идёт по размеру куска, иначе запрос
    // перешагнёт границу мегабайта — см. `chunkPlan`.
    assert.equal(client.calls.iterDownload[0].offset, 0, "смещение выровнено по куску");
});

/**
 * Обманка `iterDownload`, ведущая себя как настоящий: один ответ на
 * `requestSize` байт, обрезанный концом файла и `limit`.
 *
 * Прежняя обманка не смотрела ни на `limit`, ни на `requestSize` и отдавала
 * файл до конца с любого смещения. С последовательной выдачей разница не
 * видна, а параллельная на такой обманке «проверяла» бы перекрывающиеся куски
 * — то есть ничего.
 *
 * `onPart` вызывается перед выдачей куска: тестам нужно управлять тем, в каком
 * порядке и как долго едут куски.
 */
function fakeIterDownload(total, { onPart } = {}) {
    return async function* iterDownload(file, params = {}) {
        const requestSize = params.requestSize ?? 512 * 1024;
        const limit = params.limit ?? Infinity;
        let sent = 0;
        while (sent < limit) {
            const start = Number(params.offset ?? 0) + sent;
            const size = Math.min(requestSize, limit - sent, total - start);
            if (size <= 0) return;
            if (onPart) await onPart({ offset: start, size });
            // Байт равен своему смещению по модулю 251 — так видно, какой
            // именно участок файла доехал до клиента и в каком порядке.
            const chunk = Buffer.alloc(size);
            for (let i = 0; i < size; i++) chunk[i] = (start + i) % 251;
            yield chunk;
            sent += size;
            // Короткий ответ Telegram означает конец файла.
            if (size < requestSize) return;
        }
    };
}

/** Сообщение с видео заданного размера — для тестов выдачи файла. */
function videoMessage(size) {
    return {
        id: 1,
        media: {
            className: "MessageMediaDocument",
            document: { className: "Document", id: 42, mimeType: "video/mp4", size, attributes: [] },
        },
    };
}

/** Клиент-обманка поверх [fakeIterDownload]. */
function streamingClient(size, options) {
    return {
        async getEntity() { return { className: "User", id: 1 }; },
        async getMessages() { return [videoMessage(size)]; },
        iterDownload: fakeIterDownload(size, options),
    };
}

test("media: куски файла едут из Telegram одновременно", async () => {
    // Последовательная выдача упирается не в канал, а в задержку до
    // дата-центра: 512 КБ за круг. Через прокси круг занимает сотни
    // миллисекунд, и видео на 50 МБ открывается минуту вместо секунд.
    const PART = 512 * 1024;
    let inFlight = 0;
    let peak = 0;
    const client = streamingClient(4 * PART, {
        async onPart() {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
        },
    });

    const opened = await openMedia(client, "me", 1);
    let bytes = 0;
    for await (const chunk of streamMedia(client, opened)) bytes += chunk.length;

    assert.equal(bytes, 4 * PART);
    assert.ok(peak >= 2, `одновременно в полёте было кусков: ${peak}`);
});

test("media: куски отдаются по порядку, даже если приехали вразнобой", async () => {
    // Порядок здесь не украшение: перепутанные куски mp4 — это не «немного
    // рассыпавшееся видео», а файл, который плеер не открывает вовсе.
    const PART = 4096;
    const TOTAL = 4 * PART;
    const client = streamingClient(TOTAL, {
        // Дальние куски отвечают первыми — как оно и бывает, когда запросы
        // идут по разным соединениям.
        onPart: ({ offset }) => new Promise((resolve) => setTimeout(resolve, TOTAL - offset)),
    });

    const opened = await openMedia(client, "me", 1);
    const body = [];
    for await (const chunk of streamMedia(client, opened, { partSize: PART })) body.push(chunk);
    const bytes = Buffer.concat(body);

    assert.equal(bytes.length, TOTAL);
    const expected = Buffer.alloc(TOTAL);
    for (let i = 0; i < TOTAL; i++) expected[i] = i % 251;
    assert.ok(bytes.equals(expected), "байты пришли не в том порядке");
});

test("media: поток ленив — лишние куски из Telegram не запрашиваются", async () => {
    // Клиент закрыл вкладку на десятой секунде видео. Куски в полёте уже не
    // остановить, но запускать новые за ними — платить каналом шлюза за то,
    // что никто не посмотрит.
    const PART = 4096;
    let requested = 0;
    const client = streamingClient(100 * PART, { onPart: () => { requested += 1; } });

    const opened = await openMedia(client, "me", 1);
    let taken = 0;
    for await (const chunk of streamMedia(client, opened, { partSize: PART })) {
        if (++taken === 2) break;
    }

    assert.equal(taken, 2);
    // Точное число зависит от глубины очереди; важно, что оно не растёт
    // с размером файла — иначе это выкачивание целиком.
    assert.ok(requested <= 8, `запрошено кусков: ${requested}`);
});

test("media: диапазон в параллельной выдаче отдаёт ровно запрошенные байты", async () => {
    // Голова первого куска и хвост последнего лишние: плеер считает их
    // частью кадра, и картинка рассыпается.
    const PART = 4096;
    const client = streamingClient(100 * PART);
    const opened = await openMedia(client, "me", 1);

    const body = [];
    for await (const chunk of streamMedia(client, opened, {
        range: { start: 10_000, end: 20_000 },
        partSize: PART,
    })) {
        body.push(chunk);
    }
    const bytes = Buffer.concat(body);

    assert.equal(bytes.length, 10_001);
    assert.equal(bytes[0], 10_000 % 251, "первый байт — ровно запрошенный");
    assert.equal(bytes[bytes.length - 1], 20_000 % 251, "последний байт — ровно запрошенный");
});

test("media: у сообщения без вложения качать нечего", async () => {
    const client = fakeClient({ message: { id: 5 } });
    await assert.rejects(() => openMedia(client, "me", 5),
        (err) => err instanceof ProtocolError && err.code === "no_media");
});

test("media: за гео и опросом файла нет — это тоже no_media", async () => {
    // Иначе шлюз уходит в загрузку, которой не существует, и клиент ждёт
    // ответа до таймаута вместо честной ошибки.
    const client = fakeClient({ message: { id: 5, media: { className: "MessageMediaGeo" } } });
    await assert.rejects(() => openMedia(client, "me", 5),
        (err) => err instanceof ProtocolError && err.code === "no_media");
});

test("media: пропавшее сообщение отличается от сообщения без медиа", async () => {
    const client = fakeClient({ message: null });
    await assert.rejects(() => openMedia(client, "me", 5),
        (err) => err instanceof ProtocolError && err.code === "message_not_found");
});

test("media: превью качается обрезкой, а не оригиналом", async () => {
    const client = fakeClient({ message: photoMessage });
    const small = await downloadThumb(client, "me", 5, "s");
    assert.equal(small.mimeType, "image/jpeg");
    assert.equal(small.buffer.toString(), "jpeg");
    assert.equal(small.notModified, false);
    // Именно обрезка «s», а не самый большой размер: иначе превью весит
    // столько же, сколько оригинал, и смысл эндпоинта теряется.
    assert.equal(client.calls.downloadMedia[0].thumb, "s");
    assert.ok(small.etag, "у превью есть ETag — иначе оно качается каждый раз");

    const medium = await downloadThumb(client, "me", 5, "m");
    assert.equal(client.calls.downloadMedia[1].thumb, "x");
    assert.notEqual(small.etag, medium.etag, "ETag зависит от размера");
});

test("media: размер уходит в загрузку строкой, а не TL-объектом", async () => {
    // Здесь исполняется настоящая загрузка из teleproto, а не фейк: именно
    // объектная ветка библиотеки не знает PhotoSizeProgressive и молча
    // возвращает нулевой буфер, а фейковый клиент это пропускал.
    const progressive = new Api.PhotoSizeProgressive({ type: "y", w: 1280, h: 853, sizes: [10, 4096] });
    const sizes = [
        new Api.PhotoStrippedSize({ type: "i", bytes: Buffer.from([1, 8, 8]) }),
        new Api.PhotoSize({ type: "s", w: 90, h: 60, size: 20 }),
        progressive,
    ];
    const photo = new Api.Photo({
        id: 777n, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, sizes, dcId: 2,
    });

    // PhotoSizeProgressive не наследует PhotoSize, и объектная ветка getThumb
    // его не узнаёт: загрузка возвращает ноль байт вместо картинки.
    assert.equal(progressive instanceof Api.PhotoSize, false);
    const byObject = await _downloadPhoto(null, photo, undefined, 1, progressive);
    assert.equal(byObject.length, 0, "объектом прогрессивный размер не качается — на этом и ломалось превью");

    // Строкой тот же размер находится, и загрузка доходит до сети (клиента
    // здесь нет, поэтому падает, — но уже не отдаёт пустоту за картинку).
    await assert.rejects(() => _downloadPhoto(null, photo, undefined, 1, "y"));

    const client = fakeClient({
        message: { id: 5, media: { className: "MessageMediaPhoto", photo: { className: "Photo", id: 777, sizes } } },
    });
    await downloadThumb(client, "me", 5, "m");
    assert.equal(client.calls.downloadMedia[0].thumb, "y", "шлюз передаёт тип строкой");
});

test("media: пустое превью не выдаётся за картинку", async () => {
    const client = fakeClient({ message: photoMessage });
    client.downloadMedia = async () => Buffer.alloc(0);
    // Двухсотка с нулевой длиной неотличима для клиента от «превью просто
    // нет», а маршрут накрыл бы её недельным immutable-кешем.
    await assert.rejects(() => downloadThumb(client, "me", 5, "m"),
        (err) => err instanceof ProtocolError && err.code === "no_thumb");
});

test("media: крупное превью берётся достаточным, а не самым большим", () => {
    const thumbs = [
        { type: "s", width: 90, height: 60 },
        { type: "y", width: 1280, height: 853 },
        { type: "w", width: 2560, height: 1707 },
    ];
    // 2560 px в пузыре не видно, а маршрут превью держит ответ в памяти
    // целиком — в отличие от /file.
    assert.equal(pickThumbType(thumbs, "m"), "y");
    assert.equal(pickThumbType(thumbs, "s"), "s");
    // Когда достаточного размера нет, берётся самый крупный из имеющихся.
    assert.equal(pickThumbType(thumbs.slice(0, 1), "m"), "s");
});

test("media: у документа без обрезок превью не выдумывается", async () => {
    const client = fakeClient({
        message: {
            id: 6,
            media: {
                className: "MessageMediaDocument",
                document: { className: "Document", id: 9, mimeType: "application/zip", size: 100, attributes: [] },
            },
        },
    });
    await assert.rejects(() => downloadThumb(client, "me", 6, "m"),
        (err) => err instanceof ProtocolError && err.code === "no_thumb");
});

test("httpErrors: no_thumb — это 404, а не общая ошибка", () => {
    // Отсутствие превью — нормальный ответ для zip-архива, и клиент должен
    // отличать его от «сообщение не найдено», чтобы не повторять запрос.
    const { status, body } = toHttpError(new ProtocolError("no_thumb", "У вложения нет превью."));
    assert.equal(status, 404);
    assert.equal(body.error, "no_thumb");
});

test("media: совпавший ETag отменяет и ответ, и саму загрузку из Telegram", () => {
    // Иначе смысл кеша половинчатый: клиент экономит трафик до себя, а шлюз
    // всё равно тянет обрезку из Telegram на каждый запрос списка.
    const client = fakeClient({ message: photoMessage });
    return downloadThumb(client, "me", 5, "s").then(async (first) => {
        const again = await downloadThumb(client, "me", 5, "s", { ifNoneMatch: first.etag });
        assert.equal(again.notModified, true);
        assert.equal(again.buffer, null);
        assert.equal(again.etag, first.etag);
        assert.equal(client.calls.downloadMedia.length, 1, "второй загрузки не было");
    });
});

test("range: полный файл отдаётся с 200 и объявляет поддержку диапазонов", () => {
    // Без Accept-Ranges плеер даже не пробует перематывать — качает целиком
    // с начала при каждом прыжке по таймлайну.
    const head = mediaResponseHead(
        { mimeType: "video/mp4", fileName: "клип.mp4", size: 1000 },
        null,
    );
    assert.equal(head.status, 200);
    assert.equal(head.headers["Accept-Ranges"], "bytes");
    assert.equal(head.headers["Content-Type"], "video/mp4");
    assert.equal(head.headers["Content-Length"], 1000);
    // Кириллица в имени выживает только в filename* с процентным кодированием.
    assert.match(head.headers["Content-Disposition"], /filename\*=UTF-8''%D0%BA%D0%BB%D0%B8%D0%BF\.mp4/);
});

test("range: кусок отдаётся с 206 и длиной куска, а не файла", () => {
    // Content-Length, равный размеру файла, заставит клиента ждать байты,
    // которых не будет, — соединение зависнет до таймаута.
    const head = mediaResponseHead(
        { mimeType: "video/mp4", size: 1000 },
        { start: 200, end: 399 },
    );
    assert.equal(head.status, 206);
    assert.equal(head.headers["Content-Range"], "bytes 200-399/1000");
    assert.equal(head.headers["Content-Length"], 200);
});

test("range: запрос за пределами файла — 416 с полным размером", () => {
    const head = mediaResponseHead({ mimeType: "video/mp4", size: 1000 }, "unsatisfiable");
    assert.equal(head.status, 416);
    assert.equal(head.headers["Content-Range"], "bytes */1000");
    // Тела у 416 нет — заявлять тип нечему.
    assert.equal(head.headers["Content-Type"], undefined);
});

test("range: неизвестный размер не превращается в нулевую длину", () => {
    // Content-Length: 0 клиент читает как пустой файл. Лучше не объявлять его
    // вовсе и закрыть поток концом соединения.
    const head = mediaResponseHead({ mimeType: null, size: null }, null);
    assert.equal(head.status, 200);
    assert.equal(head.headers["Content-Length"], undefined);
    assert.equal(head.headers["Content-Type"], "application/octet-stream");
    assert.equal(head.headers["Content-Disposition"], undefined);
});

test("media: память шлюза не зависит от размера файла", async () => {
    // Главный риск волны. Старая реализация собирала файл в Buffer целиком:
    // одно видео забирало столько RSS, сколько весило, у процесса, общего для
    // всех аккаунтов.
    //
    // Проверяется именно независимость от размера, а не абсолютная цифра: RSS
    // — отметка максимума, и освобождённые буферы возвращаются системе не
    // сразу. Полгигабайта через поток стоят десятки мегабайт; та же выдача
    // через Buffer стоила бы полгигабайта, и порог ниже неё на порядок.
    const TOTAL = 512 * 1024 * 1024;
    const client = streamingClient(TOTAL);

    const opened = await openMedia(client, "me", 1);
    const before = process.memoryUsage().rss;
    let bytes = 0;
    for await (const chunk of streamMedia(client, opened)) {
        // Потребитель ведёт себя как сокет: взял кусок и забыл о нём.
        bytes += chunk.length;
    }
    const grew = process.memoryUsage().rss - before;

    assert.equal(bytes, TOTAL);
    assert.ok(
        grew < TOTAL / 2,
        `RSS вырос на ${Math.round(grew / 1048576)} МБ при файле ${TOTAL / 1048576} МБ`,
    );
});

// ── прокси: разбор PROXY_URL ──────────────────────────────────────────────────

test("proxy: socks5 с авторизацией разбирается целиком", () => {
    const proxy = parseProxyUrl("socks5://user:pass@1.2.3.4:1080");
    assert.equal(proxy.kind, "socks");
    assert.equal(proxy.socksType, 5);
    assert.equal(proxy.host, "1.2.3.4");
    assert.equal(proxy.port, 1080);
    assert.equal(proxy.username, "user");
    assert.equal(proxy.password, "pass");
});

test("proxy: без порта и без авторизации подставляются умолчания", () => {
    assert.equal(parseProxyUrl("socks5://1.2.3.4").port, 1080);
    assert.equal(parseProxyUrl("http://1.2.3.4").port, 80);
    assert.equal(parseProxyUrl("https://1.2.3.4").port, 443);
    // Пустая строка, а не undefined: «авторизации нет».
    assert.equal(parseProxyUrl("http://1.2.3.4").username, "");
    assert.equal(parseProxyUrl("http://1.2.3.4").password, "");
});

test("proxy: socks4 и псевдонимы из мира curl", () => {
    assert.equal(parseProxyUrl("socks4://h").socksType, 4);
    assert.equal(parseProxyUrl("socks4a://h").socksType, 4);
    assert.equal(parseProxyUrl("socks5h://h").socksType, 5);
    assert.equal(parseProxyUrl("socks://h").socksType, 5);
});

test("proxy: http и https различаются только TLS до прокси", () => {
    assert.equal(parseProxyUrl("http://127.0.0.1:3128").kind, "http");
    assert.equal(parseProxyUrl("http://127.0.0.1:3128").tls, false);
    assert.equal(parseProxyUrl("https://127.0.0.1:8443").tls, true);
    assert.equal(parseProxyUrl("https://127.0.0.1:8443").insecureTls, false);
    assert.equal(parseProxyUrl("https://127.0.0.1:8443?insecure=1").insecureTls, true);
});

test("proxy: спецсимволы в логине и пароле берутся из percent-encoding", () => {
    const proxy = parseProxyUrl("http://us%40er:p%40ss%3Aw@h:3128");
    assert.equal(proxy.username, "us@er");
    assert.equal(proxy.password, "p@ss:w");
});

test("proxy: одиночный % даёт понятную ошибку, а не «malformed URI»", () => {
    assert.throws(() => parseProxyUrl("http://u:p%@h"), /percent-encoding/);
});

test("proxy: пусто — прямое подключение", () => {
    assert.equal(parseProxyUrl(""), null);
    assert.equal(parseProxyUrl("   "), null);
    assert.equal(parseProxyUrl(undefined), null);
});

test("proxy: мусор в PROXY_URL роняет старт, а не откатывается на прямое соединение", () => {
    assert.throws(() => parseProxyUrl("ftp://h:21"), /не поддерживается/);
    assert.throws(() => parseProxyUrl("127.0.0.1:1080"), /не похоже на URL/);
    // Порт вне диапазона отвергает сам разбор URL — до наших проверок не доходит.
    assert.throws(() => parseProxyUrl("socks5://h:99999"), /не похоже на URL/);
});

test("proxy: IPv6-хост отдаётся без квадратных скобок", () => {
    // net.connect ждёт голый адрес, а WHATWG-URL оставляет скобки.
    assert.equal(parseProxyUrl("socks5://[::1]:1080").host, "::1");
});

test("proxy: PROXY_TIMEOUT — значение, умолчание и мусор", () => {
    assert.equal(parseProxyUrl("socks5://h", 12).timeout, 12);
    assert.equal(parseProxyUrl("socks5://h").timeout, 5);
    assert.equal(parseProxyUrl("socks5://h", NaN).timeout, 5);
    assert.equal(parseProxyUrl("socks5://h", 0).timeout, 5);
    assert.equal(parseProxyUrl("socks5://h", -1).timeout, 5);
});

test("proxy: секрет mtproxy читается из userinfo и из ?secret=", () => {
    const hex = "ab".repeat(16);
    assert.equal(parseProxyUrl(`mtproxy://${hex}@1.2.3.4:443`).secret, hex);
    assert.equal(parseProxyUrl(`mtproxy://1.2.3.4:443?secret=${hex}`).secret, hex);
    assert.equal(parseProxyUrl(`mtproxy://${hex}@1.2.3.4:443`).kind, "mtproxy");
});

test("proxy: длина секрета mtproxy проверяется до первого соединения", () => {
    // dd-секрет с паддингом и ee-секрет с доменом (fake-TLS, base64url из tg://proxy).
    assert.ok(parseProxyUrl(`mtproxy://dd${"00".repeat(16)}@h`).secret);
    const fakeTls = Buffer.concat([Buffer.from([0xee]), Buffer.alloc(16, 1), Buffer.from("google.com")]);
    assert.ok(parseProxyUrl(`mtproxy://h?secret=${fakeTls.toString("base64url")}`).secret);
    assert.throws(() => parseProxyUrl("mtproxy://abcd@h"), /Ожидается 16/);
    assert.throws(() => parseProxyUrl("mtproxy://h"), /нужен секрет/);
});

test("proxy: describeProxy не печатает пароль и секрет", () => {
    const shown = describeProxy(parseProxyUrl("http://user:s3cret@h:3128"));
    assert.ok(!shown.includes("s3cret"), shown);
    assert.match(shown, /user:\*\*\*@h:3128/);
    // Без авторизации это должно быть видно сразу, а не угадываться.
    assert.match(describeProxy(parseProxyUrl("http://h:3128")), /без авторизации/);

    const hex = "ab".repeat(16);
    const mt = describeProxy(parseProxyUrl(`mtproxy://${hex}@h`));
    assert.ok(!mt.includes(hex), mt);
    assert.equal(describeProxy(null), "выключен");
});

// ── прокси: выбор источника настроек ──────────────────────────────────────────

test("proxy: PROXY_URL важнее системных переменных", () => {
    const picked = pickProxySource({ PROXY_URL: "socks5://explicit", ALL_PROXY: "http://system" }, true);
    assert.deepEqual(picked, { name: "PROXY_URL", value: "socks5://explicit" });
});

test("proxy: без PROXY_FROM_ENV системные переменные не читаются", () => {
    // Иначе прокси, выставленный в шелле для совсем других задач, молча увёл бы
    // боевые сессии Telegram.
    assert.deepEqual(pickProxySource({ ALL_PROXY: "http://system" }, false), { name: "", value: "" });
    assert.deepEqual(pickProxySource({}, true), { name: "", value: "" });
});

test("proxy: приоритет системных переменных — HTTPS_PROXY, затем ALL_PROXY, затем HTTP_PROXY", () => {
    const all = { HTTPS_PROXY: "http://a", ALL_PROXY: "socks5://b", HTTP_PROXY: "http://c" };
    assert.equal(pickProxySource(all, true).name, "HTTPS_PROXY");
    assert.equal(pickProxySource({ ALL_PROXY: "socks5://b", HTTP_PROXY: "http://c" }, true).name, "ALL_PROXY");
    assert.equal(pickProxySource({ HTTP_PROXY: "http://c" }, true).name, "HTTP_PROXY");
});

test("proxy: строчные имена переменных идут первыми", () => {
    // На Unix они встречаются чаще; так же их предпочитает curl.
    assert.equal(pickProxySource({ https_proxy: "http://a", HTTPS_PROXY: "http://b" }, true).name, "https_proxy");
    assert.equal(pickProxySource({ all_proxy: "socks5://a" }, true).value, "socks5://a");
});

test("proxy: пустые и пробельные значения переменных пропускаются", () => {
    assert.equal(pickProxySource({ PROXY_URL: "   ", ALL_PROXY: "socks5://b" }, true).name, "ALL_PROXY");
    assert.equal(pickProxySource({ HTTPS_PROXY: "", ALL_PROXY: "socks5://b" }, true).name, "ALL_PROXY");
});

test("proxy: в тексте ошибки названа та переменная, где лежит мусор", () => {
    // Жалоба на PROXY_URL при значении из ALL_PROXY отправила бы искать не там.
    assert.throws(() => parseProxyUrl("ftp://h", 5, "ALL_PROXY"), /^Error: ALL_PROXY: схема/);
    assert.throws(() => parseProxyUrl("ftp://h"), /^Error: PROXY_URL: схема/);
});

// ── прокси: рукопожатие CONNECT ───────────────────────────────────────────────

/** Читатель поверх буфера: считает, сколько байт реально съедено. */
function fakeReader(buffer) {
    let offset = 0;
    return {
        async readExactly(n) {
            if (offset + n > buffer.length) throw new Error("NetSocket was closed");
            const out = buffer.subarray(offset, offset + n);
            offset += n;
            return out;
        },
        get consumed() { return offset; },
    };
}

test("proxy: CONNECT без авторизации не отправляет Proxy-Authorization", () => {
    const request = buildConnectRequest({ host: "149.154.167.51", port: 443 }).toString();
    assert.match(request, /^CONNECT 149\.154\.167\.51:443 HTTP\/1\.1\r\n/);
    assert.match(request, /\r\nHost: 149\.154\.167\.51:443\r\n/);
    assert.ok(!request.includes("Proxy-Authorization"), request);
    assert.ok(request.endsWith("\r\n\r\n"));
});

test("proxy: CONNECT с авторизацией шлёт Basic сразу, не дожидаясь 407", () => {
    const request = buildConnectRequest({ host: "h", port: 443, username: "user", password: "pass" }).toString();
    const token = Buffer.from("user:pass", "utf8").toString("base64");
    assert.match(request, new RegExp(`\r\nProxy-Authorization: Basic ${token}\r\n`));
});

test("proxy: IPv6-цель в CONNECT берётся в квадратные скобки", () => {
    const request = buildConnectRequest({ host: "2001:db8::1", port: 443 }).toString();
    assert.match(request, /^CONNECT \[2001:db8::1\]:443 HTTP\/1\.1\r\n/);
});

test("proxy: успешный ответ разбирается в обеих версиях HTTP", () => {
    assert.deepEqual(
        parseConnectResponse(Buffer.from("HTTP/1.0 200 Connection established\r\n\r\n")),
        { code: 200, reason: "Connection established" },
    );
    assert.deepEqual(parseConnectResponse(Buffer.from("HTTP/1.1 200 OK\r\n\r\n")), { code: 200, reason: "OK" });
});

test("proxy: 407 и 403 разбираются с кодом и причиной", () => {
    assert.equal(parseConnectResponse(Buffer.from("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")).code, 407);
    assert.equal(parseConnectResponse(Buffer.from("HTTP/1.1 403 Forbidden\r\n\r\n")).reason, "Forbidden");
});

test("proxy: ответ не по HTTP — понятная ошибка, а не разбор мусора", () => {
    // Так выглядит начало ответа SOCKS5, если схему в PROXY_URL перепутали.
    assert.throws(
        () => parseConnectResponse(Buffer.from([0x05, 0x00, 0x00, 0x01])),
        (err) => err.code === "proxy_protocol_error",
    );
});

test("proxy: байты MTProto, приклеенные к ответу прокси, не теряются", async () => {
    const header = "HTTP/1.1 200 OK\r\n\r\n";
    const tail = Buffer.from([0xef, 0x01, 0x02, 0x03]);
    const reader = fakeReader(Buffer.concat([Buffer.from(header), tail]));

    const read = await readConnectResponse(reader);
    assert.equal(read.toString(), header);
    // Ни одного лишнего байта: хвост достанется первому же чтению кодека.
    assert.equal(reader.consumed, header.length);
    assert.deepEqual(await reader.readExactly(4), tail);
});

test("proxy: многострочный заголовок ответа читается целиком", async () => {
    const header = "HTTP/1.1 200 OK\r\nProxy-Agent: tinyproxy\r\nVia: 1.1 proxy\r\n\r\n";
    const read = await readConnectResponse(fakeReader(Buffer.from(header)));
    assert.equal(read.toString(), header);
});

test("proxy: бесконечный заголовок обрывается лимитом", async () => {
    await assert.rejects(
        () => readConnectResponse(fakeReader(Buffer.alloc(100, 0x41)), 32),
        /за 32 байт/,
    );
});

// ── прокси: выбор транспорта ──────────────────────────────────────────────────

test("proxy: socks уходит в штатную опцию teleproto", () => {
    const options = proxyClientOptions(parseProxyUrl("socks5://user:pass@h:1080"));
    assert.equal(options.proxy.socksType, 5);
    assert.equal(options.proxy.ip, "h");
    assert.equal(options.proxy.username, "user");
    assert.equal(options.networkSocket, undefined);
});

test("proxy: socks без авторизации не шлёт пустые учётные данные", () => {
    // Пустая строка включила бы в SOCKS5 аутентификацию, и прокси без неё откажет.
    const options = proxyClientOptions(parseProxyUrl("socks5://h:1080"));
    assert.equal(options.proxy.username, undefined);
    assert.equal(options.proxy.password, undefined);
});

test("proxy: mtproxy включает собственную ветку teleproto", () => {
    const hex = "ab".repeat(16);
    const options = proxyClientOptions(parseProxyUrl(`mtproxy://${hex}@h:443`));
    assert.equal(options.proxy.MTProxy, true);
    assert.equal(options.proxy.secret, hex);
    assert.equal(options.networkSocket, undefined);
});

test("proxy: http подменяет транспорт и не отдаёт teleproto чужой прокси", () => {
    const options = proxyClientOptions(parseProxyUrl("http://h:3128"));
    // Опция proxy обязана отсутствовать: PromisedNetSockets на ней бросит.
    assert.equal(options.proxy, undefined);
    assert.equal(typeof options.networkSocket, "function");
    const socket = new options.networkSocket(undefined, 30000);
    assert.ok(socket instanceof PromisedNetSockets);
    // isWebSocket подменил бы соединение на ConnectionTCPObfuscated и адреса DC.
    assert.equal(options.networkSocket.isWebSocket, undefined);
});

test("proxy: без настроек опции клиента не меняются", () => {
    assert.deepEqual(proxyClientOptions(null), {});
});

test("proxy: ошибки прокси отдаются как 502/504, а не 500", () => {
    assert.equal(toHttpError(new ProtocolError("proxy_unreachable", "нет связи")).status, 502);
    assert.equal(toHttpError(new ProtocolError("proxy_auth_required", "407")).status, 502);
    assert.equal(toHttpError(new ProtocolError("proxy_timeout", "молчит")).status, 504);
});

// ── прокси: сквозное рукопожатие через локальный прокси ───────────────────────

/**
 * Поднимает фейковый CONNECT-прокси на localhost.
 * @param {(request: string, socket: import("node:net").Socket) => void} onConnect
 */
async function fakeProxy(onConnect) {
    const server = net.createServer((socket) => {
        socket.once("data", (chunk) => onConnect(chunk.toString(), socket));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test("proxy: сквозной CONNECT отдаёт полезную нагрузку из того же пакета", async () => {
    const payload = Buffer.from([0xef, 0x01, 0x02, 0x03]);
    let seen = "";
    const proxy = await fakeProxy((request, socket) => {
        seen = request;
        // Ответ и первые байты MTProto одним write — так и ведёт себя реальный прокси.
        socket.write(Buffer.concat([Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n"), payload]));
    });

    const Socket = createProxySocketFactory(parseProxyUrl(`http://127.0.0.1:${proxy.port}`));
    const socket = new Socket(undefined, 30000);
    try {
        await socket.connect(443, "149.154.167.51");
        assert.match(seen, /^CONNECT 149\.154\.167\.51:443 HTTP\/1\.1\r\n/);
        assert.deepEqual(await socket.readExactly(4), payload);
    } finally {
        await socket.close();
        await proxy.close();
    }
});

test("proxy: 407 от прокси превращается в proxy_auth_required", async () => {
    const proxy = await fakeProxy((_request, socket) => {
        socket.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n");
    });

    const Socket = createProxySocketFactory(parseProxyUrl(`http://127.0.0.1:${proxy.port}`));
    const socket = new Socket(undefined, 30000);
    try {
        await assert.rejects(
            () => socket.connect(443, "149.154.167.51"),
            (err) => err.code === "proxy_auth_required" && /Добавьте учётные данные/.test(err.hint),
        );
    } finally {
        await proxy.close();
    }
});

test("proxy: недоступный прокси — proxy_unreachable, а не зависание", async () => {
    // Порт, который заведомо никто не слушает: поднимаем и сразу закрываем.
    const dead = await fakeProxy(() => {});
    const port = dead.port;
    await dead.close();

    const Socket = createProxySocketFactory(parseProxyUrl(`http://127.0.0.1:${port}`));
    const socket = new Socket(undefined, 30000);
    await assert.rejects(
        () => socket.connect(443, "149.154.167.51"),
        (err) => err.code === "proxy_unreachable",
    );
});

// ── кеш описания вложения ─────────────────────────────────────────────────────

test("media: описание файла не перезапрашивается на каждый Range", async () => {
    // Плеер шлёт за одно видео десятки запросов: проба, старт, каждая
    // перемотка. Каждый из них платил походом в Telegram за getMessages ещё
    // до первого байта — через прокси это сотни миллисекунд на пустом месте.
    const client = {};
    let loads = 0;
    const open = createMediaOpener(async () => {
        loads += 1;
        return { raw: {}, info: { size: 100 } };
    });

    await open(client, "me", 5);
    await open(client, "me", 5);

    assert.equal(loads, 1);
});

test("media: описание живёт недолго — ссылка на файл в Telegram не вечна", async () => {
    let clock = 0;
    let loads = 0;
    const open = createMediaOpener(async () => {
        loads += 1;
        return { raw: {}, info: { size: 100 } };
    }, { ttlMs: 1000, now: () => clock });
    const client = {};

    await open(client, "me", 5);
    clock = 999;
    await open(client, "me", 5);
    assert.equal(loads, 1, "внутри срока — из кеша");

    clock = 1001;
    await open(client, "me", 5);
    assert.equal(loads, 2, "после срока — заново");
});

test("media: кеш описаний не путает сообщения и аккаунты", async () => {
    // Один ключ на всех — это чужое видео в ответ на своё. Ошибка тихая:
    // размер и тип совпадут, а байты приедут не те.
    let loads = 0;
    const open = createMediaOpener(async (client, peer, msgId) => {
        loads += 1;
        return { raw: {}, info: { size: msgId } };
    });
    const alice = {};
    const bob = {};

    assert.equal((await open(alice, "me", 5)).info.size, 5);
    assert.equal((await open(alice, "me", 6)).info.size, 6);
    assert.equal((await open(alice, "@other", 5)).info.size, 5);
    assert.equal((await open(bob, "me", 5)).info.size, 5);

    assert.equal(loads, 4, "каждая тройка клиент-чат-сообщение считается своей");
});

test("media: неудачное описание не запоминается", async () => {
    // Иначе одна сетевая ошибка запирает вложение на весь срок жизни записи:
    // клиент повторяет запрос, а шлюз повторяет отказ, не пытаясь заново.
    let attempt = 0;
    const open = createMediaOpener(async () => {
        attempt += 1;
        if (attempt === 1) throw new ProtocolError("boom", "Не вышло.");
        return { raw: {}, info: { size: 100 } };
    });
    const client = {};

    await assert.rejects(() => open(client, "me", 5));
    assert.equal((await open(client, "me", 5)).info.size, 100);
});

// ── замер выдачи файла ────────────────────────────────────────────────────────

test("media: строка замера показывает, где именно ушло время", async () => {
    // Без разбивки «долго грузится» неотличимо от «долго идёт до
    // дата-центра»: описание, ожидание первого байта и сама перекачка
    // страдают от разных причин и чинятся по-разному.
    const line = formatMediaTiming({
        msgId: 42,
        status: 206,
        bytes: 1048576,
        openMs: 120,
        ttfbMs: 340,
        totalMs: 1000,
    });

    assert.match(line, /msg=42/);
    assert.match(line, /status=206/);
    assert.match(line, /bytes=1048576/);
    assert.match(line, /open=120ms/);
    assert.match(line, /ttfb=340ms/);
    assert.match(line, /total=1000ms/);
    assert.match(line, /rate=1\.0MB\/s/);
});

test("media: замер без байтов не выдумывает скорость", async () => {
    // HEAD и 416 тела не имеют, а «0.0 МБ/с» в журнале читается как поломка
    // канала — и уводит поиск в сторону.
    const line = formatMediaTiming({ msgId: 7, status: 416, bytes: 0, openMs: 50, ttfbMs: null, totalMs: 60 });

    assert.match(line, /status=416/);
    assert.match(line, /open=50ms/);
    assert.ok(!line.includes("rate="), line);
    assert.ok(!line.includes("ttfb="), line);
});

test("media: ни один запрос к Telegram не пересекает границу мегабайта", async () => {
    // Правило upload.getFile: запрошенный кусок обязан целиком лежать внутри
    // одного мегабайта файла. Нарушение — не пустой ответ, а LIMIT_INVALID, и
    // прилетает он не в ответ на запрос, а в чтении сокета: до маршрута не
    // доходит, обработчика не находит и роняет процесс целиком.
    //
    // Выравнивание по 4096 этого не даёт: от смещения 4096 второй кусок в
    // 512 КБ уже перешагивает мегабайт.
    const PART = 512 * 1024;
    const client = {
        async getEntity() { return {}; },
        async getMessages() {
            return [{
                id: 1,
                media: {
                    className: "MessageMediaDocument",
                    document: { className: "Document", mimeType: "video/mp4", size: 8 * 1024 * 1024, attributes: [] },
                },
            }];
        },
        async *iterDownload(file, params) {
            const size = params.requestSize ?? PART;
            const first = Number(params.offset ?? 0);
            const last = first + size - 1;
            if (Math.floor(first / 1048576) !== Math.floor(last / 1048576)) {
                throw new Error(`LIMIT_INVALID: кусок ${first}..${last} пересекает границу мегабайта`);
            }
            if (first % 4096 !== 0) throw new Error(`OFFSET_INVALID: смещение ${first}`);
            yield Buffer.alloc(size);
        },
    };

    const opened = await openMedia(client, "me", 1);
    let bytes = 0;
    // Перемотка на середину видео: ровно тот запрос, который шлёт плеер.
    for await (const chunk of streamMedia(client, opened, { range: { start: 5_000_000, end: 7_000_000 } })) {
        bytes += chunk.length;
    }
    assert.equal(bytes, 2_000_001);
});

test("listener: реакции превращаются в событие reactions", () => {
    const event = classifyRawUpdate({
        className: "UpdateMessageReactions",
        peer: { value: 1000000002 },
        msgId: 42,
        topMsgId: 10,
        reactions: {
            results: [
                { reaction: { emoticon: "🔥" }, count: 3, chosenOrder: 1 },
                { reaction: { emoticon: "❤️" }, count: 1 },
            ],
        },
    });
    assert.equal(event.type, "reactions");
    assert.equal(event.chatId, "1000000002");
    assert.equal(event.msgId, 42);
    assert.equal(event.topMsgId, 10);
    assert.equal(event.reactions.length, 2);
    assert.equal(event.reactions[0].emoticon, "🔥");
    assert.equal(event.reactions[0].count, 3);
    assert.equal(event.reactions[0].chosen, true);
    assert.equal(event.reactions[1].emoticon, "❤️");
    assert.equal(event.reactions[1].chosen, false);
});

test("listener: закрепление сообщений превращается в pinned_messages", () => {
    const event = classifyRawUpdate({
        className: "UpdatePinnedChannelMessages",
        channelId: 1500000001,
        pinned: true,
        messages: [123, 124],
    });
    assert.equal(event.type, "pinned_messages");
    assert.equal(event.chatId, "-1001500000001");
    assert.equal(event.pinned, true);
    assert.deepEqual(event.messages, [123, 124]);
});

test("listener: статус пользователя превращается в user_status", () => {
    const event = classifyRawUpdate({
        className: "UpdateUserStatus",
        userId: 1000000002,
        status: { className: "UserStatusOnline", expires: 1700000000 },
    });
    assert.equal(event.type, "user_status");
    assert.equal(event.userId, "1000000002");
    assert.equal(event.online, true);
    assert.equal(event.status, "UserStatusOnline");
    assert.equal(event.expires, 1700000000000);
});

test("errors: no_avatar мапится в 404, PIN_RESTRICTED в 400", () => {
    const errAvatar = toHttpError(new ProtocolError("no_avatar", "У чата нет аватара."));
    assert.equal(errAvatar.status, 404);
    assert.equal(errAvatar.body.error, "no_avatar");

    const errPin = toHttpError(new Error("RPCError: 400: PIN_RESTRICTED"));
    assert.equal(errPin.status, 400);
    assert.equal(errPin.body.error, "message_invalid");
});

test("messages: sendMessage передаёт parseMode, quoteText, topMsgId и silent", async () => {
    let capturedParams = null;
    const client = {
        async getEntity() { return {}; },
        async sendMessage(entity, params) {
            capturedParams = params;
            return { id: 1, message: "Hello", out: true, date: 1000 };
        },
    };
    const res = await sendMessage(client, "me", "Hello", {
        parseMode: "markdown",
        replyTo: 10,
        topMsgId: 5,
        quoteText: "quoted part",
        quoteOffset: 2,
        silent: true,
        linkPreview: false,
    });
    assert.equal(res.id, 1);
    assert.equal(capturedParams.message, "Hello");
    assert.equal(capturedParams.parseMode, "markdown");
    assert.equal(capturedParams.replyTo, 10);
    assert.equal(capturedParams.topMsgId, 5);
    assert.equal(capturedParams.quoteText, "quoted part");
    assert.equal(capturedParams.quoteOffset, 2);
    assert.equal(capturedParams.silent, true);
    assert.equal(capturedParams.linkPreview, false);
});

test("messages: pinMessage и unpinMessage вызывают методы клиента", async () => {
    let pinCall = null;
    let unpinCall = null;
    const client = {
        async getEntity() { return { id: 123 }; },
        async pinMessage(entity, id, opts) {
            pinCall = { entity, id, opts };
        },
        async unpinMessage(entity, id, opts) {
            unpinCall = { entity, id, opts };
        },
    };
    const resPin = await pinMessage(client, "me", 42, { silent: true, oneSide: true });
    assert.equal(resPin.ok, true);
    assert.equal(resPin.pinned, true);
    assert.equal(pinCall.id, 42);
    assert.deepEqual(pinCall.opts, { notify: false, pmOneSide: true });

    const resUnpin = await unpinMessage(client, "me", 42);
    assert.equal(resUnpin.ok, true);
    assert.equal(resUnpin.unpinned, true);
    assert.equal(unpinCall.id, 42);

    await unpinMessage(client, "me", undefined, { topMsgId: 7 });
    assert.equal(unpinCall.id, undefined);
    assert.deepEqual(unpinCall.opts, { topMsgId: 7 });
});

test("messages: downloadAvatar проверяет photo, etag, 304 и возвращает буфер", async () => {
    const client = {
        async getEntity() {
            return {
                id: 123,
                photo: { photoId: BigInt(99999) },
            };
        },
        async downloadProfilePhoto(entity, { isBig }) {
            return Buffer.from([1, 2, 3, 4]);
        },
    };

    const avatar = await downloadAvatar(client, "me", "small");
    assert.equal(avatar.etag, '"99999-small"');
    assert.equal(avatar.notModified, false);
    assert.equal(avatar.buffer.length, 4);

    const cached = await downloadAvatar(client, "me", "small", { ifNoneMatch: '"99999-small"' });
    assert.equal(cached.notModified, true);
    assert.equal(cached.buffer, null);

    const clientNoPhoto = {
        async getEntity() { return { id: 123, photo: null }; },
    };
    await assert.rejects(
        () => downloadAvatar(clientNoPhoto, "me"),
        (err) => err instanceof ProtocolError && err.code === "no_avatar"
    );
});

