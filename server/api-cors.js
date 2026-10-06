/**
 * CORS for the token-authenticated REST API.
 *
 * The existing helpers in util-server.js are for the legacy badge/status
 * endpoints: they omit `Authorization` from Access-Control-Allow-Headers and
 * `allowDevOrigin` only fires in development. Neither is usable by a
 * browser-based dashboard or a browser-hosted agent.
 *
 * Allowing `*` here is deliberate and safe in a way it would not be for the
 * cookie-authenticated app: a bearer token is not an ambient credential, so a
 * cross-origin page cannot cause an authenticated request the way it could
 * with cookies. There is no `Access-Control-Allow-Credentials` below, which
 * keeps it that way.
 *
 * Set FLATLINE_CORS_ORIGINS to a comma-separated list to restrict it.
 */

/**
 * Parse the configured origin allowlist.
 * @returns {string[]} Allowed origins, or ["*"]
 */
function allowedOrigins() {
    const raw = process.env.FLATLINE_CORS_ORIGINS;

    if (!raw || !raw.trim()) {
        return [ "*" ];
    }

    return raw
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
}

/**
 * Express middleware adding CORS headers and answering preflight.
 *
 * Mounted before the routers so a preflight never reaches route handlers,
 * which would otherwise 404 or reject it before the headers are set.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @param {express.NextFunction} next Next handler
 * @returns {void}
 */
function apiCors(req, res, next) {
    const origins = allowedOrigins();
    const requestOrigin = req.get("origin");

    if (origins.includes("*")) {
        res.header("Access-Control-Allow-Origin", "*");
    } else if (requestOrigin && origins.includes(requestOrigin)) {
        res.header("Access-Control-Allow-Origin", requestOrigin);
        // Caches must not serve one origin's response to another.
        res.header("Vary", "Origin");
    }

    res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    // Authorization is the whole point: without it the browser blocks every
    // token-bearing request.
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
    res.header("Access-Control-Max-Age", "600");

    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }

    next();
}

module.exports = {
    apiCors,
    allowedOrigins,
};
