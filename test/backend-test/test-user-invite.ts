/**
 * Tests for admin-issued, single-use invite links.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

import { auth } from "../../server/better-auth";
// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB();

test("user invite links", async (t) => {
    t.before(async () => {
        await testDb.create();

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

    // Required lazily so redbean-node is not captured before the DB exists.
    const invites = () => require("../../server/model/user_invite");
    const getR = () => require("redbean-node").R;

    const adminID = async () => {
        const row = await getR().findOne("better_auth_user", " username = ? ", [ "admin" ]);
        return row.id;
    };

    await t.test("create returns a plaintext token and stores only a hash", async () => {
        const { invite, token } = await invites().create(await adminID(), { note: "for sam" });

        assert.ok(token.length > 20, "token should be long");
        assert.strictEqual(invite.token_hash, invites().hashToken(token));
        assert.notStrictEqual(invite.token_hash, token, "raw token must not be stored");
        assert.strictEqual(invite.note, "for sam");
        // Not redeemed yet: either null or undefined depending on the driver.
        assert.ok(!invite.used_at, "used_at should be unset");
        assert.strictEqual(invite.getStatus(), "active");
    });

    await t.test("hashing is deterministic so lookup works", () => {
        const first = invites().hashToken("abc");
        assert.strictEqual(first, invites().hashToken("abc"));
        assert.notStrictEqual(first, invites().hashToken("abd"));
        assert.match(first, /^[a-f0-9]{64}$/);
    });

    await t.test("an unknown token finds nothing", async () => {
        assert.strictEqual(await invites().findByToken("nope"), null);
    });

    await t.test("an empty token finds nothing", async () => {
        assert.strictEqual(await invites().findByToken(""), null);
    });

    await t.test("consume marks it used and is not repeatable", async () => {
        const { invite, token } = await invites().create(await adminID());

        assert.strictEqual(await invites().consume(invite.id, "someone"), true);
        // Second attempt must fail: this is what makes the link single-use.
        assert.strictEqual(await invites().consume(invite.id, "someone-else"), false);

        const found = await invites().findByToken(token);
        assert.strictEqual(found.getStatus(), "used");
        assert.strictEqual(found.used_by, "someone");
    });

    await t.test("an expired invite cannot be consumed", async () => {
        const { invite } = await invites().create(await adminID(), { expiryHours: 1 });

        // Force it into the past.
        await getR().exec("UPDATE user_invite SET expires = ? WHERE id = ?", [
            "2000-01-01 00:00:00",
            invite.id,
        ]);

        assert.strictEqual(await invites().consume(invite.id, "someone"), false);
    });

    await t.test("expiry is configurable and bounded", async () => {
        const { invite } = await invites().create(await adminID(), { expiryHours: 5 });

        const expires = new Date(invite.expires).getTime();
        const now = Date.now();
        const hours = (expires - now) / (1000 * 60 * 60);

        assert.ok(hours > 4 && hours < 6, `expected ~5h, got ${hours}`);
    });

    await t.test("a bad expiry falls back to the default", async () => {
        const { invite } = await invites().create(await adminID(), { expiryHours: -5 });

        const hours = (new Date(invite.expires).getTime() - Date.now()) / (1000 * 60 * 60);
        assert.ok(hours > 23 && hours < 25, `expected ~24h, got ${hours}`);
    });

    await t.test("toJSON never leaks the token", async () => {
        const { invite } = await invites().create(await adminID());

        const json = invite.toJSON();
        assert.strictEqual(json.token_hash, undefined);
        assert.strictEqual(json.token, undefined);
        assert.ok("status" in json);
        assert.ok("expires" in json);
    });

    await t.test("revoke removes the link so the token stops working", async () => {
        const owner = await adminID();
        const { invite, token } = await invites().create(owner);

        assert.strictEqual(await invites().revoke(invite.id, owner), true);
        assert.strictEqual(await invites().findByToken(token), null);

        // Revoking again finds nothing.
        assert.strictEqual(await invites().revoke(invite.id, owner), false);
    });

    await t.test("revoke refuses an invite belonging to someone else", async () => {
        const { invite } = await invites().create(await adminID());

        assert.strictEqual(await invites().revoke(invite.id, "not-the-owner"), false);
        assert.ok(await invites().revoke(invite.id, await adminID()));
    });

    await t.test("listForUser only returns that user's invites", async () => {
        const owner = await adminID();
        await invites().create(owner, { note: "mine" });

        const mine = await invites().listForUser(owner);
        assert.ok(mine.every((i: any) => i.created_by === owner));

        const theirs = await invites().listForUser("someone-else");
        assert.strictEqual(theirs.length, 0);
    });

    await t.test("pruneExpired only removes long-dead rows", async () => {
        const owner = await adminID();
        const { invite: old, token: oldToken } = await invites().create(owner);
        await getR().exec("UPDATE user_invite SET expires = ? WHERE id = ?", [
            "2000-01-01 00:00:00",
            old.id,
        ]);

        const { invite: fresh, token: freshToken } = await invites().create(owner);

        await invites().pruneExpired();

        assert.strictEqual(await invites().findByToken(oldToken), null, "long-expired row removed");
        assert.ok(await invites().findByToken(freshToken), "still-valid row survives");
        assert.ok(await getR().findOne("user_invite", " id = ? ", [ fresh.id ]));
    });
});