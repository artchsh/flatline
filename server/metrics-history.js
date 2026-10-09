const { R } = require("redbean-node");

const FIELDS = ["cpu", "ram", "gpu", "vram"];
const MAX_HISTORY_ROWS = 50_000;

function timestamp(value) {
    const text = String(value).replace(" ", "T");
    return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`);
}

function percentage(value) {
    if (value === null || value === undefined || value === "" || value === "null") { return null; }
    const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

// Extract only scalar readings, not repeated Docker inventories/full payloads.
// JSON_VALID keeps a corrupt historical row from failing the whole request.
async function scalarRows(monitorID, from, to, limit = MAX_HISTORY_ROWS + 1) {
    const payload = "CASE WHEN JSON_VALID(payload) THEN payload ELSE '{}' END";
    const extract = path => `JSON_EXTRACT(${payload}, '${path}')`;
    const gpu = field => `COALESCE(${extract(`$.gpu.gpus[0].${field}`)}, ${extract(`$.gpu.${field}`)})`;
    return R.getAll(`SELECT time,
        ${extract("$.cpu.percent")} AS cpu,
        ${extract("$.mem.percent")} AS ram,
        ${extract("$.gpu.available")} AS gpu_available,
        ${gpu("util")} AS gpu,
        ${gpu("memUsed")} AS vram_used,
        ${gpu("memTotal")} AS vram_total
        FROM monitor_metric WHERE monitor_id = ? AND time >= ? AND time <= ?
        ORDER BY time DESC, id DESC LIMIT ${limit}`, [monitorID, from, to]);
}

function readings(row) {
    const available = row.gpu_available === true || row.gpu_available === 1 || row.gpu_available === "true";
    const used = Number(row.vram_used), total = Number(row.vram_total);
    return {
        cpu: percentage(row.cpu), ram: percentage(row.ram),
        gpu: available ? percentage(row.gpu) : null,
        vram: available && total > 0 && row.vram_used !== null ? percentage(used / total * 100) : null,
    };
}

function summarize(values) {
    if (!values.length) { return null; }
    values.sort((a, b) => a - b);
    const percentile = p => values[Math.max(0, Math.ceil(p * values.length) - 1)];
    return { count: values.length, min: values[0], max: values.at(-1),
        mean: values.reduce((sum, n) => sum + n, 0) / values.length,
        p90: percentile(0.90), p95: percentile(0.95), p99: percentile(0.99) };
}

function historySummary(rows, from, to, points = 240) {
    const start = timestamp(from), end = timestamp(to);
    const bucketMs = Math.max(1000, Math.ceil((end - start) / points));
    const buckets = new Map();
    const values = Object.fromEntries(FIELDS.map(field => [field, []]));
    let first = null, last = null, samples = 0;
    for (const row of rows) {
        const time = timestamp(row.time);
        if (!Number.isFinite(time) || time < start || time > end) { continue; }
        const reading = readings(row);
        if (FIELDS.every(field => reading[field] === null)) { continue; }
        first = first === null ? time : Math.min(first, time);
        last = last === null ? time : Math.max(last, time);
        samples++;
        const index = Math.min(points - 1, Math.floor((time - start) / bucketMs));
        if (!buckets.has(index)) { buckets.set(index, Object.fromEntries(FIELDS.map(field => [field, []]))); }
        for (const field of FIELDS) {
            if (reading[field] !== null) { values[field].push(reading[field]); buckets.get(index)[field].push(reading[field]); }
        }
    }
    const series = [...buckets.entries()].sort(([a], [b]) => a - b).map(([index, bucket]) => ({
        time: new Date(start + index * bucketMs).toISOString(),
        ...Object.fromEntries(FIELDS.map(field => [field, bucket[field].length
            ? bucket[field].reduce((sum, n) => sum + n, 0) / bucket[field].length : null])),
    }));
    return { samples, firstSample: first === null ? null : new Date(first).toISOString(),
        lastSample: last === null ? null : new Date(last).toISOString(), bucketSeconds: bucketMs / 1000,
        stats: Object.fromEntries(FIELDS.map(field => [field, summarize(values[field])])), series };
}

module.exports = { scalarRows, historySummary, timestamp, percentage, MAX_HISTORY_ROWS };
