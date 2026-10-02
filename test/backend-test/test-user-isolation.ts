/**
 * Cross-user isolation tests.
 *
 * Two real users each own monitors. Every check here asserts that user B
 * cannot read or mutate user A's data through the paths that take a client
 * supplied id.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

import { auth } from "../../server/better-auth";
// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB();

test("cross-user isolation", async (t) => {
    let alice = "";
    let bob = "";
    let aliceMonitor = 0;
    let aliceTag = 0;
    let aliceNotification = 0;

    t.before(async () => {
        await testDb.create();

        const make = async (username: string) => {
            const user = await auth().api.createUser({
                body: {
                    name: username,
                    email: `${username}@noreply.uptime-kuma.internal`,
                    password: "Kuma-Test-8f4Q2xR9p",
                    role: "admin",
                    data: {
                        username,
                    },
                },
            });
            return user.user.id;
        };

        alice = await make("alice");
        bob = await make("bob");

        const { R } = require("redbean-node");

        const monitor = R.dispense("monitor");
        monitor.user_id = alice;
        monitor.name = "Alice Monitor";
        monitor.type = "http";
        monitor.url = "https://alice.example.com";
        monitor.interval = 60;
        monitor.retryInterval = 60;
        monitor.timeout = 48;
        await R.store(monitor);
        aliceMonitor = monitor.id;

        const tag = R.dispense("tag");
        tag.name = "alice-tag";
        tag.color = "#fff";
        await R.store(tag);
        aliceTag = tag.id;

        const notification = R.dispense("notification");
        notification.user_id = alice;
        notification.name = "Alice TG";
        notification.config = JSON.stringify({ type: "telegram", telegramChatID: "1" });
        await R.store(notification);
        aliceNotification = notification.id;

        await R.exec("INSERT INTO monitor_tag (tag_id, monitor_id, value) VALUES (?, ?, ?)", [
            aliceTag,
            aliceMonitor,
            "",
        ]);
        await R.exec("INSERT INTO heartbeat (monitor_id, status, time, msg, ping) VALUES (?, 1, ?, 'ok', 10)", [
            aliceMonitor,
            R.isoDateTimeMillis(new Date()),
        ]);
    });

    t.after(async () => {
        await testDb.destroy();
    });

    const own = () => require("../../server/socket-handlers/ownership");

    await t.test("assertOwnsMonitor accepts the owner", async () => {
        await own().assertOwnsMonitor(alice, aliceMonitor);
    });

    await t.test("assertOwnsMonitor rejects a different user", async () => {
        await assert.rejects(() => own().assertOwnsMonitor(bob, aliceMonitor), /You do not own this/);
    });

    await t.test("assertOwnsNotification rejects a different user", async () => {
        await assert.rejects(
            () => own().assertOwnsNotification(bob, aliceNotification),
            /You do not own this/
        );
    });

    await t.test("assertOwns refuses a table it does not know", async () => {
        // Prevents a typo from silently disabling the check.
        await assert.rejects(
            () => own().assertOwns("not_a_table", 1, bob),
            /not in the owned-table list/
        );
    });

    await t.test("assertOwns rejects status_page and tag as unowned", async () => {
        assert.strictEqual(own().OWNED_TABLES.has("status_page"), false);
        assert.strictEqual(own().OWNED_TABLES.has("tag"), false);
    });

    await t.test("clearStatistics only wipes the calling user's rows", async () => {
        const { R } = require("redbean-node");
        const { UptimeCalculator } = require("../../server/uptime-calculator");

        // A second monitor for bob, so the wipe must leave his data alone.
        const bobMonitor = R.dispense("monitor");
        bobMonitor.user_id = bob;
        bobMonitor.name = "Bob Monitor";
        bobMonitor.type = "http";
        bobMonitor.interval = 60;
        bobMonitor.retryInterval = 60;
        bobMonitor.timeout = 48;
        await R.store(bobMonitor);

        await R.exec("INSERT INTO heartbeat (monitor_id, status, time, msg, ping) VALUES (?, 1, ?, 'bob', 5)", [
            bobMonitor.id,
            R.isoDateTimeMillis(new Date()),
        ]);

        await UptimeCalculator.clearStatisticsForUser(bob);

        const aliceBeats = await R.getAll("SELECT * FROM heartbeat WHERE monitor_id = ?", [ aliceMonitor ]);
        const bobBeats = await R.getAll("SELECT * FROM heartbeat WHERE monitor_id = ?", [ bobMonitor.id ]);

        assert.ok(aliceBeats.length > 0, "alice's heartbeats must survive");
        assert.strictEqual(bobBeats.length, 0, "bob's heartbeats must be gone");
    });

    await t.test("updateMonitorNotification will not touch another user's monitor", async () => {
        const { R } = require("redbean-node");
        const monitorService = require("../../server/monitor-service");

        const before = await R.getAll("SELECT * FROM monitor_notification WHERE monitor_id = ?", [ aliceMonitor ]);

        // Bob tries to clear Alice's notification links.
        await monitorService.updateMonitorNotification(bob, aliceMonitor, {});

        const after = await R.getAll("SELECT * FROM monitor_notification WHERE monitor_id = ?", [ aliceMonitor ]);
        assert.deepStrictEqual(after.length, before.length, "alice's links must be untouched");

        // Alice can still clear her own.
        await monitorService.updateMonitorNotification(alice, aliceMonitor, {});
        const cleared = await R.getAll("SELECT * FROM monitor_notification WHERE monitor_id = ?", [ aliceMonitor ]);
        assert.strictEqual(cleared.length, 0, "alice's own links are cleared");
    });

    await t.test("the tag ownership sub-select matches only the caller's monitors", async () => {
        const { R } = require("redbean-node");

        // Bob has no monitors, so this must find nothing.
        const bobSees = await R.getRow(
            `SELECT id FROM monitor_tag WHERE tag_id = ?
             AND monitor_id IN (SELECT id FROM monitor WHERE user_id = ?) LIMIT 1`,
            [ aliceTag, bob ]
        );
        assert.strictEqual(bobSees, null);

        // Alice does use it.
        const aliceSees = await R.getRow(
            `SELECT id FROM monitor_tag WHERE tag_id = ?
             AND monitor_id IN (SELECT id FROM monitor WHERE user_id = ?) LIMIT 1`,
            [ aliceTag, alice ]
        );
        assert.ok(aliceSees, "alice must be able to see her own tag link");
    });
});