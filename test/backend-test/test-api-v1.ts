/**
 * Tests for the REST API v1 token auth layer.
 *
 * Uses the same mock test database as test-better-auth.ts so real api_key
 * rows can be inserted and resolved end to end.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import { auth } from "../../server/better-auth";
import assert from "node:assert";

// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB();

type FakeResponse = {
    statusCode: number | null;
    body: any;
    headers: Record<string, string>;
    status(code: number): FakeResponse;
    json(payload: any): FakeResponse;
    set(name: string, value: string): FakeResponse;
};

/**
 * Minimal express-like request double.
 */
function fakeRequest(headers: Record<string, string>) {
    return { headers };
}

/**
 * Minimal express-like response double that records what was sent.
 */
function fakeResponse(): FakeResponse {
    return {
        statusCode: null,
        body: null,
        headers: {},
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(payload: any) {
            this.body = payload;
            return this;
        },
        set(name: string, value: string) {
            this.headers[name] = value;
            return this;
        },
    };
}

/**
 * Insert an api_key row with a known plaintext secret.
 * @returns The plaintext token to present to the API
 */
async function insertKey(options: any = {}): Promise<string> {
    const clear = options.clear ?? "secret-value-for-testing";

    // Required lazily: requiring redbean-node before the test DB exists
    // leaves the shared R instance pointing at an unconnected database.
    const { R } = require("redbean-node");
    const passwordHash = require("../../server/password-hash");

    // api_key.user_id is a string FK to better_auth_user.id (see the
    // 2026-05-28-0010-better-auth-foreign-key migration), so look the owner
    // up in better_auth_user, not the legacy user table.
    const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);
    if (!owner) {
        throw new Error("Expected the test admin user to exist; t.before() must run first.");
    }

    const bean = R.dispense("api_key");
    bean.key = await passwordHash.generate(clear);
    bean.name = options.name ?? "test key";
    bean.user_id = options.userID ?? owner.id;
    bean.active = options.active ?? true;
    bean.expires = options.expires ?? null;
    bean.scopes = options.scopes ?? null;
    await R.store(bean);

    return `uk${bean.id}_${clear}`;
}

/**
 * Run a request through tokenAuth and capture the outcome.
 */
async function runAuth(headers: Record<string, string>, scope = "read") {
    const restAuth = require("../../server/auth");
    const res = fakeResponse();
    let nextCalled = false;

    await restAuth.tokenAuth(scope)(fakeRequest(headers), res, () => {
        nextCalled = true;
    });

    return { res, nextCalled };
}

// NOTE: a single top-level test() with t.before is required here. Using
// describe() + before() runs the DB connect before TestDB.create() has
// initialised the data dir, which fails with "data directory is not
// initialized". test-better-auth.ts uses the same pattern.
test("REST API v1 token auth", async (t) => {
    t.before(async () => {
        await testDb.create();

        // Create a user so api_key rows have a valid owner.
        await auth().api.createUser({
            body: {
                name: "admin",
                email: "admin@noreply.uptime-kuma.internal",
                password: "Kuma-Test-8f4Q2xR9p",
                role: "admin",
                data: {
                    username: "admin",
                },
            },
        });
    });

    t.after(async () => {
        await testDb.destroy();
    });

    await t.test("rejects a request with no Authorization header", async () => {
        const { res, nextCalled } = await runAuth({});

        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(nextCalled, false);
        assert.match(res.body.message, /Authorization: Bearer/);
    });

    await t.test("advertises the Bearer scheme on 401", async () => {
        const { res } = await runAuth({});

        assert.strictEqual(res.headers["WWW-Authenticate"], "Bearer");
    });

    await t.test("rejects an empty Bearer value", async () => {
        const { res } = await runAuth({ authorization: "Bearer   " });

        assert.strictEqual(res.statusCode, 401);
    });

    await t.test("accepts a valid token", async () => {
        const token = await insertKey({ name: "read+write", scopes: "read,write" });
        const { res, nextCalled } = await runAuth({ authorization: `Bearer ${token}` }, "read");

        assert.strictEqual(nextCalled, true);
        assert.strictEqual(res.body, null);
    });

    await t.test("is case-insensitive about the scheme", async () => {
        const token = await insertKey({ name: "case", scopes: "read" });
        const { nextCalled } = await runAuth({ authorization: `bearer ${token}` }, "read");

        assert.strictEqual(nextCalled, true);
    });

    await t.test("accepts HTTP Basic with the token as the password", async () => {
        const token = await insertKey({ name: "basic", scopes: "read" });
        const encoded = Buffer.from(`ignored:${token}`).toString("base64");
        const { nextCalled } = await runAuth({ authorization: `Basic ${encoded}` }, "read");

        assert.strictEqual(nextCalled, true);
    });

    await t.test("rejects a write request from a read-only token", async () => {
        const token = await insertKey({ name: "readonly", scopes: "read" });
        const { res, nextCalled } = await runAuth({ authorization: `Bearer ${token}` }, "write");

        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(nextCalled, false);
        assert.match(res.body.message, /does not have the "write" scope/);
    });

    await t.test("allows a read request from a read-only token", async () => {
        const token = await insertKey({ name: "readonly2", scopes: "read" });
        const { nextCalled } = await runAuth({ authorization: `Bearer ${token}` }, "read");

        assert.strictEqual(nextCalled, true);
    });

    await t.test("treats a NULL scopes value as full access (pre-upgrade keys)", async () => {
        const token = await insertKey({ name: "legacy", scopes: null });
        const { nextCalled } = await runAuth({ authorization: `Bearer ${token}` }, "write");

        assert.strictEqual(nextCalled, true);
    });

    await t.test("rejects an inactive key", async () => {
        const token = await insertKey({ name: "inactive", active: false, scopes: "read,write" });
        const { res, nextCalled } = await runAuth({ authorization: `Bearer ${token}` }, "read");

        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(nextCalled, false);
    });

    await t.test("rejects an expired key", async () => {
        const token = await insertKey({
            name: "expired",
            scopes: "read,write",
            expires: "2000-01-01 00:00:00",
        });
        const { res, nextCalled } = await runAuth({ authorization: `Bearer ${token}` }, "read");

        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(nextCalled, false);
    });

    await t.test("rejects a token whose secret does not match", async () => {
        const token = await insertKey({ name: "wrongsecret", scopes: "read,write" });
        const tampered = token.replace(/secret-value-for-testing$/, "wrong-secret-entirely");
        const { res, nextCalled } = await runAuth({ authorization: `Bearer ${tampered}` }, "read");

        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(nextCalled, false);
    });

    await t.test("rejects a token with no key id", async () => {
        const { res } = await runAuth({ authorization: "Bearer uk_orphan" }, "read");

        assert.strictEqual(res.statusCode, 401);
    });

    await t.test("rejects a token with a non-numeric key id", async () => {
        const { res } = await runAuth({ authorization: "Bearer ukabc_secret" }, "read");

        assert.strictEqual(res.statusCode, 401);
    });

    await t.test("rejects a token missing the uk prefix", async () => {
        const { res } = await runAuth({ authorization: "Bearer 1_secret" }, "read");

        assert.strictEqual(res.statusCode, 401);
    });

    await t.test("rejects a token whose key id does not exist", async () => {
        const { res } = await runAuth({ authorization: "Bearer uk999999_nope" }, "read");

        assert.strictEqual(res.statusCode, 401);
    });
});