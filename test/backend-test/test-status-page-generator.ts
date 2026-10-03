/**
 * Tests for auto-generated status pages.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

// Imported so better-auth (and therefore database.js) loads before the DB opens.
// @ts-ignore
import { auth } from "../../server/better-auth";
// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB();

test("status page generator", async (t) => {
    let userID = "";

    t.before(async () => {
        await testDb.create();
        await auth();
        const user = await auth().api.createUser({
            body: {
                name: "admin",
                email: "admin@noreply.uptime-kuma.internal",
                password: "Kuma-Test-8f4Q2xR9p",
                role: "admin",
                data: { username: "admin" },
            },
        });
        userID = user.user.id;
    });

    t.after(async () => {
        await testDb.destroy();
    });

    const gen = () => require("../../server/model/status-page-generator");
    const service = () => require("../../server/monitor-service");
    const getR = () => require("redbean-node").R;

    /**
     * Create a monitor owned by the test user.
     */
    const mkMonitor = async (name: string, extra: any = {}) => {
        const R = getR();
        const bean = R.dispense("monitor");
        bean.user_id = userID;
        bean.name = name;
        bean.type = extra.type ?? "http";
        bean.interval = 60;
        bean.retryInterval = 60;
        bean.timeout = 48;
        // Inactive: updateMonitor() restarts a running check loop for an active
        // monitor, and those timers outlive the test runner.
        bean.active = 0;
        if (extra.url) bean.url = extra.url;
        if (extra.parent !== undefined) bean.parent = extra.parent;
        await R.store(bean);
        return bean;
    };

    /**
     * Monitor ids linked to a status page's section.
     */
    const linkedIDs = async (statusPageID: number) => {
        const R = getR();
        const section = await R.findOne("group", " status_page_id = ? ", [ statusPageID ]);
        const rows = await R.getAll("SELECT monitor_id FROM monitor_group WHERE group_id = ?", [ section.id ]);
        return rows.map((r: any) => r.monitor_id);
    };

    await t.test("slugify produces URL-safe slugs", () => {
        const s = gen().slugify;
        assert.strictEqual(s("Client A"), "client-a");
        assert.strictEqual(s("Client A (EU)"), "client-a-eu");
        assert.strictEqual(s("Tom's Store"), "toms-store");
        assert.strictEqual(s("a--b"), "a-b");
        assert.strictEqual(s("!!!"), "");
    });

    await t.test("normaliseAccent canonicalises hex", () => {
        const n = gen().normaliseAccent;
        assert.strictEqual(n("#ff4d2e"), "#FF4D2E");
        assert.strictEqual(n("ff4d2e"), "#FF4D2E");
        assert.strictEqual(n("#abc"), "#AABBCC");
        assert.strictEqual(n(""), null);
        assert.strictEqual(n(null), null);
        assert.throws(() => n("not-a-colour"), /hex colour/);
        assert.throws(() => n("#12345"), /hex colour/);
    });

    await t.test("generating creates a page, a section and monitor links", async () => {
        const group = await mkMonitor("Client A", { type: "group" });
        await mkMonitor("Edge", { url: "https://a.example.com", parent: group.id });
        await mkMonitor("Api", { url: "https://b.example.com", parent: group.id });

        const { statusPage, created } = await gen().ensureStatusPage(group.id);
        assert.strictEqual(created, true);
        assert.strictEqual(statusPage.slug, "client-a");
        assert.ok(statusPage.generated, "page is marked generated");
        assert.strictEqual(statusPage.sourceGroupMonitorId, group.id);
        assert.strictEqual((await linkedIDs(statusPage.id)).length, 2, "both children linked");
    });

    await t.test("generation is idempotent for the same group", async () => {
        const group = await mkMonitor("Client B", { type: "group" });
        const first = await gen().ensureStatusPage(group.id);
        const second = await gen().ensureStatusPage(group.id);

        assert.strictEqual(second.created, false);
        assert.strictEqual(second.statusPage.id, first.statusPage.id);
    });

    await t.test("slug collisions are suffixed, not overwritten", async () => {
        const g1 = await mkMonitor("Client C", { type: "group" });
        await gen().ensureStatusPage(g1.id);

        // Same name, different group: must not steal the existing slug.
        const g2 = await mkMonitor("Client C", { type: "group" });
        const second = await gen().ensureStatusPage(g2.id);

        assert.strictEqual(second.statusPage.slug, "client-c-2");
    });

    await t.test("an explicit slug is honoured", async () => {
        const group = await mkMonitor("Client D", { type: "group" });
        const { statusPage } = await gen().ensureStatusPage(group.id, { slug: "custom-slug" });
        assert.strictEqual(statusPage.slug, "custom-slug");
    });

    await t.test("sync links a newly added monitor", async () => {
        const group = await mkMonitor("Client E", { type: "group" });
        await mkMonitor("One", { url: "https://1.example.com", parent: group.id });
        await gen().ensureStatusPage(group.id);

        const added = await mkMonitor("Two", { url: "https://2.example.com", parent: group.id });
        const result = await gen().syncStatusPage(group.id);

        assert.strictEqual(result.changed.added, 1);
        assert.strictEqual(result.changed.removed, 0);
        assert.ok((await linkedIDs(result.statusPage.id)).includes(added.id));
    });

    await t.test("sync removes a monitor taken out of the group", async () => {
        const group = await mkMonitor("Client F", { type: "group" });
        const stay = await mkMonitor("Stay", { url: "https://stay.example.com", parent: group.id });
        const leave = await mkMonitor("Leave", { url: "https://leave.example.com", parent: group.id });
        await gen().ensureStatusPage(group.id);

        // Take `leave` out of the group; `stay` remains a member.
        await service().updateMonitor(leave.id, { parent: null });

        const result = await gen().syncStatusPage(group.id);
        assert.strictEqual(result.changed.removed, 1);

        const ids = await linkedIDs(result.statusPage.id);
        assert.ok(ids.includes(stay.id), "kept monitor still linked");
        assert.ok(!ids.includes(leave.id), "removed monitor unlinked");
    });

    await t.test("rename follows the group but the slug stays pinned", async () => {
        const group = await mkMonitor("Client G", { type: "group" });
        const { statusPage } = await gen().ensureStatusPage(group.id);
        assert.strictEqual(statusPage.slug, "client-g");

        await service().updateMonitor(group.id, { name: "Client G (EU)" });

        const result = await gen().syncStatusPage(group.id);
        assert.strictEqual(result.statusPage.title, "Client G (EU)", "title follows the rename");
        assert.strictEqual(result.statusPage.slug, "client-g", "slug is pinned");
    });

    await t.test("nested groups are published too", async () => {
        const top = await mkMonitor("Client H", { type: "group" });
        const nested = await mkMonitor("Sub", { type: "group", parent: top.id });
        const leaf = await mkMonitor("Leaf", { url: "https://leaf.example.com", parent: nested.id });

        const { statusPage } = await gen().ensureStatusPage(top.id);
        assert.ok((await linkedIDs(statusPage.id)).includes(leaf.id), "nested monitor is published");
    });

    await t.test("accent colour is stored canonically", async () => {
        const group = await mkMonitor("Client I", { type: "group" });
        const { statusPage } = await gen().ensureStatusPage(group.id, { accentColor: "#1e40af" });
        assert.strictEqual(statusPage.accentColor, "#1E40AF");
    });

    await t.test("unpublish keeps the page and its slug", async () => {
        const group = await mkMonitor("Client J", { type: "group" });
        const { statusPage } = await gen().ensureStatusPage(group.id);

        assert.strictEqual(await gen().unpublishStatusPage(group.id), true);

        const R = getR();
        const after = await R.findOne("status_page", " id = ? ", [ statusPage.id ]);
        assert.ok(after, "page still exists");
        assert.strictEqual(after.slug, "client-j", "slug survives");
        assert.ok(!after.published, "page is unpublished");

        // Second call is a no-op.
        assert.strictEqual(await gen().unpublishStatusPage(group.id), false);
    });

    await t.test("syncAllGenerated unpublishes pages whose group is gone", async () => {
        const group = await mkMonitor("Client K", { type: "group" });
        await mkMonitor("Doomed", { url: "https://doomed.example.com", parent: group.id });
        const { statusPage } = await gen().ensureStatusPage(group.id);

        // Delete the group and its children directly, as a cascade would.
        const R = getR();
        await R.exec("UPDATE monitor SET parent = NULL WHERE parent = ?", [ group.id ]);
        await R.exec("DELETE FROM monitor WHERE id = ? ", [ group.id ]);

        await gen().syncAllGenerated();

        const after = await R.findOne("status_page", " id = ? ", [ statusPage.id ]);
        assert.ok(after, "page is not deleted");
        assert.ok(!after.published, "orphaned page is unpublished");
    });

    await t.test("generating for a non-group monitor is rejected", async () => {
        const plain = await mkMonitor("Not A Group", { url: "https://plain.example.com" });
        await assert.rejects(() => gen().ensureStatusPage(plain.id), /No such group monitor/);
    });
});