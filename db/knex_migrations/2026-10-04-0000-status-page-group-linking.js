/**
 * Adds status-page fields for group-generated pages and per-client branding.
 *
 * `accent_color` lets each client's status page carry its own brand colour.
 * It is applied as a CSS custom property and never drives the status palette,
 * so "up / degraded / outage" keep the same meaning on every page.
 *
 * `source_group_monitor_id` records the `type: "group"` monitor a page was
 * generated from. There is deliberately no foreign key: the page outlives the
 * group (a deleted group unpublishes rather than deletes), and a dangling
 * pointer is how such a page is identified.
 *
 * `generated` marks pages Flatline created, so the UI can present them
 * differently and never offer destructive edits that the sync would undo.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.up = function (knex) {
    return knex.schema
        .alterTable("status_page", function (table) {
            // Free-form hex, validated in application code.
            table.string("accent_color", 9).defaultTo(null);

            // No FK on purpose; see the note above.
            table.integer("source_group_monitor_id").unsigned().defaultTo(null);

            table.boolean("generated").notNullable().defaultTo(false);
        })
        .then(() => knex.schema.alterTable("status_page", function (table) {
            table.index([ "source_group_monitor_id" ], "status_page_source_group_monitor_id_idx");
            table.index([ "generated" ], "status_page_generated_idx");
        }));
};

/**
 * Removes the group-linking and branding columns from status_page.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.down = function (knex) {
    return knex.schema.alterTable("status_page", function (table) {
        table.dropIndex([], "status_page_source_group_monitor_id_idx");
        table.dropIndex([], "status_page_generated_idx");
        table.dropColumn("accent_color");
        table.dropColumn("source_group_monitor_id");
        table.dropColumn("generated");
    });
};