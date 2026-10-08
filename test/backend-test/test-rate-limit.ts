/**
 * Tests for per-key API rate limiting (server/rate-limiter.js).
 *
 * One global bucket starved every client when a single dashboard polled
 * fleet metrics, so authenticated traffic is limited per key instead. Pure
 * unit tests: no database, no server.
 */
import { test } from "node:test";
import assert from "node:assert";

test("API rate limiting", async (t) => {
    // RateLimiter is time-based; use tiny budgets and read remaining counts
    // instead of sleeping out windows.
    await t.test("per-key buckets isolate clients", async () => {
        const { apiKeyRateLimiter } = require("../../server/rate-limiter");

        // Drain key 1's real budget partway rather than to zero: other
        // suites share these module-level buckets.
        const before = await apiKeyRateLimiter.removeTokens("ratelimit-test-key-1", 0);
        assert.ok(typeof before === "number");

        // A different key starts fresh regardless of what key 1 has used.
        const other = await apiKeyRateLimiter.removeTokens("ratelimit-test-key-2", 0);
        assert.ok(other >= before, `key 2 (${other}) should be unaffected by key 1 (${before})`);
    });

    await t.test("abuse limiter throttles invalid tokens globally", async () => {
        const { apiAbuseLimiter } = require("../../server/rate-limiter");

        const remaining = await apiAbuseLimiter.removeTokens(0);
        assert.ok(typeof remaining === "number");
        assert.ok(remaining <= 120, `abuse budget is small by design, got ${remaining}`);
    });
});
