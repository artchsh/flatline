/**
 * Ownership guards for Socket.IO handlers.
 *
 * Upstream relies on the frontend only ever sending ids the user already owns.
 * That is not a security boundary: any logged-in user can emit any id. These
 * helpers make ownership an actual check, so a handler that forgets cannot leak
 * or mutate another user's data.
 */
const { R } = require("redbean-node");

/**
 * Tables with a direct `user_id` column, verified against the schema.
 *
 * `tag` and `status_page` are deliberately absent: neither has a user_id
 * column and both are shared across the instance by upstream design. See
 * FORK-ROADMAP.md for the implications.
 *
 * Join tables (monitor_notification, monitor_tag) are absent too; they are
 * reached through their parent monitor instead.
 * @type {Set<string>}
 */
const OWNED_TABLES = new Set([
    "monitor",
    "notification",
    "maintenance",
    "proxy",
    "docker_host",
    "remote_browser",
    "api_key",
]);

/**
 * Assert that a row belongs to the given user.
 * @param {string} table Table to check
 * @param {number|string} id Row id
 * @param {string} userID Owning user
 * @returns {Promise<void>}
 * @throws {Error} If the row does not exist or is owned by someone else
 */
async function assertOwns(table, id, userID) {
    if (!OWNED_TABLES.has(table)) {
        throw new Error(`assertOwns: table "${table}" is not in the owned-table list.`);
    }

    // `table` is constrained to OWNED_TABLES, never taken from user input, so
    // this interpolation cannot be injected.
    const row = await R.getRow(`SELECT id FROM \`${table}\` WHERE id = ? AND user_id = ?`, [ id, userID ]);

    if (!row) {
        // Deliberately identical to "not found" so this cannot be used to
        // probe which ids exist.
        throw new Error("You do not own this.");
    }
}

/**
 * Assert the user owns a monitor. Throws the standard ownership error.
 * @param {string} userID Owning user
 * @param {number} monitorID Monitor id
 * @returns {Promise<void>}
 * @throws {Error} If not owned
 */
async function assertOwnsMonitor(userID, monitorID) {
    await assertOwns("monitor", monitorID, userID);
}

/**
 * Assert the user owns a notification.
 * @param {string} userID Owning user
 * @param {number} notificationID Notification id
 * @returns {Promise<void>}
 * @throws {Error} If not owned
 */
async function assertOwnsNotification(userID, notificationID) {
    await assertOwns("notification", notificationID, userID);
}

/**
 * Assert the user owns a monitor that is linked to the given notification.
 *
 * Used by the monitor<->notification link handlers, where both ids come from
 * the client and either could belong to someone else.
 * @param {string} userID Owning user
 * @param {number} monitorID Monitor id
 * @param {number} notificationID Notification id
 * @returns {Promise<void>}
 * @throws {Error} If either is not owned
 */
async function assertOwnsMonitorNotification(userID, monitorID, notificationID) {
    await assertOwnsMonitor(userID, monitorID);
    await assertOwnsNotification(userID, notificationID);
}

module.exports = {
    OWNED_TABLES,
    assertOwns,
    assertOwnsMonitor,
    assertOwnsNotification,
    assertOwnsMonitorNotification,
};