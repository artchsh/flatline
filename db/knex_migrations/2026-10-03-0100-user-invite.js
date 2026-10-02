/**
 * Adds a `user_invite` table for admin-issued, single-use signup links.
 *
 * Flatline has no public signup: an existing user mints a link and sends it
 * over whatever channel they already trust. The recipient sets their own
 * username and password at redemption, so no email infrastructure is needed.
 *
 * The token is stored as a SHA-256 hash, never in plaintext, so a leaked
 * database or backup cannot be replayed into account creation.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.up = function (knex) {
    return knex.schema.createTable("user_invite", function (table) {
        table.increments("id").primary();

        // SHA-256 of the emailed token. Indexed so redemption is one lookup.
        table.string("token_hash", 64).notNullable().unique();

        // Who minted it. better_auth_user.id is a string, not an integer.
        table
            .string("created_by", 255)
            .notNullable()
            .references("id")
            .inTable("better_auth_user")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");

        table.dateTime("created_date").defaultTo(knex.fn.now()).notNullable();

        // Links expire so an abandoned one is not a permanent open door.
        table.dateTime("expires").notNullable();

        // NULL until redeemed, which is what makes the link single-use.
        table.dateTime("used_at").defaultTo(null);
        table.string("used_by", 255).defaultTo(null);

        // Optional label so an admin can tell invites apart later.
        table.string("note", 255).defaultTo(null);
    });
};

/**
 * Drops the `user_invite` table.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.down = function (knex) {
    return knex.schema.dropTable("user_invite");
};