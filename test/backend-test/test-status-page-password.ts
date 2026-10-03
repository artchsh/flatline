/**
 * Tests for the status page password gate.
 *
 * The two security properties that matter:
 * 1. A valid password yields a cookie that unlocks the page it was issued for.
 * 2. A cookie cannot be forged, and does not carry over to another page.
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

test("status page password gate", async (t) => {
    t.before(async () => {
        await testDb.create();
        await auth();
    });

    t.after(async () => {
        await testDb.destroy();
    });

    const sa = () => require("../../server/status-page-auth");
    const future = () => Math.floor(Date.now() / 1000) + 3600;

    await t.test("hashPassword then verifyPassword accepts only the right value", async () => {
        const hash = await sa().hashPassword("client-a-secret");
        assert.notStrictEqual(hash, "client-a-secret", "password is not stored in the clear");
        assert.strictEqual(sa().verifyPassword("client-a-secret", hash), true);
        assert.strictEqual(sa().verifyPassword("wrong", hash), false);
    });

    await t.test("verifyPassword fails closed on a malformed hash", () => {
        assert.strictEqual(sa().verifyPassword("x", "not-a-bcrypt-hash"), false);
        assert.strictEqual(sa().verifyPassword("x", null), false);
    });

    await t.test("a signed cookie verifies for its own page", () => {
        const value = sa().signUnlock("client-a", future());
        assert.strictEqual(sa().verifyUnlock(value, "client-a"), true);
    });

    await t.test("a cookie does not unlock a different page", () => {
        const value = sa().signUnlock("client-a", future());
        assert.strictEqual(sa().verifyUnlock(value, "client-b"), false);
    });

    await t.test("a tampered expiry invalidates the cookie", () => {
        const value = sa().signUnlock("client-a", future());
        const signature = value.substring(value.indexOf(".") + 1);
        // Keep the real signature but move the expiry far into the future.
        assert.strictEqual(sa().verifyUnlock(`${future() + 100000}.${signature}`, "client-a"), false);
    });

    await t.test("an expired cookie is rejected", () => {
        const past = Math.floor(Date.now() / 1000) - 60;
        const value = sa().signUnlock("client-a", past);
        assert.strictEqual(sa().verifyUnlock(value, "client-a"), false);
    });

    await t.test("malformed cookie values are rejected without throwing", () => {
        for (const bad of [ "", "no-separator", "abc.def", null, undefined, 42 ]) {
            assert.strictEqual(sa().verifyUnlock(bad, "client-a"), false, `input ${String(bad)}`);
        }
    });

    await t.test("parseCookies handles the header shape curl and browsers send", () => {
        const parsed = sa().parseCookies("a=1; fl_status_auth=abc.def; b=2");
        assert.strictEqual(parsed.fl_status_auth, "abc.def");
        assert.strictEqual(parsed.a, "1");

        assert.deepStrictEqual(sa().parseCookies(""), {});
        assert.deepStrictEqual(sa().parseCookies(undefined), {});
    });

    await t.test("a page with no password is always unlocked", () => {
        const page = { slug: "open-page", password: null };
        assert.strictEqual(sa().isUnlocked({ headers: {} }, page), true);
    });

    await t.test("a passworded page needs a valid cookie", () => {
        const page = { slug: "client-a", password: "hash" };
        assert.strictEqual(sa().isUnlocked({ headers: {} }, page), false);

        const value = sa().signUnlock("client-a", future());
        const withCookie = { headers: { cookie: `fl_status_auth=${value}` } };
        assert.strictEqual(sa().isUnlocked(withCookie, page), true);
    });

    await t.test("robots directives exclude indexing and archiving", () => {
        const directives = sa().robotsDirectives();
        for (const directive of [ "noindex", "nofollow", "noarchive", "nosnippet", "noimageindex" ]) {
            assert.ok(directives.includes(directive), `missing ${directive}`);
        }
    });

    await t.test("the password prompt does not leak the password or the page contents", () => {
        const html = sa().renderPasswordPrompt("client-a", "That password is not correct.");

        assert.ok(html.includes("This status page is private"));
        assert.ok(html.includes("noindex"), "the prompt is itself excluded from indexing");
        assert.ok(!html.includes("client-a-secret"), "never echoes a password");
        // The action embeds the slug only, which is already in the URL.
        assert.ok(html.includes("/api/v1/status-pages/unlock/client-a"));
    });

    await t.test("the prompt escapes the slug", () => {
        const html = sa().renderPasswordPrompt('a"><script>alert(1)</script>', "");
        assert.ok(!html.includes("<script>alert(1)</script>"), "slug is escaped");
    });
});
test("status page data endpoints are gated", async (t) => {
    t.before(async () => {
        await testDb.create();
        await auth();
    });

    t.after(async () => {
        await testDb.destroy();
    });

    const getR = () => require("redbean-node").R;

    const makePage = async (slug: string, password: string | null) => {
        const sa = require("../../server/status-page-auth");
        const bean = getR().dispense("status_page");
        bean.title = slug;
        bean.slug = slug;
        bean.icon = "";
        bean.theme = "auto";
        bean.published = 1;
        bean.password = password ? await sa.hashPassword(password) : null;
        await getR().store(bean);
        return bean;
    };

    /**
     * Minimal express response double.
     */
    const fakeResponse = () => ({
        statusCode: null as number | null,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: any) { this.body = payload; return this; },
        set() { return this; },
        send(payload: any) { this.body = payload; return this; },
    });

    await t.test("requireUnlocked rejects a protected page without a cookie", async () => {
        const sa = require("../../server/status-page-auth");
        await makePage("gated", "secret");

        const res = fakeResponse();
        const page = await sa.requireUnlocked({ headers: {} }, res as any, "gated");

        assert.strictEqual(page, null, "access refused");
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.body.error, "password_required");
    });

    await t.test("requireUnlocked allows a protected page with a valid cookie", async () => {
        const sa = require("../../server/status-page-auth");
        const page = await makePage("gated-cookie", "secret");

        const future = Math.floor(Date.now() / 1000) + 3600;
        const value = sa.signUnlock("gated-cookie", future);
        const res = fakeResponse();

        const found = await sa.requireUnlocked(
            { headers: { cookie: `fl_status_auth=${value}` } },
            res as any,
            "gated-cookie"
        );

        assert.ok(found, "access granted");
        assert.strictEqual(found.id, page.id);
    });

    await t.test("requireUnlocked allows an open page with no cookie", async () => {
        const sa = require("../../server/status-page-auth");
        await makePage("ungated", null);

        const res = fakeResponse();
        const found = await sa.requireUnlocked({ headers: {} }, res as any, "ungated");

        assert.ok(found, "open pages need no cookie");
    });

    await t.test("requireUnlocked 404s an unknown slug rather than 401", async () => {
        const sa = require("../../server/status-page-auth");
        const res = fakeResponse();

        const found = await sa.requireUnlocked({ headers: {} }, res as any, "does-not-exist");

        assert.strictEqual(found, null);
        assert.strictEqual(res.statusCode, 404, "does not confirm or deny gated slugs");
    });

    await t.test("a cookie for one page does not unlock another", async () => {
        const sa = require("../../server/status-page-auth");
        await makePage("page-one", "secret");
        await makePage("page-two", "secret");

        const value = sa.signUnlock("page-one", Math.floor(Date.now() / 1000) + 3600);
        const res = fakeResponse();

        const found = await sa.requireUnlocked(
            { headers: { cookie: `fl_status_auth=${value}` } },
            res as any,
            "page-two"
        );

        assert.strictEqual(found, null, "cookie is scoped to its own page");
        assert.strictEqual(res.statusCode, 401);
    });
});
