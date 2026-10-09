const express = require("express");
const { R } = require("redbean-node");
const { tokenAuth, hasScope } = require("../auth");
const { subscribe } = require("../live-updates");

const router = express.Router();
const connections = new Map();

// Mounted inside the v1 router: inherits bearer auth conventions and CORS.
router.get("/api/v1/events", tokenAuth("read"), async (req, res) => {
    const key = req.apiKeyID ?? "disabled-auth";
    // Preserve the verified key fingerprint; replacing a key's secret must
    // invalidate an already-open stream too, not just its next reconnect.
    let initialKey;
    try {
        initialKey = req.apiKeyID ? await R.findOne("api_key", " id = ? ", [req.apiKeyID]) : null;
    } catch {
        return res.status(503).json({ ok: false, error: "unavailable", message: "Live authentication unavailable." });
    }
    if (res.destroyed || req.aborted) { return; }
    if (req.apiKeyID && !initialKey) {
        return res.status(401).end();
    }
    const count = connections.get(key) ?? 0;
    if (count >= 8 || [...connections.values()].reduce((sum, n) => sum + n, 0) >= 128) {
        return res.status(429).json({ ok: false, error: "stream_limit", message: "Too many live connections." });
    }
    connections.set(key, count + 1);
    req.socket.setTimeout(0);
    res.status(200).set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    });
    res.flushHeaders();
    let closed = false;
    let checking = false;
    let unsubscribe = () => {};
    let keepalive;
    let lifetime;
    function close() {
        if (closed) {
            return;
        }
        closed = true;
        unsubscribe();
        clearInterval(keepalive);
        clearTimeout(lifetime);
        const remaining = (connections.get(key) ?? 1) - 1;
        if (remaining) {
            connections.set(key, remaining);
        } else {
            connections.delete(key);
        }
        // A slow client must not build an unbounded queue of old samples.
        res.destroy();
    }
    function send(event) {
        if (closed) { return; }
        const frame = `data: ${JSON.stringify(event)}\n\n`;
        if (res.writableLength + Buffer.byteLength(frame) > 256 * 1024) {
            close();
        } else {
            res.write(frame);
        }
    }
    res.on("close", close);
    res.on("error", close);
    unsubscribe = subscribe(event => {
        if (event.type !== "metrics" || req.query.metrics !== "0") { send(event); }
    });
    send({ type: "ready" });
    keepalive = setInterval(async () => {
        if (checking || closed) {
            return;
        }
        checking = true;
        try {
            if (req.apiKeyID) {
                const row = await R.findOne("api_key", " id = ? ", [req.apiKeyID]);
                const rawExpiry = String(row?.expires ?? "").replace(" ", "T");
                const expiry = rawExpiry ? Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawExpiry) ? rawExpiry : `${rawExpiry}Z`) : Infinity;
                const scopes = row?.scopes ? String(row.scopes).split(",").map(s => s.trim()) : ["publish"];
                const owner = row ? await R.findOne("better_auth_user", " id = ? ", [row.user_id]) : null;
                if (!row || !owner || owner.banned || !row.active || row.key !== initialKey.key || !(expiry > Date.now()) || !hasScope(scopes, "read")) {
                    send({ type: "unauthorized" });
                    close();
                    return;
                }
            }
            if (!closed) {
                if (res.writableLength > 256 * 1024) { close(); }
                else { res.write(": keepalive\n\n"); }
            }
        } catch {
            close(); // auth/database failures fail closed
        } finally {
            checking = false;
        }
    }, 15_000);
    lifetime = setTimeout(close, 15 * 60_000);
    keepalive.unref();
    lifetime.unref();
});

module.exports = router;
