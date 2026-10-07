/**
 * Tests for the REST token management endpoints.
 *
 * Mounts the real api-v1 router on an ephemeral express app against the mock
 * test database, so the full middleware chain (CORS, JSON, tokenAuth) runs.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import { auth } from "../../server/better-auth";
import assert from "node:assert";

// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB();

test("REST API token management", async (t) => {
    let base = "";
    let server: any = null;

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

        const express = require("express");
        const app = express();
        app.use(require("../../server/routers/api-v1-router"));

        await new Promise<void>((resolve) => {
            server = app.listen(0, "127.0.0.1", () => resolve());
        });

        const address = server.address();
        base = `http://127.0.0.1:${address.port}`;
    });

    t.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await testDb.destroy();
    });

    const getR = () => require("redbean-node").R;

    const insertKey = async (options: any = {}): Promise<string> => {
        const clear = options.clear ?? "token-secret";
        const passwordHash = require("../../server/password-hash");
        const owner = await getR().findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);

        const bean = getR().dispense("api_key");
        bean.key = await passwordHash.generate(clear);
        bean.name = options.name ?? "key";
        bean.user_id = owner.id;
        bean.active = options.active ?? true;
        bean.expires = null;
        bean.scopes = options.scopes ?? null;
        await getR().store(bean);

        return `uk${bean.id}_${clear}`;
    };

    const call = async (method: string, path: string, token: string | null, body?: any) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: {
                Accept: "application/json",
                ...(body ? { "Content-Type": "application/json" } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, body: await res.json() };
    };

    let fullToken = "";
    let readToken = "";

    await t.test("setup tokens", async () => {
        fullToken = await insertKey({ name: "full", scopes: "read,write,publish", clear: "full-secret" });
        readToken = await insertKey({ name: "ro", scopes: "read", clear: "ro-secret" });
        assert.ok(fullToken && readToken);
    });

    await t.test("lists only the caller's tokens without secrets", async () => {
        const { status, body } = await call("GET", "/api/v1/api-keys", fullToken);
        assert.strictEqual(status, 200);
        assert.ok(body.count >= 2);
        for (const key of body.apiKeys) {
            assert.strictEqual(key.token, undefined, "no plaintext in listing");
            assert.strictEqual(key.key, undefined, "no hash in listing");
        }
        assert.deepStrictEqual(body.availableScopes, [ "read", "write", "publish" ]);
    });

    await t.test("a read-only token cannot mint", async () => {
        const { status, body } = await call("POST", "/api/v1/api-keys", readToken, { name: "x" });
        assert.strictEqual(status, 403);
        assert.match(body.message, /write/);
    });

    await t.test("minting rejects unknown scopes", async () => {
        const { status, body } = await call("POST", "/api/v1/api-keys", fullToken, {
            name: "x",
            scopes: "root",
        });
        assert.strictEqual(status, 400);
        assert.match(body.message, /Invalid scope/);
    });

    await t.test("a write-scoped token cannot mint publish", async () => {
        const writeToken = await insertKey({ name: "writer", scopes: "read,write", clear: "writer-secret" });
        const { status, body } = await call("POST", "/api/v1/api-keys", writeToken, {
            name: "escalated",
            scopes: "publish",
        });
        assert.strictEqual(status, 403);
        assert.match(body.message, /cannot grant "publish"/);
    });

    await t.test("mint returns the plaintext exactly once", async () => {
        const { status, body } = await call("POST", "/api/v1/api-keys", fullToken, {
            name: "agent-1",
            scopes: "read",
        });
        assert.strictEqual(status, 201);
        assert.match(body.token, /^uk\d+_.+/);

        // The new token works.
        const check = await call("GET", "/api/v1/health", body.token);
        assert.strictEqual(check.status, 200);

        // And it never appears again.
        const list = await call("GET", "/api/v1/api-keys", fullToken);
        const listed = list.body.apiKeys.find((k: any) => k.name === "agent-1");
        assert.ok(listed);
        assert.strictEqual((listed as any).token, undefined);
    });

    await t.test("defaults to read-only when scopes are omitted", async () => {
        const { status, body } = await call("POST", "/api/v1/api-keys", fullToken, { name: "defaulted" });
        assert.strictEqual(status, 201);
        assert.deepStrictEqual(body.apiKey.scopes, [ "read" ]);
    });

    await t.test("disable and re-enable round-trips", async () => {
        const created = await call("POST", "/api/v1/api-keys", fullToken, { name: "toggle-me", scopes: "read" });
        const id = created.body.apiKey.id;

        const off = await call("PATCH", `/api/v1/api-keys/${id}`, fullToken, { active: false });
        assert.strictEqual(off.status, 200);
        assert.strictEqual(off.body.apiKey.active, 0);

        const gated = await call("GET", "/api/v1/health", created.body.token);
        assert.strictEqual(gated.status, 401);

        const on = await call("PATCH", `/api/v1/api-keys/${id}`, fullToken, { active: true });
        assert.strictEqual(on.status, 200);

        const back = await call("GET", "/api/v1/health", created.body.token);
        assert.strictEqual(back.status, 200);
    });

    await t.test("revoke deletes the token", async () => {
        const created = await call("POST", "/api/v1/api-keys", fullToken, { name: "doomed", scopes: "read" });
        const id = created.body.apiKey.id;

        const del = await call("DELETE", `/api/v1/api-keys/${id}`, fullToken);
        assert.strictEqual(del.status, 200);
        assert.strictEqual(del.body.deleted, id);

        const gone = await call("GET", "/api/v1/health", created.body.token);
        assert.strictEqual(gone.status, 401);
    });

    await t.test("unknown ids 404 rather than 500", async () => {
        assert.strictEqual((await call("DELETE", "/api/v1/api-keys/999999", fullToken)).status, 404);
        assert.strictEqual((await call("PATCH", "/api/v1/api-keys/999999", fullToken, { active: true })).status, 404);
    });

    await t.test("one user cannot touch another user's tokens", async () => {
        const other = await auth().api.createUser({
            body: {
                name: "mallory",
                email: "mallory@noreply.uptime-kuma.internal",
                password: "Kuma-Test-8f4Q2xR9p",
                role: "admin",
                data: { username: "mallory" },
            },
        });

        const R = getR();
        const passwordHash = require("../../server/password-hash");
        const bean = R.dispense("api_key");
        bean.key = await passwordHash.generate("mallory-secret");
        bean.name = "mallory-key";
        bean.user_id = other.user.id;
        bean.active = true;
        bean.expires = null;
        bean.scopes = "read,write,publish";
        await R.store(bean);

        // Admin's list must not include it.
        const list = await call("GET", "/api/v1/api-keys", fullToken);
        assert.ok(!list.body.apiKeys.some((k: any) => k.id === bean.id));

        // And neither delete nor disable touches it.
        assert.strictEqual((await call("DELETE", `/api/v1/api-keys/${bean.id}`, fullToken)).status, 404);
        assert.strictEqual(
            (await call("PATCH", `/api/v1/api-keys/${bean.id}`, fullToken, { active: false })).status,
            404
        );
    });
});
