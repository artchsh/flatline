const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const { hasUser } = require("../routers/better-auth-router");

/**
 * Send the list of accounts to the client.
 *
 * Flatline has no roles: every user can list and remove accounts. Shared data
 * (monitors, notifications, maintenance) is not owned by a user, so removing
 * one does not touch it.
 * @param {Socket} socket Socket.io instance
 * @returns {Promise<void>}
 */
async function sendUserList(socket) {
    const rows = await R.getAll(
        `SELECT id, name, email, username, createdAt, banned FROM better_auth_user ORDER BY createdAt`
    );

    socket.emit("userList", rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        username: u.username ?? null,
        createdAt: u.createdAt,
        banned: !!u.banned,
        isCurrent: u.id === socket.userID,
    })));
}

/**
 * Handlers for account administration.
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.userSocketHandler = (socket) => {
    /**
     * List every account.
     */
    socket.on("getUserList", async (callback) => {
        try {
            checkLogin(socket);
            await sendUserList(socket);
            callback({ ok: true });
        } catch (e) {
            log.error("auth", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    /**
     * Delete an account.
     *
     * Refuses to delete the last remaining account: the instance would then be
     * unreachable, since signup is invite-only and requires an existing user.
     */
    socket.on("deleteUser", async (userID, callback) => {
        try {
            checkLogin(socket);

            if (typeof userID !== "string" || userID.length === 0) {
                throw new Error("Invalid user id.");
            }

            if (userID === socket.userID) {
                throw new Error("You cannot remove your own account.");
            }

            const target = await R.findOne("better_auth_user", " id = ? ", [ userID ]);
            if (!target) {
                throw new Error("No such user.");
            }

            // Count everyone else first; we must never delete the last one.
            const { count } = await R.getRow("SELECT COUNT(*) AS count FROM better_auth_user");
            if (Number(count) <= 1) {
                throw new Error("Cannot remove the only remaining account.");
            }

            // Removed directly rather than through auth().api.removeUser(),
            // which re-checks a better-auth session we do not have here. Access
            // is already gated by checkLogin() and Flatline has no roles.
            await R.exec("DELETE FROM better_auth_session WHERE userId = ?", [ userID ]);
            await R.exec("DELETE FROM better_auth_account WHERE userId = ?", [ userID ]);
            await R.exec("DELETE FROM better_auth_twoFactor WHERE userId = ?", [ userID ]);
            await R.exec("DELETE FROM better_auth_verification WHERE identifier = ?", [ target.email ]);
            await R.exec("DELETE FROM better_auth_apikey WHERE referenceId = ?", [ userID ]);

            // Invite links minted by this user would otherwise linger.
            await R.exec("DELETE FROM user_invite WHERE created_by = ?", [ userID ]);

            await R.exec("DELETE FROM better_auth_user WHERE id = ?", [ userID ]);

            log.info("auth", `Deleted user ${userID} by ${socket.userID}`);

            await sendUserList(socket);

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
            });
        } catch (e) {
            log.error("auth", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    /**
     * Ban or unban an account without deleting it.
     *
     * Bans revoke existing sessions, so this is the reversible option: the
     * person loses access immediately but their row (and the audit trail)
     * survives.
     */
    socket.on("setUserBanned", async (userID, banned, callback) => {
        try {
            checkLogin(socket);

            if (typeof userID !== "string" || userID.length === 0) {
                throw new Error("Invalid user id.");
            }

            if (userID === socket.userID) {
                throw new Error("You cannot ban your own account.");
            }

            const target = await R.findOne("better_auth_user", " id = ? ", [ userID ]);
            if (!target) {
                throw new Error("No such user.");
            }

            // See deleteUser: done directly because the better-auth admin
            // endpoints require their own session.
            if (banned) {
                await R.exec(
                    "UPDATE better_auth_user SET banned = 1, banReason = ? WHERE id = ?",
                    [ "Banned from the Flatline users panel", userID ]
                );

                // A ban must take effect immediately, so drop live sessions.
                await R.exec("DELETE FROM better_auth_session WHERE userId = ?", [ userID ]);
            } else {
                await R.exec(
                    "UPDATE better_auth_user SET banned = 0, banReason = NULL, banExpires = NULL WHERE id = ?",
                    [ userID ]
                );
            }

            log.info("auth", `${banned ? "Banned" : "Unbanned"} user ${userID} by ${socket.userID}`);

            await sendUserList(socket);

            callback({
                ok: true,
                msg: banned ? "successEdited" : "successEdited",
                msgi18n: true,
            });
        } catch (e) {
            log.error("auth", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    /**
     * Whether any account exists, so the UI can tell "needs an invite" from
     * "needs first-run setup".
     */
    socket.on("getUserInviteEnabled", async (callback) => {
        try {
            const usersExist = await hasUser();
            callback({
                ok: true,
                enabled: usersExist,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};

module.exports.sendUserList = sendUserList;