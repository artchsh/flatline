const { RateLimiter } = require("limiter");
const { log } = require("../src/util");

class KumaRateLimiter {
    /**
     * @param {object} config Rate limiter configuration object
     */
    constructor(config) {
        this.errorMessage = config.errorMessage;
        this.tokensPerInterval = config.tokensPerInterval;
        this.rateLimiter = new RateLimiter(config);
    }

    /**
     * Callback for pass
     * @callback passCB
     * @param {object} err Too many requests
     */

    /**
     * Should the request be passed through
     * @param {passCB} callback Callback function to call with decision
     * @param {number} num Number of tokens to remove
     * @returns {Promise<boolean>} Should the request be allowed?
     */
    async pass(callback, num = 1) {
        const remainingRequests = await this.removeTokens(num);
        if (remainingRequests < this.tokensPerInterval * 0.2) {
            log.warn(
                "rate-limit",
                `${remainingRequests}/${this.tokensPerInterval} remaining requests until rate limiting`
            );
        } else {
            log.debug(
                "rate-limit",
                `${remainingRequests}/${this.tokensPerInterval} remaining requests until rate limiting`
            );
        }
        if (remainingRequests < 0) {
            if (callback) {
                callback({
                    ok: false,
                    msg: this.errorMessage,
                });
            }
            return false;
        }
        return true;
    }

    /**
     * Remove a given number of tokens
     * @param {number} num Number of tokens to remove
     * @returns {Promise<number>} Number of remaining tokens
     */
    async removeTokens(num = 1) {
        return await this.rateLimiter.removeTokens(num);
    }
}

const loginRateLimiter = new KumaRateLimiter({
    tokensPerInterval: 20,
    interval: "minute",
    fireImmediately: true,
    errorMessage: "Too frequently, try again later.",
});

const apiRateLimiter = new KumaRateLimiter({
    tokensPerInterval: 60,
    interval: "minute",
    fireImmediately: true,
    errorMessage: "Too frequently, try again later.",
});

/**
 * Per-API-key rate limiter.
 *
 * The global apiRateLimiter above is one bucket shared by every caller: a
 * single dashboard polling Superboard metrics (one request per server per
 * refresh) could starve every other client. Authenticated traffic is
 * therefore limited per key instead, so one chatty client only throttles
 * itself. Buckets are created lazily per key id; keys are few and long
 * lived, so no eviction is needed.
 */
class KeyedRateLimiter {
    /**
     * @param {object} config RateLimiter config (tokensPerInterval, interval)
     */
    constructor(config) {
        this.config = config;
        this.buckets = new Map();
    }

    /**
     * Consume tokens from a key's bucket.
     * @param {string|number} keyId API key id the bucket belongs to
     * @param {number} num Tokens to consume
     * @returns {Promise<number>} Remaining tokens (negative when over limit)
     */
    async removeTokens(keyId, num = 1) {
        let bucket = this.buckets.get(keyId);
        if (!bucket) {
            const { RateLimiter } = require("limiter");
            bucket = new RateLimiter({ ...this.config, fireImmediately: true });
            this.buckets.set(keyId, bucket);
        }
        return await bucket.removeTokens(num);
    }
}

const apiKeyRateLimiter = new KeyedRateLimiter({
    tokensPerInterval: 600,
    interval: "minute",
});

// Invalid tokens never resolve to a key, so they cannot have a bucket.
// Cap them globally instead: low enough to blunt credential stuffing, high
// enough that a typo'd token in a retry loop does not lock out the network.
const apiAbuseLimiter = new KumaRateLimiter({
    tokensPerInterval: 120,
    interval: "minute",
    fireImmediately: true,
    errorMessage: "Too frequently, try again later.",
});

// Invite redemption is unauthenticated: the token is the only credential, so
// this caps attempts per IP. Tokens are 32 random bytes so guessing is already
// infeasible; this is belt and braces against a flood of requests.
const inviteRateLimiter = new KumaRateLimiter({
    tokensPerInterval: 20,
    interval: "minute",
    fireImmediately: true,
    errorMessage: "Too frequently, try again later.",
});

module.exports = {
    loginRateLimiter,
    apiRateLimiter,
    apiKeyRateLimiter,
    apiAbuseLimiter,
    inviteRateLimiter,
};
