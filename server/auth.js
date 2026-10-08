const basicAuth = require("express-basic-auth");
const passwordHash = require("./password-hash");
const { R } = require("redbean-node");
const { log } = require("../src/util");
const { loginRateLimiter, apiRateLimiter, apiKeyRateLimiter, apiAbuseLimiter } = require("./rate-limiter");
const { Settings } = require("./settings");
const dayjs = require("dayjs");
const { checkPassword } = require("./better-auth");

/**
 * @deprecated DO NOT CALL IT. Use Better Auth instead.
 * Old Login function, keep it for migration purposes.
 * @param {string} username Username to login with
 * @param {string} password Password to login with
 * @returns {Promise<(Bean|null)>} User or null if login failed
 */
exports.login = async function (username, password) {
    if (typeof username !== "string" || typeof password !== "string") {
        return null;
    }

    let user = await R.findOne("user", "TRIM(username) = ? AND active = 1 ", [username.trim()]);

    if (user && passwordHash.verify(password, user.password)) {
        // Upgrade the hash to bcrypt
        if (passwordHash.needRehash(user.password)) {
            await R.exec("UPDATE `user` SET password = ? WHERE id = ? ", [
                await passwordHash.generate(password),
                user.id,
            ]);
        }
        return user;
    }

    return null;
};

/**
 * Validate a provided API key
 * @param {string} key API key to verify
 * @returns {boolean} API is ok?
 */
async function verifyAPIKey(key) {
    return !!(await resolveAPIKey(key));
}

/**
 * Resolve an API key to its database row.
 *
 * Token format is `uk<keyID>_<secret>`. The key ID is in the clear so the
 * row can be looked up directly, and only the secret half is hashed, so a
 * leaked database cannot be replayed into working tokens.
 * @param {string} key Full API key, including the `uk<id>_` prefix
 * @returns {Promise<?Bean>} The matching api_key row, or null if invalid,
 * expired, inactive or malformed
 */
async function resolveAPIKey(key) {
    if (typeof key !== "string") {
        return null;
    }

    // Expect "uk" prefix, then the key ID up to the first underscore.
    if (!key.startsWith("uk")) {
        return null;
    }

    let separator = key.indexOf("_");
    if (separator < 0) {
        return null;
    }

    let index = key.substring(2, separator);
    let clear = key.substring(separator + 1);

    // Guard against a non-numeric ID producing an odd query.
    if (!/^[0-9]+$/.test(index) || clear.length === 0) {
        return null;
    }

    let hash = await R.findOne("api_key", " id = ? ", [index]);

    if (!hash) {
        return null;
    }

    let current = dayjs();
    let expiry = dayjs(hash.expires);
    if (expiry.diff(current) < 0 || !hash.active) {
        return null;
    }

    if (!passwordHash.verify(clear, hash.key)) {
        return null;
    }

    return hash;
}

/**
 * Ordered scope hierarchy, weakest first.
 *
 * Holding a scope implies everything below it, so a token with `publish` can
 * also write and read. `publish` is separated from `write` because it gates
 * the actions that make something reachable from the internet: publishing a
 * status page, attaching a CNAME, deleting a page. An agent that can fix a
 * broken page layout should not be able to expose a client's page.
 * @type {string[]}
 */
const SCOPES = [ "read", "write", "publish" ];

/**
 * Resolve the scopes granted to an API key.
 *
 * Keys created before scopes existed have a NULL `scopes` value; those get
 * full access including `publish` so upgrading never locks anyone out.
 * @param {Bean} apiKeyBean Row returned by resolveAPIKey
 * @returns {string[]} Array of granted scopes
 */
function apiKeyScopes(apiKeyBean) {
    let scopes = apiKeyBean.scopes;

    if (!scopes) {
        return [ ...SCOPES ];
    }

    return String(scopes)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
}

/**
 * Whether a granted scope set satisfies a required scope.
 *
 * Implied by rank, so `publish` satisfies a `write` requirement.
 * @param {string[]} granted Scopes on the token
 * @param {string} required Scope the endpoint needs
 * @returns {boolean} True if allowed
 */
function hasScope(granted, required) {
    if (!SCOPES.includes(required)) {
        // Unknown requirement: fail closed.
        return false;
    }

    const requiredRank = SCOPES.indexOf(required);

    return granted.some((scope) => {
        const rank = SCOPES.indexOf(scope);
        return rank >= requiredRank;
    });
}

/**
 * Callback for basic auth authorizers
 * @callback authCallback
 * @param {any} err Any error encountered
 * @param {boolean} authorized Is the client authorized?
 */

/**
 * Custom authorizer for express-basic-auth
 * @param {string} username Username to login with
 * @param {string} password Password to login with
 * @param {authCallback} callback Callback to handle login result
 * @returns {void}
 */
function apiAuthorizer(username, password, callback) {
    // API Rate Limit
    apiRateLimiter.pass(null, 0).then((pass) => {
        if (pass) {
            verifyAPIKey(password).then((valid) => {
                if (!valid) {
                    log.warn("api-auth", "Failed API auth attempt: invalid API Key");
                }
                callback(null, valid);
                // Only allow a set number of api requests per minute
                // (currently set to 60)
                apiRateLimiter.removeTokens(1);
            });
        } else {
            log.warn("api-auth", "Failed API auth attempt: rate limit exceeded");
            callback(null, false);
        }
    });
}

/**
 * Custom authorizer for express-basic-auth
 * @param {string} username Username to login with
 * @param {string} password Password to login with
 * @param {authCallback} callback Callback to handle login result
 * @returns {void}
 */
function userAuthorizer(username, password, callback) {
    // Login Rate Limit
    loginRateLimiter.pass(null, 0).then((pass) => {
        if (pass) {
            checkPassword(username, password)
                .then((valid) => {
                    callback(null, valid);

                    if (!valid) {
                        log.warn("basic-auth", "Failed basic auth attempt: invalid username/password");
                        loginRateLimiter.removeTokens(1);
                    }
                })
                .catch((e) => {
                    log.error("basic-auth", "Auth error:", e);
                    callback(null, false);
                });
        } else {
            log.warn("basic-auth", "Failed basic auth attempt: rate limit exceeded");
            callback(null, false);
        }
    });
}

/**
 * Use basic auth if auth is not disabled
 * @param {express.Request} req Express request object
 * @param {express.Response} res Express response object
 * @param {express.NextFunction} next Next handler in chain
 * @returns {Promise<void>}
 */
exports.basicAuth = async function (req, res, next) {
    const middleware = basicAuth({
        authorizer: userAuthorizer,
        authorizeAsync: true,
        challenge: true,
    });

    const disabledAuth = await Settings.get("disableAuth");

    if (!disabledAuth) {
        middleware(req, res, next);
    } else {
        next();
    }
};

/**
 * Use use API Key if API keys enabled, else use basic auth
 * @param {express.Request} req Express request object
 * @param {express.Response} res Express response object
 * @param {express.NextFunction} next Next handler in chain
 * @returns {Promise<void>}
 */
exports.apiAuth = async function (req, res, next) {
    if (!(await Settings.get("disableAuth"))) {
        let usingAPIKeys = await Settings.get("apiKeysEnabled");
        let middleware;
        if (usingAPIKeys) {
            middleware = basicAuth({
                authorizer: apiAuthorizer,
                authorizeAsync: true,
                challenge: true,
            });
        } else {
            middleware = basicAuth({
                authorizer: userAuthorizer,
                authorizeAsync: true,
                challenge: true,
            });
        }
        middleware(req, res, next);
    } else {
        next();
    }
};

/**
 * Token auth for the v1 REST API.
 *
 * Accepts `Authorization: Bearer <token>` as the primary scheme, and falls
 * back to HTTP Basic (token as the password) so the same credential works
 * from curl, scripts and agents that only speak Basic.
 *
 * On success the resolved key's `userID` and `scopes` are attached to the
 * request, so handlers never need to re-validate the token.
 * @param {string} requiredScope Scope this endpoint needs ("read" or "write")
 * @returns {Function} Express middleware
 */
exports.SCOPES = SCOPES;
exports.hasScope = hasScope;

exports.tokenAuth = function (requiredScope = "read") {
    return async function (req, res, next) {
        if (await Settings.get("disableAuth")) {
            log.warn("api-auth", "API request allowed without a token because auth is disabled");
            req.apiUser = null;
            req.apiScopes = [ "read", "write" ];
            return next();
        }

        let token = extractBearerToken(req);

        if (!token) {
            res.status(401).set("WWW-Authenticate", "Bearer").json({
                ok: false,
                error: "unauthorized",
                message: "Provide an API token via 'Authorization: Bearer <token>'.",
            });
            return;
        }

        let apiKeyBean = await resolveAPIKey(token);

        if (!apiKeyBean) {
            // Unresolvable tokens get no bucket; cap them globally so a
            // credential-stuffing flood still throttles.
            if ((await apiAbuseLimiter.removeTokens(1)) < 0) {
                res.status(429).json({
                    ok: false,
                    error: "rate_limited",
                    message: "Too frequently, try again later.",
                });
                return;
            }
            log.warn("api-auth", "Failed API auth attempt: invalid, expired or inactive token");
            res.status(401).set("WWW-Authenticate", "Bearer").json({
                ok: false,
                error: "unauthorized",
                message: "Invalid, expired or inactive API token.",
            });
            return;
        }

        // Authenticated traffic is limited per key (600/min), so one chatty
        // client — a dashboard polling fleet metrics, say — only throttles
        // itself, never every other token.
        if ((await apiKeyRateLimiter.removeTokens(apiKeyBean.id, 1)) < 0) {
            log.warn("api-auth", `Rate limit exceeded for API key ${apiKeyBean.id}`);
            res.status(429).json({
                ok: false,
                error: "rate_limited",
                message: "Too frequently, try again later.",
            });
            return;
        }

        let scopes = apiKeyScopes(apiKeyBean);

        if (!hasScope(scopes, requiredScope)) {
            log.warn("api-auth", `Token lacks "${requiredScope}" scope (has: ${scopes.join(",") || "none"})`);
            res.status(403).json({
                ok: false,
                error: "forbidden",
                message: `This token does not have the "${requiredScope}" scope.`,
            });
            return;
        }

        req.apiUser = apiKeyBean.user_id;
        req.apiKeyID = apiKeyBean.id;
        req.apiScopes = scopes;
        next();
    };
};

/**
 * Pull the API token out of a request.
 *
 * Bearer is preferred. Basic auth is also accepted with the token as the
 * password and any username, matching how the existing API keys behave.
 * @param {express.Request} req Express request object
 * @returns {?string} The token, or null if none was supplied
 */
function extractBearerToken(req) {
    let header = req.headers.authorization;

    if (typeof header !== "string") {
        return null;
    }

    if (/^bearer\s+/i.test(header)) {
        let token = header.replace(/^bearer\s+/i, "").trim();
        return token.length > 0 ? token : null;
    }

    if (/^basic\s+/i.test(header)) {
        let decoded = Buffer.from(header.replace(/^basic\s+/i, "").trim(), "base64").toString("utf8");
        let separator = decoded.indexOf(":");

        if (separator < 0) {
            return null;
        }

        // Username is unused; the token is the password.
        let password = decoded.substring(separator + 1);
        return password.length > 0 ? password : null;
    }

    return null;
}
