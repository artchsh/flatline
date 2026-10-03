const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const UserInvite = require("../model/user_invite");
const { auth } = require("../better-auth");
const { inviteRateLimiter } = require("../rate-limiter");

/**
 * Send the current user's invite list to the client.
 *
 * Flatline has no roles: every logged-in user is an admin, so "created_by" is
 * simply the caller. That keeps the UI simple and matches the no-permissions
 * model.
 * @param {Socket} socket Socket.io instance
 * @returns {Promise<void>}
 */
async function sendUserInviteList(socket) {
    const list = await UserInvite.listForUser(socket.userID);

    const result = {};
    for (const invite of list) {
        result[invite.id] = invite.toJSON();
    }

    socket.emit("userInviteList", result);
}

/**
 * Handlers for user invite links.
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.userInviteSocketHandler = (socket) => {
    /**
     * Mint a new single-use invite link.
     */
    socket.on("createUserInvite", async (options, callback) => {
        try {
            checkLogin(socket);

            const opts = options ?? {};
            const note = typeof opts.note === "string" ? opts.note.slice(0, 255) : null;

            // Bound the lifetime so a forgotten link cannot be used months later.
            let expiryHours = UserInvite.DEFAULT_EXPIRY_HOURS;
            if (opts.expiryHours !== undefined) {
                const requested = Number(opts.expiryHours);
                if (!Number.isInteger(requested) || requested < 1 || requested > 720) {
                    throw new Error("expiryHours must be an integer between 1 and 720.");
                }
                expiryHours = requested;
            }

            const { invite, token } = await UserInvite.create(socket.userID, { note, expiryHours });

            log.info("auth", `Created user invite ${invite.id} by User ID: ${socket.userID}`);

            await sendUserInviteList(socket);

            // The plaintext token is returned exactly once, here.
            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
                inviteID: invite.id,
                token,
                expires: invite.expires,
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
     * List the current user's invites.
     */
    socket.on("getUserInviteList", async (callback) => {
        try {
            checkLogin(socket);
            await sendUserInviteList(socket);
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
     * Revoke an unused invite.
     */
    socket.on("revokeUserInvite", async (inviteID, callback) => {
        try {
            checkLogin(socket);

            const id = parseInt(inviteID);
            if (!Number.isInteger(id)) {
                throw new Error("Invalid invite id.");
            }

            const revoked = await UserInvite.revoke(id, socket.userID);

            if (!revoked) {
                throw new Error("Invite not found, already used, or not yours.");
            }

            log.info("auth", `Revoked user invite ${id} by User ID: ${socket.userID}`);

            await sendUserInviteList(socket);

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
     * Check an invite's status without redeeming it.
     *
     * Lets the signup page show "this link has expired" instead of failing on
     * submit. Deliberately unauthenticated: the recipient is not logged in yet.
     */
    socket.on("checkUserInvite", async (token, callback) => {
        try {
            const invite = await UserInvite.findByToken(token);

            if (!invite) {
                throw new Error("This invite link is not valid.");
            }

            const status = invite.getStatus();

            if (status === "used") {
                throw new Error("This invite link has already been used.");
            }

            if (status === "expired") {
                throw new Error("This invite link has expired. Ask for a new one.");
            }

            callback({
                ok: true,
                status,
                expires: invite.expires,
                // Only surface the note; the creating user has no roles, so
                // there is nothing to gate on.
                note: invite.note ?? null,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    /**
     * Redeem an invite: create the account it was minted for.
     *
     * Unauthenticated on purpose — the recipient is not logged in yet. The
     * token itself is the credential, so it is the only thing accepted.
     */
    socket.on("redeemUserInvite", async (token, username, password, callback) => {
        try {
            // Unauthenticated endpoint, so cap attempts before doing any work.
            const remaining = await inviteRateLimiter.removeTokens(1);
            if (remaining < 0) {
                throw new Error("Too frequently, try again later.");
            }

            if (typeof username !== "string" || username.trim().length === 0) {
                throw new Error("Username is required.");
            }

            if (typeof password !== "string" || password.length < 8) {
                throw new Error("Password must be at least 8 characters.");
            }

            const cleanUsername = username.trim();

            // Reject a taken username before consuming the invite, so a typo
            // does not burn a single-use link.
            const existing = await R.findOne("better_auth_user", " username = ? ", [ cleanUsername ]);
            if (existing) {
                throw new Error("That username is already taken.");
            }

            const invite = await UserInvite.findByToken(token);
            if (!invite) {
                throw new Error("This invite link is not valid.");
            }

            if (invite.getStatus() === "used") {
                throw new Error("This invite link has already been used.");
            }

            if (invite.getStatus() === "expired") {
                throw new Error("This invite link has expired. Ask for a new one.");
            }

            // Reuse the same account-creation path as first-run setup so
            // username, email and 2FA handling stay identical.
            const user = await auth().api.createUser({
                body: {
                    name: cleanUsername,
                    email: `${cleanUsername}@noreply.uptime-kuma.internal`,
                    password,
                    role: "admin",
                    data: {
                        username: cleanUsername,
                    },
                },
            });

            // Consume last, and only if this call is the one that created the
            // account. If two redemptions race, the loser cleans up after
            // itself rather than leaving a second account behind.
            const consumed = await UserInvite.consume(invite.id, user.user.id);

            if (!consumed) {
                await R.exec("DELETE FROM better_auth_user WHERE id = ?", [ user.user.id ]);
                throw new Error("This invite link has already been used.");
            }

            log.info("auth", `Redeemed user invite ${invite.id} as ${cleanUsername}`);

            callback({
                ok: true,
                username: cleanUsername,
            });
        } catch (e) {
            log.error("auth", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};

/**
 * Periodically drop long-expired invites.
 *
 * Redeeming already refuses expired links, so this is only housekeeping to
 * stop the table growing without bound.
 * @returns {NodeJS.Timeout} The interval handle
 */
function startInvitePruner() {
    const timer = setInterval(() => {
        UserInvite.pruneExpired().catch((e) => {
            log.error("auth", `Failed to prune expired invites: ${e.message}`);
        });
    }, 60 * 60 * 1000);

    // Do not hold the process open for housekeeping.
    timer.unref?.();
    return timer;
}

module.exports.sendUserInviteList = sendUserInviteList;
module.exports.startInvitePruner = startInvitePruner;