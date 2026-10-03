/**
 * Socket room name for shared-instance broadcasts.
 *
 * Flatline treats every logged-in user as equal: there are no roles and every
 * user sees and edits the same monitors, notifications, maintenance windows,
 * proxies and containers. Upstream instead scopes each of those to
 * `user_id` and emits updates to a per-user room, which meant a second user saw
 * an empty dashboard.
 *
 * Both still happen: the per-user room is joined as well, because API keys and
 * invite links are genuinely per-user (each token is bound to the user who
 * created it). Broadcasts for shared resources go to this room instead.
 * @type {string}
 */
const SHARED_ROOM = "flatline:shared";

module.exports = {
    SHARED_ROOM,
};
