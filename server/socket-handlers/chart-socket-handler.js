const { checkLogin } = require("../util-server");
const { UptimeCalculator } = require("../uptime-calculator");
const { log } = require("../../src/util");
const { assertOwnsMonitor } = require("./ownership");

module.exports.chartSocketHandler = (socket) => {
    socket.on("getMonitorChartData", async (monitorID, period, callback) => {
        try {
            checkLogin(socket);

            log.debug("monitor", `Get Monitor Chart Data: ${monitorID} User ID: ${socket.userID}`);

            if (period == null) {
                throw new Error("Invalid period.");
            }

            // UptimeCalculator only takes a monitor id, so without this check
            // any logged-in user could read another user's chart data.
            await assertOwnsMonitor(socket.userID, monitorID);

            let uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);

            let data;
            if (period <= 24) {
                data = uptimeCalculator.getDataArray(period * 60, "minute");
            } else if (period <= 720) {
                data = uptimeCalculator.getDataArray(period, "hour");
            } else {
                data = uptimeCalculator.getDataArray(period / 24, "day");
            }

            callback({
                ok: true,
                data,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
