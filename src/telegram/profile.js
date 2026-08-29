import { CustomFile } from "teleproto/client/uploads.js";
import { Api } from "teleproto";
import { idToString } from "./serialize.js";

/**
 * Текущий пользователь аккаунта.
 * @param {import("teleproto").TelegramClient} client
 * @returns {Promise<object>}
 */
export async function getMe(client) {
    const me = await client.getMe();
    return {
        id: idToString(me.id),
        firstName: me.firstName || "",
        lastName: me.lastName || "",
        username: me.username || null,
        phone: me.phone || null,
        bot: Boolean(me.bot),
        photo: me.photo ? { id: idToString(me.photo.photoId || me.photo.id) } : null,
        status: me.status?.className || null,
    };
}

/**
 * Обновление профиля (имя/фамилия/био).
 * @param {import("teleproto").TelegramClient} client
 * @param {object} patch { firstName, lastName, about }
 * @returns {Promise<object>}
 */
export async function updateProfile(client, { firstName, lastName, about } = {}) {
    const params = {};
    if (firstName !== undefined) params.firstName = firstName;
    if (lastName !== undefined) params.lastName = lastName;
    if (about !== undefined) params.about = about;
    await client.updateProfile(params);
    return getMe(client);
}

/**
 * Установка аватара аккаунта. Рецепт: uploadFile → photos.UploadProfilePhoto.
 * @param {import("teleproto").TelegramClient} client
 * @param {Buffer} buffer
 */
export async function setProfilePhoto(client, buffer) {
    const uploaded = await client.uploadFile({
        file: new CustomFile("avatar", buffer.length, "", buffer),
    });
    await client.invoke(new Api.photos.UploadProfilePhoto({ file: uploaded }));
    return getMe(client);
}

/**
 * Статус присутствия аккаунта (online/offline) через raw account.UpdateStatus.
 * @param {import("teleproto").TelegramClient} client
 * @param {boolean} online
 */
export async function setStatus(client, online) {
    await client.invoke(new Api.account.UpdateStatus({ offline: !online }));
}