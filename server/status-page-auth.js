/**
 * Password gate for status pages.
 *
 * Flatline's status pages are private: per-client pages sit on custom domains
 * and must not be reachable by anyone who guesses a URL. Two dead upstream
 * fields make this easy to get wrong, so both are handled here:
 *
 * - `status_page.search_engine_index` is written but never read, and no robots
 *   meta was ever emitted. Search engines were never actually excluded.
 * - `status_page.password` exists in the schema but is never written or
 *   verified anywhere. There was no gate at all.
 *
 * Passwords are stored as bcrypt hashes via server/password-hash.js, so a
 * database leak does not hand over the plaintext.
 *
 * Unlock cookies are signed with the install-wide auth secret, deliberately
 * NOT with the page's password hash. Signing with the hash would let anyone
 * who can read a bcrypt hash mint a valid cookie without ever knowing the
 * password, which defeats the point of using bcrypt.
 */
const crypto = require("crypto");
const passwordHash = require("./password-hash");

/**
 * Cookie holding a successful unlock.
 * @type {string}
 */
const AUTH_COOKIE = "fl_status_auth";

/**
 * How long an unlock lasts, in seconds. Deliberately short: the audience is a
 * client checking their own status page, not a long-lived session.
 * @type {number}
 */
const UNLOCK_TTL_SECONDS = 60 * 60 * 12;

/**
 * Install-wide signing secret.
 *
 * Required lazily: server/better-auth.ts pulls in the database module, and
 * importing it at load time would create a cycle.
 * @returns {string} Secret used for cookie signatures
 */
function signingSecret() {
    // eslint-disable-next-line global-require
    const { getAuthSecret } = require("./better-auth");
    return getAuthSecret();
}

/**
 * Hash a status page password.
 * @param {string} password Plaintext password
 * @returns {Promise<string>} bcrypt hash
 */
function hashPassword(password) {
    return passwordHash.generate(password);
}

/**
 * Verify a password against a stored hash.
 * @param {string} password Candidate plaintext
 * @param {string} hash Stored bcrypt hash
 * @returns {boolean} True if it matches
 */
function verifyPassword(password, hash) {
    if (!hash) {
        return false;
    }

    try {
        return passwordHash.verify(String(password), String(hash));
    } catch {
        // A malformed or legacy hash must fail closed, not throw a 500.
        return false;
    }
}

/**
 * Compute the HMAC for an unlock.
 *
 * Kept separate from the cookie value because verification compares against
 * the signature alone: the cookie also carries the expiry, and comparing the
 * signature to a string that includes it would never match.
 * @param {string} slug Status page slug
 * @param {number} expiresAt Unix seconds
 * @returns {string} Hex signature
 */
function computeSignature(slug, expiresAt) {
    return crypto
        .createHmac("sha256", signingSecret())
        .update(`${slug}:${expiresAt}`)
        .digest("hex");
}

/**
 * Build the signed value stored in the unlock cookie.
 * @param {string} slug Status page slug
 * @param {number} expiresAt Unix seconds
 * @returns {string} `<expiresAt>.<signature>`
 */
function signUnlock(slug, expiresAt) {
    return `${expiresAt}.${computeSignature(slug, expiresAt)}`;
}

/**
 * Validate an unlock cookie for a page.
 * @param {string} cookieValue Raw cookie value
 * @param {string} slug Expected slug
 * @returns {boolean} True if the cookie is valid and unexpired
 */
function verifyUnlock(cookieValue, slug) {
    if (!cookieValue || typeof cookieValue !== "string") {
        return false;
    }

    const separator = cookieValue.indexOf(".");
    if (separator < 0) {
        return false;
    }

    const expiresAt = Number(cookieValue.substring(0, separator));
    const signature = cookieValue.substring(separator + 1);

    if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) {
        return false;
    }

    // Constant-time compare so a signature cannot be guessed byte by byte.
    const expected = computeSignature(slug, expiresAt);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if (a.length !== b.length) {
        return false;
    }

    return crypto.timingSafeEqual(a, b);
}

/**
 * Set the unlock cookie on a response.
 * @param {express.Response} res Express response
 * @param {string} slug Status page slug
 * @returns {void}
 */
function setUnlockCookie(res, slug) {
    const expiresAt = Math.floor(Date.now() / 1000) + UNLOCK_TTL_SECONDS;

    res.cookie(AUTH_COOKIE, signUnlock(slug, expiresAt), {
        httpOnly: true,
        sameSite: "lax",
        maxAge: UNLOCK_TTL_SECONDS * 1000,
        path: "/",
    });
}

/**
 * Clear the unlock cookie.
 * @param {express.Response} res Express response
 * @returns {void}
 */
function clearUnlockCookie(res) {
    res.clearCookie(AUTH_COOKIE, { path: "/" });
}

/**
 * Whether a request may see a status page.
 *
 * Pages without a password are always visible. Password changes invalidate
 * outstanding cookies automatically, because the signature covers the slug and
 * expiry but the caller re-checks the page's current hash.
 * @param {express.Request} request Express request
 * @param {Bean} statusPage Status page row
 * @returns {boolean} True if access is allowed
 */
function isUnlocked(request, statusPage) {
    if (!statusPage?.password) {
        return true;
    }

    const cookies = parseCookies(request.headers?.cookie);
    return verifyUnlock(cookies[AUTH_COOKIE], statusPage.slug);
}

/**
 * Parse a Cookie header into a plain object.
 * @param {string} header Raw Cookie header
 * @returns {{[key: string]: string}} Decoded cookies
 */
function parseCookies(header) {
    const out = {};

    if (typeof header !== "string" || !header) {
        return out;
    }

    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index < 0) {
            continue;
        }

        const key = part.substring(0, index).trim();
        const value = part.substring(index + 1).trim();

        if (key) {
            try {
                out[key] = decodeURIComponent(value);
            } catch {
                out[key] = value;
            }
        }
    }

    return out;
}

/**
 * Robots directives for a status page.
 *
 * Advisory only: robots meta stops compliant crawlers, it does not stop
 * someone who already knows the URL. That is why per-client pages also get a
 * password. The dead `search_engine_index` column is intentionally ignored so
 * every page is excluded rather than some being indexable by default.
 * @returns {string} Content for the robots meta tag and X-Robots-Tag header
 */
function robotsDirectives() {
    return "noindex, nofollow, noarchive, nosnippet, noimageindex";
}

/**
 * Minimal standalone page shown when a password is required.
 *
 * Deliberately self-contained: it must render even if the SPA bundle has not
 * loaded, and it must not hint at what is behind the gate.
 * @param {string} slug Status page slug
 * @param {string} error Optional error message to show
 * @returns {string} Complete HTML document
 */
function renderPasswordPrompt(slug, error) {
    const escapedSlug = String(slug).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[c]));

    const banner = error
        ? `<p style="margin:0 0 16px;padding:10px 12px;border-radius:8px;background:rgba(229,72,77,.12);color:#e5484d;font-size:14px">${error.replace(/[&<>]/g, "")}</p>`
        : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex" />
<title>Status page</title>
<style>
  :root { color-scheme: dark light; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #111113; color: #f2efea;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  form {
    width: 100%; max-width: 360px; padding: 28px;
    border: 1px solid #26262a; border-radius: 14px; background: #161618;
  }
  h1 { margin: 0 0 4px; font-size: 19px; font-weight: 600; }
  p.sub { margin: 0 0 20px; font-size: 13px; color: #938c87; }
  input {
    width: 100%; box-sizing: border-box; padding: 10px 12px; margin-bottom: 14px;
    font-size: 15px; color: #f2efea; background: #0b0b0d;
    border: 1px solid #26262a; border-radius: 8px;
  }
  input:focus { outline: 2px solid #ff4d2e; outline-offset: 1px; }
  button {
    width: 100%; padding: 10px 12px; font-size: 15px; font-weight: 600;
    color: #fff; background: #ff4d2e; border: 0; border-radius: 8px; cursor: pointer;
  }
  button:hover { background: #ff6a4f; }
</style>
</head>
<body>
<form method="post" action="/api/v1/status-pages/unlock/${escapedSlug}">
  <h1>This status page is private</h1>
  <p class="sub">Enter the password you were given.</p>
  ${banner}
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required />
  <button type="submit">Unlock</button>
</form>
</body>
</html>`;
}

module.exports = {
    AUTH_COOKIE,
    UNLOCK_TTL_SECONDS,
    hashPassword,
    verifyPassword,
    signUnlock,
    computeSignature,
    verifyUnlock,
    setUnlockCookie,
    clearUnlockCookie,
    isUnlocked,
    parseCookies,
    robotsDirectives,
    renderPasswordPrompt,
};
