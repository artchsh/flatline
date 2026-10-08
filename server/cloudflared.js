/**
 * Cloudflared tunnel lifecycle.
 *
 * Split out of the old cloudflared socket handler when Socket.IO was
 * removed: starting and stopping the tunnel on boot/shutdown is server
 * behaviour, while the running/message/error broadcasts went to a browser
 * that no longer exists. Status now goes to the log.
 */
const { setSetting, setting } = require("./util-server");
const { CloudflaredTunnel } = require("node-cloudflared-tunnel");
const { log } = require("../src/util");

const cloudflared = new CloudflaredTunnel();

cloudflared.change = (running, message) => {
    log.info("cloudflared", `Tunnel running=${running}: ${message}`);
};

cloudflared.error = (errorMessage) => {
    log.error("cloudflared", errorMessage);
};

/**
 * Automatically start cloudflared.
 * @param {string} token Cloudflared tunnel token
 * @returns {Promise<void>}
 */
async function autoStart(token) {
    if (!token) {
        token = await setting("cloudflaredTunnelToken");
    } else {
        // Override the current token via args or env var
        await setSetting("cloudflaredTunnelToken", token);
        log.info("cloudflare", "Use cloudflared token from args or env var");
    }

    if (token) {
        log.info("cloudflare", "Start cloudflared");
        cloudflared.token = token;
        cloudflared.start();
    }
}

/**
 * Stop cloudflared.
 * @returns {Promise<void>}
 */
async function stop() {
    log.info("cloudflared", "Stop cloudflared");
    if (cloudflared) {
        cloudflared.stop();
    }
}

module.exports = {
    autoStart,
    stop,
};
