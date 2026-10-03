const express = require("express");

/**
 * Stand up a fake Telegram Bot API server.
 *
 * The Telegram provider posts to
 * `${telegramServerUrl}/bot${token}/sendMessage`, so pointing
 * `telegramServerUrl` at a local server lets tests assert on the real outbound
 * payload (and assert that nothing was sent at all) without touching the
 * network or needing a bot token.
 * @param {number} port Port to listen on
 * @param {string} path Path the provider should post to
 * @param {number} timeout How long to wait for a request before giving up
 * @returns {Promise<{body: object}|{reason: string}>} Resolves with the
 * captured request body, or `{ reason: "Timeout" }` if none arrived
 */
function mockTelegram(port, path = "sendMessage", timeout = 2500) {
    return new Promise((resolve, reject) => {
        const app = express();
        let settled = false;

        const tmo = setTimeout(() => {
            if (!settled) {
                settled = true;
                server.close();
                resolve({ reason: "Timeout" });
            }
        }, timeout);

        app.use(express.json());
        app.post(`/*`, (req, res) => {
            res.status(200).json({ ok: true, result: { message_id: 1 } });
            if (!settled) {
                settled = true;
                server.close();
                clearTimeout(tmo);
                resolve({ body: req.body });
            }
        });

        const server = app.listen(port, () => {
            server.on("error", (e) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(tmo);
                    reject(e);
                }
            });
        });
    });
}

module.exports = mockTelegram;