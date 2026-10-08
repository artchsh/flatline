/**
 * Error whose message is a translation key.
 * @augments Error
 */
class TranslatableError extends Error {
    /**
     * Indicates that the error message is a translation key.
     */
    msgi18n = true;

    /**
     * Create a TranslatableError.
     * @param {string} key - Translation key (no renderer remains since the Vue
     * frontend was removed; the raw key reaches API clients)
     * @param {object} meta Arbitrary metadata
     */
    constructor(key, meta = {}) {
        super(key);
        this.meta = meta;
        Error.captureStackTrace(this, this.constructor);
    }
}
module.exports = TranslatableError;
