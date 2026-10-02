/**
 * Adds a `scopes` column to `api_key` so a token can be restricted to
 * read-only or read/write access. Existing keys get NULL, which is
 * treated as full access, so no existing token breaks.
 */
/**
 * Add the `scopes` column to `api_key`.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.up = function (knex) {
    return knex.schema.alterTable("api_key", function (table) {
        // Comma separated list of scopes: "read", "write", or "read,write".
        // NULL means legacy/unscoped and is treated as "read,write".
        table.text("scopes").defaultTo(null);
    });
};

/**
 * Remove the `scopes` column from `api_key`.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.down = function (knex) {
    return knex.schema.alterTable("api_key", function (table) {
        table.dropColumn("scopes");
    });
};