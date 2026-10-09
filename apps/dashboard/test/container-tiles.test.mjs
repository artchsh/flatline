import test from "node:test";
import assert from "node:assert/strict";
import { containerTileLayout, containerTone } from "../src/lib/fleet-presentation.ts";

test("container colors distinguish known failures, transitions, running and unknown stop intent", () => {
    assert.equal(containerTone({ state: "exited" }), "stopped");
    assert.equal(containerTone({ state: "running" }), "up");
    assert.equal(containerTone({ state: "running", health: "healthy" }), "up");
    assert.equal(containerTone({ state: "running", health: "unhealthy" }), "bad");
    for (const state of ["dead", "restarting"]) { assert.equal(containerTone({ state }), "bad"); }
    for (const state of ["created", "paused", "unknown"]) { assert.equal(containerTone({ state }), "pending"); }
    assert.equal(containerTone({ state: "running", health: "starting" }), "pending");
});

test("up to nine tiles stay static; larger sets loop without dropping containers", () => {
    for (const count of [1, 3, 9, 20, 100]) {
        const containers = Array.from({ length: count }, (_, i) => ({ name: `container-${i}`, state: "running" }));
        const layout = containerTileLayout(containers);
        assert.equal(layout.looping, count > 9);
        assert.equal(layout.visibleRows, 3);
        assert.deepEqual(layout.rows.flat(), containers);
        assert.ok(layout.rows.every(row => row.length <= 3));
    }
});

test("problems stay pinned with bounded space; excessive problems remain in rotation", () => {
    for (const count of [1, 4, 8, 20]) {
        const containers = Array.from({ length: 25 }, (_, i) => ({ name: `container-${i}`, state: i < count ? "restarting" : "running" }));
        const layout = containerTileLayout(containers);
        assert.equal(layout.pinned.length, Math.min(6, count));
        assert.ok(layout.visibleRows >= 1);
        assert.equal(new Set([...layout.pinned, ...layout.rows.flat()]).size, 25);
        assert.equal(layout.pinned.length + layout.rows.flat().length, 25);
    }
});
