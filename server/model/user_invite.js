const { BeanModel } = require("redbean-node/dist/bean-model");
const { R } = require("redbean-node");
const crypto = require("crypto");
const dayjs = require("dayjs");

/**
 * Default lifetime of a new invite.
 * @type {number}
 */
const DEFAULT_EXPIRY_HOURS = 24;

/**
 * An admin-issued, single-use signup link.
 *
 * The plaintext token exists only in the response to create(); the database
 * holds a SHA-256 hash, so a leaked backup cannot be turned into working
 * invite links.
 */
class UserInvite extends BeanModel {
    /**
     * Hash a plaintext token for storage and lookup.
     *
     * SHA-256 is appropriate here (unlike a password) because the token is
     * high-entropy random, so there is nothing to brute-force, and the digest
     * must be reproducible to find the row.
     * @param {string} token Plaintext token
     * @returns {string} Hex digest
     */
    static hashToken(token) {
        return crypto.createHash("sha256").update(token).digest("hex");
    }

    /**
     * Current state of this invite.
     * @returns {string} "active", "used" or "expired"
     */
    getStatus() {
        if (this.used_at) {
            return "used";
        }

        if (dayjs(this.expires).isBefore(dayjs())) {
            return "expired";
        }

        return "active";
    }

    /**
     * Whether this invite can still be redeemed.
     * @returns {boolean} True if active
     */
    isRedeemable() {
        return this.getStatus() === "active";
    }

    /**
     * Serialise for the settings UI. Never includes the token.
     * @returns {object} Safe representation
     */
    toJSON() {
        return {
            id: this.id,
            note: this.note ?? null,
            createdDate: this.created_date,
            expires: this.expires,
            usedAt: this.used_at ?? null,
            status: this.getStatus(),
        };
    }

    /**
     * Mint a new invite.
     * @param {string} createdBy ID of the admin creating it
     * @param {object} options Invite options
     * @param {?string} options.note Optional label
     * @param {number} options.expiryHours Lifetime in hours
     * @returns {Promise<{invite: UserInvite, token: string}>} The row plus the
     * plaintext token, which is only ever returned here
     */
    static async create(createdBy, options = {}) {
        const note = options.note ?? null;
        const expiryHours = Number.isInteger(options.expiryHours) && options.expiryHours > 0
            ? options.expiryHours
            : DEFAULT_EXPIRY_HOURS;

        // 32 random bytes is far beyond brute-force range.
        const token = crypto.randomBytes(32).toString("base64url");

        const bean = R.dispense("user_invite");
        bean.token_hash = UserInvite.hashToken(token);
        bean.created_by = createdBy;
        bean.expires = dayjs().add(expiryHours, "hour").format("YYYY-MM-DD HH:mm:ss");
        bean.note = note;

        await R.store(bean);

        return { invite: bean, token };
    }

    /**
     * Look up an invite by its plaintext token, without consuming it.
     * @param {string} token Plaintext token
     * @returns {Promise<?UserInvite>} The invite, or null if unknown
     */
    static async findByToken(token) {
        if (typeof token !== "string" || token.length === 0) {
            return null;
        }

        // findOne returns a hydrated bean, so getStatus() is available.
        return await R.findOne("user_invite", " token_hash = ? ", [ UserInvite.hashToken(token) ]);
    }

    /**
     * Consume an invite, guaranteeing it can only be redeemed once.
     *
     * The UPDATE is conditional on used_at still being NULL, so if two
     * redemptions race, exactly one gets a row back and the loser is rejected.
     * This is what makes the link genuinely single-use rather than "probably".
     * @param {number} inviteID Invite to consume
     * @param {string} userID ID of the user created from it
     * @returns {Promise<boolean>} True if this call consumed it
     */
    static async consume(inviteID, userID) {
        const now = dayjs().format("YYYY-MM-DD HH:mm:ss");

        // knex's update() returns the affected-row count, which R.exec does
        // not. The conditional WHERE is what makes this atomic.
        const affected = await R.knex("user_invite")
            .where("id", inviteID)
            .whereNull("used_at")
            .where("expires", ">", now)
            .update({ used_at: now, used_by: userID });

        return affected > 0;
    }

    /**
     * List invites newest first.
     * @param {string} createdBy ID of the admin whose invites to list
     * @returns {Promise<UserInvite[]>} Invites
     */
    static async listForUser(createdBy) {
        // R.find (not getAll) so the rows come back as UserInvite beans with
        // toJSON()/getStatus(); getAll returns plain objects.
        return await R.find(
            "user_invite",
            " created_by = ? ORDER BY id DESC ",
            [ createdBy ]
        );
    }

    /**
     * Revoke an unused invite.
     * @param {number} inviteID Invite to revoke
     * @param {string} createdBy Owner of the invite
     * @returns {Promise<boolean>} True if an invite was revoked
     */
    static async revoke(inviteID, createdBy) {
        const invite = await R.findOne(
            "user_invite",
            " id = ? AND created_by = ? AND used_at IS NULL ",
            [ inviteID, createdBy ]
        );

        if (!invite) {
            return false;
        }

        // Delete rather than flag: the token must become unusable immediately.
        await R.trash(invite);
        return true;
    }

    /**
     * Delete invites that expired more than a day ago.
     *
     * Keeps the table from growing without bound; called periodically.
     * @returns {Promise<void>}
     */
    static async pruneExpired() {
        const cutoff = dayjs().subtract(1, "day").format("YYYY-MM-DD HH:mm:ss");
        await R.exec("DELETE FROM user_invite WHERE expires < ?", [ cutoff ]);
    }
}

module.exports = UserInvite;
module.exports.DEFAULT_EXPIRY_HOURS = DEFAULT_EXPIRY_HOURS;