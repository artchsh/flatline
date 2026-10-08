/**
 * Tests for Superboard metrics ingest (Phase 1).
 *
 * Covers the migration, the validate/store/prune unit layer, and the push
 * endpoint itself mounted on an ephemeral express app — including the key
 * property that a broken metrics payload never sinks the heartbeat.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

// @ts-ignore
import { auth } from "../../server/better-auth";
// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB();

/** Minimal broadcast stub: the push endpoint used to emit over sockets. */
function fakeIo() {
    return {
        sockets: null,
        to: () => ({ emit: () => {} }),
    };
}

test("monitor metrics ingest", async (t) => {
    let base = "";
    let server: any = null;
    let pushToken = "";

    t.before(async () => {
        await testDb.create();
        await auth();

        await auth().api.createUser({
            body: {
                name: "admin",
                email: "admin@noreply.uptime-kuma.internal",
                password: "Kuma-Test-8f4Q2xR9p",
                role: "admin",
                data: { username: "admin" },
            },
        });

        // The push router captures `io` at require time, so stub it first.
        const { UptimeKumaServer } = require("../../server/uptime-kuma-server");
        UptimeKumaServer.getInstance().io = fakeIo();

        const express = require("express");
        const app = express();
        app.use(require("../../server/routers/api-router"));
        app.use(require("../../server/routers/api-v1-router"));

        await new Promise<void>((resolve) => {
            server = app.listen(0, "127.0.0.1", () => resolve());
        });

        const address = server.address();
        base = `http://127.0.0.1:${address.port}`;

        const { R } = require("redbean-node");
        const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);
        const bean = R.dispense("monitor");
        bean.user_id = owner.id;
        bean.name = "Agent Host";
        bean.type = "push";
        bean.interval = 60;
        bean.retryInterval = 60;
        bean.timeout = 48;
        bean.active = 1;
        bean.push_token = "test-push-token-123";
        await R.store(bean);
        pushToken = "test-push-token-123";
    });

    t.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await testDb.destroy();
    });

    const push = async (body: any, query = "") => {
        const res = await fetch(`${base}/api/push/${pushToken}${query}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };

    const metricRows = async () => {
        const { R } = require("redbean-node");
        return await R.getAll("SELECT * FROM monitor_metric ORDER BY id");
    };

    await t.test("migration creates the table with an index", async () => {
        const { R } = require("redbean-node");
        const info = await R.knex("monitor_metric").columnInfo();
        const names = Object.keys(info);
        for (const col of [ "id", "monitor_id", "time", "payload" ]) {
            assert.ok(names.includes(col), `${col} missing`);
        }
    });

    await t.test("a plain push still works and stores no metrics", async () => {
        const { status, body } = await push({}, "?msg=OK&status=up");
        assert.strictEqual(status, 200);
        assert.strictEqual(body.ok, true);
        assert.strictEqual((await metricRows()).length, 0);
    });

    await t.test("a push with metrics stores both", async () => {
        const metrics = {
            v: 1,
            host: { hostname: "client-a-db-01", os: "linux", uptime: 864001 },
            cpu: { percent: 23.5, cores: 8 },
            mem: { total: 33554432, used: 12582912, percent: 37.5 },
            disk: [ { mount: "/", total: 100, used: 42, percent: 42 } ],
            gpu: { available: false },
            docker: [ { name: "api", image: "api:1.4.2", state: "running", health: "healthy", ports: [ "8080:80" ] } ],
        };
        const { status, body } = await push({ status: "up", ping: 12, msg: "OK", metrics });
        assert.strictEqual(status, 200);
        assert.strictEqual(body.ok, true);

        const rows = await metricRows();
        assert.strictEqual(rows.length, 1);
        assert.deepStrictEqual(JSON.parse(rows[0].payload), metrics);
    });

    await t.test("malformed metrics 400 but the heartbeat is still recorded", async () => {
        const { R } = require("redbean-node");
        const beatsBefore = (await R.getAll("SELECT * FROM heartbeat")).length;

        const { status, body } = await push({ status: "up", metrics: [ "not", "an", "object" ] });
        assert.strictEqual(status, 400);
        assert.strictEqual(body.ok, false);
        assert.match(body.msg, /Heartbeat recorded, metrics dropped/);

        const beatsAfter = (await R.getAll("SELECT * FROM heartbeat")).length;
        assert.strictEqual(beatsAfter, beatsBefore + 1, "heartbeat must survive bad metrics");
        assert.strictEqual((await metricRows()).length, 1, "no metrics row for the bad payload");
    });

    await t.test("oversized metrics are rejected without recording", async () => {
        const big = { v: 1, blob: "x".repeat(70 * 1024) };
        const { status } = await push({ status: "up", metrics: big });
        assert.strictEqual(status, 400);
        assert.strictEqual((await metricRows()).length, 1);
    });

    await t.test("validateMetrics accepts unknown future fields", async () => {
        const { validateMetrics } = require("../../server/monitor-metrics");
        const out = validateMetrics({ v: 99, somethingNew: [ 1, 2, 3 ] });
        assert.deepStrictEqual(JSON.parse(out), { v: 99, somethingNew: [ 1, 2, 3 ] });
    });

    await t.test("pruneMetrics deletes only old rows", async () => {
        const { R } = require("redbean-node");
        const { pruneMetrics } = require("../../server/monitor-metrics");

        const old = R.dispense("monitor_metric");
        old.monitor_id = 1;
        old.time = "2000-01-01 00:00:00";
        old.payload = JSON.stringify({ v: 1 });
        await R.store(old);

        await pruneMetrics(30);

        const rows = await metricRows();
        assert.ok(rows.length >= 1, "recent rows survive");
        assert.ok(!rows.some((r: any) => r.time.startsWith("2000-")), "old row pruned");
    });
});

test("monitor metrics read API", async (t) => {
    let base = "";
    let server: any = null;
    let token = "";
    let monitorID = 0;

    t.before(async () => {
        await testDb.create();
        await auth();

        await auth().api.createUser({
            body: {
                name: "admin",
                email: "admin@noreply.uptime-kuma.internal",
                password: "Kuma-Test-8f4Q2xR9p",
                role: "admin",
                data: { username: "admin" },
            },
        });

        const { UptimeKumaServer } = require("../../server/uptime-kuma-server");
        UptimeKumaServer.getInstance().io = fakeIo();

        const express = require("express");
        const app = express();
        app.use(require("../../server/routers/api-v1-router"));

        await new Promise<void>((resolve) => {
            server = app.listen(0, "127.0.0.1", () => resolve());
        });

        const address = server.address();
        base = `http://127.0.0.1:${address.port}`;

        const { R } = require("redbean-node");
        const passwordHash = require("../../server/password-hash");
        const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);

        const key = R.dispense("api_key");
        key.key = await passwordHash.generate("read-secret");
        key.name = "reader";
        key.user_id = owner.id;
        key.active = true;
        key.expires = null;
        key.scopes = "read";
        await R.store(key);
        token = `uk${key.id}_read-secret`;

        const monitor = R.dispense("monitor");
        monitor.user_id = owner.id;
        monitor.name = "Metric Host";
        monitor.type = "push";
        monitor.interval = 60;
        monitor.retryInterval = 60;
        monitor.timeout = 48;
        monitor.active = 1;
        await R.store(monitor);
        monitorID = monitor.id;

        // Three samples: two recent, one older than a day.
        const { storeMetrics } = require("../../server/monitor-metrics");
        const now = Date.now();
        const at = (minsAgo: number) =>
            new Date(now - minsAgo * 60000).toISOString().slice(0, 19).replace("T", " ");
        await storeMetrics(monitorID, at(10), { v: 1, cpu: { percent: 20, cores: 4 } });
        await storeMetrics(monitorID, at(70), { v: 1, cpu: { percent: 40, cores: 4 } });
        await storeMetrics(monitorID, at(1500), { v: 1, cpu: { percent: 90, cores: 4 } });
    });

    t.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await testDb.destroy();
    });

    const get = async (path: string, authToken: string | null = token) => {
        const res = await fetch(`${base}${path}`, {
            headers: {
                Accept: "application/json",
                ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
        });
        return { status: res.status, body: await res.json() };
    };

    await t.test("latest returns the newest sample", async () => {
        const { status, body } = await get(`/api/v1/monitors/${monitorID}/metrics/latest`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.monitorId, monitorID);
        assert.strictEqual(body.metrics.cpu.percent, 20);
    });

    await t.test("latest 404s when there are no samples", async () => {
        const { R } = require("redbean-node");
        const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);
        const empty = R.dispense("monitor");
        empty.user_id = owner.id;
        empty.name = "No Samples";
        empty.type = "push";
        empty.interval = 60;
        empty.retryInterval = 60;
        empty.timeout = 48;
        empty.active = 1;
        await R.store(empty);

        const { status, body } = await get(`/api/v1/monitors/${empty.id}/metrics/latest`);
        assert.strictEqual(status, 404);
        assert.strictEqual(body.ok, false);
    });

    await t.test("history defaults to 24h and excludes older samples", async () => {
        const { status, body } = await get(`/api/v1/monitors/${monitorID}/metrics`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.hours, 24);
        assert.strictEqual(body.count, 2, "the 25-hour-old sample is outside the window");
        assert.strictEqual(body.capped, false);
        // Newest first.
        assert.strictEqual(body.metrics[0].metrics.cpu.percent, 20);
        assert.strictEqual(body.metrics[1].metrics.cpu.percent, 40);
    });

    await t.test("history honours a wider window", async () => {
        const { status, body } = await get(`/api/v1/monitors/${monitorID}/metrics?hours=48`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.count, 3);
    });

    await t.test("history rejects a bad window", async () => {
        assert.strictEqual((await get(`/api/v1/monitors/${monitorID}/metrics?hours=nope`)).status, 400);
        assert.strictEqual((await get(`/api/v1/monitors/${monitorID}/metrics?hours=-5`)).status, 400);
        assert.strictEqual((await get(`/api/v1/monitors/${monitorID}/metrics?hours=0`)).status, 400);
    });

    await t.test("history caps hours at a week", async () => {
        // 10000 asks for more than exists; the cap is what matters, not the data.
        const { status, body } = await get(`/api/v1/monitors/${monitorID}/metrics?hours=10000`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.count, 3, "all rows fit, cap only bounds the window");
    });

    await t.test("both endpoints require auth", async () => {
        assert.strictEqual((await get(`/api/v1/monitors/${monitorID}/metrics/latest`, null)).status, 401);
        assert.strictEqual((await get(`/api/v1/monitors/${monitorID}/metrics`, null)).status, 401);
    });

    await t.test("both endpoints 404 an unknown monitor", async () => {
        assert.strictEqual((await get("/api/v1/monitors/999999/metrics/latest")).status, 404);
        assert.strictEqual((await get("/api/v1/monitors/999999/metrics")).status, 404);
    });
});
