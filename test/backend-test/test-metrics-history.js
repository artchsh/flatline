const { test } = require("node:test");
const assert = require("node:assert/strict");
const { historySummary } = require("../../server/metrics-history");
const { R } = require("redbean-node");
const { recordCPU, currentPeak, resetCPU } = require("../../server/cpu-peak");

test("nearest-rank load percentiles use raw samples, not chart averages; absent GPU stays unknown", () => {
    const from = "2026-10-09T00:00:00Z", to = "2026-10-09T01:00:00Z";
    const rows = Array.from({length:100}, (_, i) => ({time:new Date(Date.parse(from)+i*30_000).toISOString(),cpu:i,ram:50,gpu_available:0,gpu:0,vram_used:0,vram_total:0}));
    const result = historySummary(rows, from, to, 10);
    assert.deepEqual(result.stats.cpu,{count:100,min:0,max:99,mean:49.5,p90:89,p95:94,p99:98});
    assert.ok(result.series.length<=10);
    assert.equal(result.stats.gpu,null);
    assert.equal(result.stats.vram,null);
    assert.equal(result.stats.ram.p99,50);
});

test("malformed readings are excluded; zero CPU/GPU and VRAM ratio remain valid", () => {
    const result=historySummary([{time:"2026-10-09 00:00:00",cpu:0,ram:null,gpu_available:1,gpu:0,vram_used:25,vram_total:100},
        {time:"bad",cpu:99},{time:"2026-10-09 00:01:00",cpu:101,ram:"null",gpu_available:0}],"2026-10-09T00:00:00Z","2026-10-09T01:00:00Z");
    assert.equal(result.samples,1);assert.equal(result.stats.cpu.max,0);assert.equal(result.stats.ram,null);
    assert.equal(result.stats.gpu.max,0);assert.equal(result.stats.vram.max,25);
});

test("10-minute peak warms from archive, tracks total CPU, expires older highs and ignores late samples", async t => {
    resetCPU();
    const start=Date.parse("2026-10-09T01:00:00Z");
    t.mock.method(R,"getAll",async()=>[{time:new Date(start-5*60_000).toISOString(),cpu:80}]);
    const at=offset=>new Date(start+offset).toISOString();
    assert.equal((await recordCPU(1,at(0),20)).percent,80);
    assert.equal((await recordCPU(1,at(1000),95)).percent,95);
    assert.equal((await recordCPU(1,at(2000),30)).percent,95);
    await recordCPU(1,at(0),99); // late update must not replace the live window
    assert.equal(currentPeak(1,start+2000).percent,95);
    assert.equal((await recordCPU(1,at(601_001),40)).percent,40);
    assert.equal(currentPeak(1,start+1_300_000),null);
    resetCPU();
});
