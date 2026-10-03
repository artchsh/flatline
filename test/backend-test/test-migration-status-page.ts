/**
 * Verifies the status_page group-linking migration applies cleanly and that
 * the new columns behave.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

// Imported so better-auth (and therefore database.js) loads before the DB is
// opened; without this the data dir is not initialised when it is first read.
// @ts-ignore
import { auth } from "../../server/better-auth";
// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB();

test("status_page group-linking migration", async (t) => {
    t.before(async () => {
        await testDb.create();
        // Force the auth instance to be built now that the data dir exists,
        // matching the bootstrap order the other backend tests rely on.
        await auth();
    });

    t.after(async () => {
        await testDb.destroy();
    });

    const cols = async () => {
        const { R } = require("redbean-node");
        const info = await R.knex("status_page").columnInfo();
        return Object.keys(info);
    };

    await t.test("adds accent_color, source_group_monitor_id and generated", async () => {
        const names = await cols();
        assert.ok(names.includes("accent_color"), "accent_color missing");
        assert.ok(names.includes("source_group_monitor_id"), "source_group_monitor_id missing");
        assert.ok(names.includes("generated"), "generated missing");
    });

    await t.test("new columns default safely on an existing row", async () => {
        const { R } = require("redbean-node");
        const row = R.dispense("status_page");
        row.title = "Legacy";
        row.slug = "legacy";
        row.icon = "";
        row.theme = "auto";
        await R.store(row);

        const back = await R.findOne("status_page", " slug = ? ", [ "legacy" ]);
        assert.strictEqual(back.accent_color, null, "accent defaults to null");
        assert.strictEqual(back.source_group_monitor_id, null, "source group defaults to null");
        assert.ok(!back.generated, "generated defaults to false");
    });

    await t.test("stores an accent colour and a source group", async () => {
        const { R } = require("redbean-node");
        const row = R.dispense("status_page");
        row.title = "Client A";
        row.slug = "client-a";
        row.icon = "";
        row.theme = "auto";
        row.accent_color = "#1e40af";
        row.source_group_monitor_id = 42;
        row.generated = true;
        await R.store(row);

        const back = await R.findOne("status_page", " slug = ? ", [ "client-a" ]);
        assert.strictEqual(back.accent_color, "#1e40af");
        assert.strictEqual(back.source_group_monitor_id, 42);
        // SQLite stores booleans as 0/1, so assert truthiness.
        assert.ok(back.generated);
    });

    await t.test("source_group_monitor_id has no foreign key", async () => {
        // The page must survive its source group being deleted, so a dangling
        // pointer is expected and has to be allowed.
        const { R } = require("redbean-node");
        const row = R.dispense("status_page");
        row.title = "Orphan";
        row.slug = "orphan";
        row.icon = "";
        row.theme = "auto";
        row.source_group_monitor_id = 999999;
        await R.store(row);

        const back = await R.findOne("status_page", " slug = ? ", [ "orphan" ]);
        assert.ok(back, "row with a dangling source group must persist");
    });
});
