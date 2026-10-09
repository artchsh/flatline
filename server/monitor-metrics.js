const { R } = require("redbean-node");
const { log } = require("../src/util");
const dayjs = require("dayjs");
const { publish } = require("./live-updates");
const latest = new Map();
const MAX_LATEST = 512;
const HISTORY_INTERVAL_MS = 30_000;
const { recordCPU, currentPeak, forgetCPU, resetCPU } = require("./cpu-peak");

function metricTime(value) {
    const iso = String(value).replace(" ", "T");
    return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
}

function getLatestMetrics(id) {
    const sample = latest.get(Number(id))?.sample;
    return sample ? { ...sample, cpuPeak10m: currentPeak(id) } : null;
}

function forgetMetrics(id) {
    latest.delete(Number(id));
    forgetCPU(id);
}

function resetMetricsCache() {
    latest.clear();
    resetCPU();
}

/**
 * Fleet metrics storage for Superboard.
 *
 * Latest state is cached per monitor; opted-in live pushes archive at 30s
 * resolution, while legacy pushes archive every payload. Payloads remain
 * verbatim — threshold evaluation, if it ever
 * comes, belongs in a separate layer, not in the ingest path.
 */

/**
 * Maximum accepted payload size in bytes.
 *
 * Matches the express.json() limit on the push route. An agent sending more
 * than this is misconfigured, not carrying useful data.
 * @type {number}
 */
const METRICS_MAX_BYTES = 64 * 1024;

/**
 * How long raw samples are kept, in days.
 * @type {number}
 */
const METRICS_RETENTION_DAYS = 30;

/**
 * Validate a metrics payload without interpreting it.
 *
 * Unknown fields are ignored, never rejected: the `v` envelope in the payload
 * lets future agents add fields without breaking old servers.
 * @param {unknown} payload Decoded `metrics` value from the push body
 * @returns {string} Canonical JSON string to store
 * @throws {Error} If the payload is not a plain object
 */
function validateMetrics(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("metrics must be a JSON object");
    }

    const encoded = JSON.stringify(payload);

    if (Buffer.byteLength(encoded, "utf8") > METRICS_MAX_BYTES) {
        throw new Error(`metrics payload exceeds ${METRICS_MAX_BYTES} bytes`);
    }

    return encoded;
}

/**
 * Store one metrics sample.
 * @param {number} monitorID Owning monitor
 * @param {string} time Timestamp, same clock as the heartbeat it rode in on
 * @param {unknown} payload Validated payload, or null/undefined to skip
 * @param {object} options Storage policy
 * @param {boolean} options.live Downsample durable history for live telemetry
 * @returns {Promise<boolean>} True if the sample was accepted
 */
async function storeMetrics(monitorID, time, payload, { live = false } = {}) {
    if (payload === undefined || payload === null) {
        return false;
    }

    const encoded = validateMetrics(payload);
    monitorID = Number(monitorID);
    const previous = latest.get(monitorID);
    const now = Date.now();
    let persistedAt = previous?.persistedAt ?? 0;
    if (!live || now - persistedAt >= HISTORY_INTERVAL_MS) {
        const bean = R.dispense("monitor_metric");
        bean.monitor_id = monitorID;
        bean.time = time;
        bean.payload = encoded;
        await R.store(bean);
        persistedAt = now;
    }
    const current = latest.get(monitorID);
    if (!current || metricTime(time) >= metricTime(current.sample.time)) {
        const sample = { time, metrics: JSON.parse(encoded) };
        const cpuPeak10m = await recordCPU(monitorID, time, sample.metrics.cpu?.percent);
        // Warming a new peak window is asynchronous; another push may have
        // committed a newer latest sample in the meantime.
        const newer = latest.get(monitorID);
        if (newer && metricTime(time) < metricTime(newer.sample.time)) { return true; }
        latest.delete(monitorID);
        latest.set(monitorID, { sample, persistedAt });
        if (latest.size > MAX_LATEST) {
            latest.delete(latest.keys().next().value);
        }
        publish({ type: "metrics", monitorId: monitorID, ...sample, cpuPeak10m });
    }
    return true;
}

/**
 * Delete samples older than the retention window.
 * @param {number} days Keep window in days
 * @returns {Promise<number>} Rows deleted (best effort; drivers differ)
 */
async function pruneMetrics(days = METRICS_RETENTION_DAYS) {
    const cutoff = dayjs.utc().subtract(days, "day").format("YYYY-MM-DD HH:mm:ss");
    await R.exec("DELETE FROM monitor_metric WHERE time < ?", [ cutoff ]);
    log.debug("metrics", `Pruned metric samples older than ${days} days`);
}

module.exports = {
    METRICS_MAX_BYTES,
    METRICS_RETENTION_DAYS,
    validateMetrics,
    storeMetrics,
    pruneMetrics,
    getLatestMetrics,
    forgetMetrics,
    HISTORY_INTERVAL_MS,
    resetMetricsCache,
};
