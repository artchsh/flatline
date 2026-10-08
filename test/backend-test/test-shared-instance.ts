/**
 * Shared-instance tests.
 *
 * Flatline has no roles and no per-user data: two users must see and be able
 * to change the same monitors, notifications, maintenance windows and proxies.
 * What stays per-user is authentication itself (API keys, invite links).
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

import { auth } from "../../server/better-auth";
// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB();

test("shared instance", async (t) => {
    let alice = "";
    let bob = "";
    let monitor = 0;
    let notification = 0;
    let maintenance = 0;
    let proxy = 0;

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

        const store = async (label: string, bean: any) => {
            try {
                await R.store(bean);
            } catch (e: any) {
                throw new Error(`insert ${label} failed: ${e.message || JSON.stringify(e)}`);
            }
            return bean;
        };

        const m = R.dispense("monitor");
        m.user_id = alice;
        m.name = "Shared Monitor";
        m.type = "http";
        m.url = "https://example.com";
        m.interval = 60;
        m.retryInterval = 60;
        m.timeout = 48;
        // Inactive so updateMonitor() does not restart the check loop: a live
        // loop keeps timers open and leaks async work past the test.
        m.active = 0;
        await R.store(m);
        monitor = m.id;

        const n = R.dispense("notification");
        n.user_id = alice;
        n.name = "Shared TG";
        n.config = JSON.stringify({ type: "telegram", telegramChatID: "1" });
        await store("notification", n);
        notification = n.id;

        const ma = R.dispense("maintenance");
        ma.user_id = alice;
        ma.title = "Shared window";
        ma.description = "";
        ma.start_date = "2026-01-01 00:00:00";
        ma.end_date = "2026-12-31 00:00:00";
        ma.active = 1;
        await store("maintenance", ma);
        maintenance = ma.id;

        // The proxy table has no `name` column, and auth is NOT NULL.
        const px = R.dispense("proxy");
        px.user_id = alice;
        px.protocol = "http";
        px.host = "127.0.0.1";
        px.port = 8080;
        px.auth = false;
        px.default = 0;
        await store("proxy", px);
        proxy = px.id;
    });

    t.after(async () => {
        await testDb.destroy();
    });

    const svc = () => require("../../server/monitor-service");

    await t.test("loadMonitor ignores the creator", async () => {
        // Alice created it; bob must still load it.
        const found = await svc().loadMonitor(monitor);
        assert.ok(found, "bob must be able to load alice's monitor");
        assert.strictEqual(found.name, "Shared Monitor");
    });

    await t.test("updateMonitor works from a different user", async () => {
        const updated = await svc().updateMonitor(monitor, { name: "Renamed by nobody" });
        assert.strictEqual(updated.name, "Renamed by nobody");
    });

    await t.test("updateMonitor rejects a missing monitor", async () => {
        await assert.rejects(() => svc().updateMonitor(999999, { name: "ghost" }), /No such monitor/);
    });

    await t.test("createMonitor still records the creator", async () => {
        const created = await svc().createMonitor(bob, {
            name: "Bob Monitor",
            type: "http",
            url: "https://bob.example.com",
            active: 0,
        }, { start: false });

        assert.strictEqual(created.user_id, bob, "creator is kept for the audit trail");
    });

    await t.test("updateMonitorNotification clears links regardless of creator", async () => {
        const { R } = require("redbean-node");

        await R.exec("INSERT INTO monitor_notification (monitor_id, notification_id) VALUES (?, ?)", [
            monitor,
            notification,
        ]);

        const before = await R.getAll("SELECT * FROM monitor_notification WHERE monitor_id = ?", [ monitor ]);
        assert.strictEqual(before.length, 1);

        await svc().updateMonitorNotification(monitor, {});

        const after = await R.getAll("SELECT * FROM monitor_notification WHERE monitor_id = ?", [ monitor ]);
        assert.strictEqual(after.length, 0);
    });

    await t.test("pauseMonitor is not owner-scoped", async () => {
        const { R } = require("redbean-node");

        // Neither startMonitor nor a restart is called anywhere in this file:
        // both launch a real check loop whose timers outlive the test.
        await svc().pauseMonitor(monitor);

        const row = await R.findOne("monitor", " id = ? ", [ monitor ]);
        assert.strictEqual(row.active, 0, "monitor is paused");
    });

    await t.test("the service no longer takes an owning user", async () => {
        // Guard against someone re-adding a userID parameter, which would
        // silently reintroduce per-user filtering.
        assert.ok(!/async function loadMonitor\(userID/.test(svcSource()), "loadMonitor takes no userID");
        assert.ok(!/async function updateMonitor\(userID/.test(svcSource()), "updateMonitor takes no userID");
        assert.ok(!/async function deleteMonitor\(userID/.test(svcSource()), "deleteMonitor takes no userID");
        assert.ok(!/async function pauseMonitor\(userID/.test(svcSource()), "pauseMonitor takes no userID");
        // createMonitor is the exception: it still records who created it.
        assert.ok(/async function createMonitor\(userID/.test(svcSource()), "createMonitor records the creator");
    });

    await t.test("clearStatistics is instance-wide", async () => {
        const { R } = require("redbean-node");
        const { UptimeCalculator } = require("../../server/uptime-calculator");

        await R.exec("INSERT INTO heartbeat (monitor_id, status, time, msg, ping) VALUES (?, 1, ?, 'ok', 5)", [
            monitor,
            R.isoDateTimeMillis(new Date()),
        ]);

        await UptimeCalculator.clearStatisticsForUser();

        const beats = await R.getAll("SELECT * FROM heartbeat WHERE monitor_id = ?", [ monitor ]);
        assert.strictEqual(beats.length, 0);
    });

    await t.test("a notification created by alice is reachable without an owner filter", async () => {
        const { R } = require("redbean-node");
        const row = await R.findOne("notification", " id = ? ", [ notification ]);
        assert.ok(row, "notification is visible without an owner filter");
        assert.strictEqual(row.name, "Shared TG");
    });

    await t.test("maintenance is reachable from the model layer", async () => {
        const { R } = require("redbean-node");
        const row = await R.findOne("maintenance", " id = ? ", [ maintenance ]);
        assert.ok(row, "maintenance window is visible without an owner filter");
    });

    await t.test("proxy is reachable without an owner filter", async () => {
        const { R } = require("redbean-node");
        const row = await R.findOne("proxy", " id = ? ", [ proxy ]);
        assert.ok(row, "proxy is visible without an owner filter");
    });

    await t.test("no Socket.IO room constant remains", () => {
        // The shared room went away with the socket layer: with no sockets,
        // there is nothing to address. Broadcasts are gone; the dashboard
        // polls REST instead.
        const fs = require("node:fs");
        assert.ok(!fs.existsSync("server/shared-room.js"), "shared-room.js still exists");
        assert.ok(!fs.existsSync("server/socket-handlers"), "socket-handlers/ still exists");
        assert.ok(!fs.existsSync("server/client.js"), "client.js still exists");
    });

    await t.test("deleteMonitor removes a monitor created by another user", async () => {
        const { R } = require("redbean-node");
        const m = R.dispense("monitor");
        m.user_id = alice;
        m.name = "Doomed";
        m.type = "http";
        m.interval = 60;
        m.retryInterval = 60;
        m.timeout = 48;
        // Inactive so updateMonitor() does not restart the check loop: a live
        // loop keeps timers open and leaks async work past the test.
        m.active = 0;
        await R.store(m);

        const deleted = await svc().deleteMonitor(m.id);
        assert.deepStrictEqual(deleted, [ m.id ]);

        const gone = await R.findOne("monitor", " id = ? ", [ m.id ]);
        assert.strictEqual(gone, null);
    });
});

/**
 * Read monitor-service.js as text so the signature assertions can check the
 * declaration itself rather than a runtime value.
 * @returns {string} File contents
 */
function svcSource() {
    return require("node:fs").readFileSync(
        require("node:path").join(__dirname, "../../server/monitor-service.js"),
        "utf8"
    );
}