/**
 * Adds the `monitor_metric` table for Superboard fleet metrics.
 *
 * One row per agent push: the monitor it belongs to, when it arrived, and the
 * raw JSON payload. The server does not interpret the payload in v1 — it
 * validates shape, stores, and serves it back to the board.
 *
 * Cascade delete is correct here (unlike source_group_monitor_id): metrics
 * for a deleted monitor are meaningless, so they go with it.
 *
 * Retention is enforced by a prune job, not by this migration: 30 days of
 * minute-resolution samples, then deleted.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.up = function (knex) {
    return knex.schema
        .createTable("monitor_metric", function (table) {
            table.increments("id").primary();
            table
                .integer("monitor_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("monitor")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");
            table.dateTime("time").notNullable();
            table.text("payload", "longtext").notNullable();
            table.index([ "monitor_id", "time" ], "monitor_metric_monitor_time_idx");
        });
};

/**
 * Drops the `monitor_metric` table.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.down = function (knex) {
    return knex.schema.dropTable("monitor_metric");
};
