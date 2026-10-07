const { R } = require("redbean-node");
const { log } = require("../src/util");
const dayjs = require("dayjs");

/**
 * Fleet metrics storage for Superboard.
 *
 * One row per agent push. The server validates shape and stores the payload
 * verbatim — it never interprets it in v1. Threshold evaluation, if it ever
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
 * @returns {Promise<boolean>} True if a row was stored
 */
async function storeMetrics(monitorID, time, payload) {
    if (payload === undefined || payload === null) {
        return false;
    }

    const bean = R.dispense("monitor_metric");
    bean.monitor_id = monitorID;
    bean.time = time;
    bean.payload = validateMetrics(payload);
    await R.store(bean);
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
};
