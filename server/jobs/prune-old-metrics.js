const { pruneMetrics, METRICS_RETENTION_DAYS } = require("../monitor-metrics");
const { log } = require("../../src/util");

/**
 * Deletes metric samples older than the retention window.
 * @returns {Promise<void>} A promise that resolves when pruning is done.
 */
const pruneOldMetrics = async () => {
    try {
        log.debug("pruneOldMetrics", `Clearing metric samples older than ${METRICS_RETENTION_DAYS} days...`);
        await pruneMetrics(METRICS_RETENTION_DAYS);
    } catch (e) {
        log.error("pruneOldMetrics", `Failed to prune old metrics: ${e.message}`);
    }

    log.debug("pruneOldMetrics", "Metrics pruned.");
};

module.exports = {
    pruneOldMetrics,
};
