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