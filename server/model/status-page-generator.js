const { R } = require("redbean-node");
const { log } = require("../../src/util");
const Monitor = require("./monitor");

/**
 * Generates and maintains status pages from `type: "group"` monitors.
 *
 * Flatline's shape: one group monitor per client, each optionally publishing
 * its own public status page, plus a private aggregate view over all of them.
 * A generated page is not hand-maintained — it mirrors its group.
 *
 * Three deliberate behaviours:
 *
 * 1. The slug is derived once, at creation, and never again. Renaming a group
 *    must not break a URL a client has already published.
 * 2. Membership is reconciled, not appended. Monitors added to the group appear
 *    on the page; monitors removed disappear. That is what makes the page
 *    "as simple as possible to configure" — you never touch the page itself.
 * 3. Deleting a group unpublishes its page rather than deleting it. A client's
 *    status URL outliving their contract is better than a 404.
 */

/**
 * Derive a URL-safe slug from a human name.
 *
 * Matches the rule enforced for hand-entered slugs in
 * status-page-socket-handler.js: alphanumeric words joined by single hyphens.
 * @param {string} name Human-readable name, e.g. "Client A (EU)"
 * @returns {string} Slug candidate, e.g. "client-a-eu"
 */
function slugify(name) {
    return String(name ?? "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/['’`]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
}

/**
 * Find a slug that is not already taken.
 *
 * A generated page's slug is pinned, so this only ever runs once per page.
 * @param {string} base Preferred slug
 * @returns {Promise<string>} Unused slug, suffixed `-2`, `-3`, ... if needed
 */
async function uniqueSlug(base) {
    let candidate = base;
    let suffix = 2;

    // A name that slugifies to nothing falls back rather than failing.
    while (!candidate) {
        candidate = `page-${suffix}`;
        suffix++;
    }

    while (await R.findOne("status_page", " slug = ? ", [ candidate ])) {
        candidate = `${base}-${suffix}`;
        suffix++;
    }

    return candidate;
}

/**
 * The single `group` (status page section) row backing a generated page.
 * @param {number} statusPageID Owning status page
 * @returns {Promise<?Bean>} The section row
 */
async function findSection(statusPageID) {
    return await R.findOne("group", " status_page_id = ? ", [ statusPageID ]);
}

/**
 * Monitor ids currently linked to a page section.
 * @param {number} groupID Section id
 * @returns {Promise<number[]>} Linked monitor ids
 */
async function linkedMonitorIDs(groupID) {
    const rows = await R.getAll("SELECT monitor_id FROM monitor_group WHERE group_id = ?", [ groupID ]);
    return rows.map((r) => r.monitor_id);
}

/**
 * Reconcile a page section's monitors against a group's current children.
 *
 * Additive and subtractive in one pass so calling it repeatedly converges.
 * @param {number} groupID Section id
 * @param {number[]} desired Monitor ids that should be present
 * @returns {Promise<{added: number, removed: number}>} What changed
 */
async function reconcileSectionMonitors(groupID, desired) {
    const want = new Set(desired.map(Number));
    const have = new Set(await linkedMonitorIDs(groupID));

    const toAdd = [...want].filter((id) => !have.has(id));
    const toRemove = [...have].filter((id) => !want.has(id));

    for (const id of toRemove) {
        await R.exec("DELETE FROM monitor_group WHERE group_id = ? AND monitor_id = ?", [ groupID, id ]);
    }

    for (const id of toAdd) {
        await R.exec(
            "INSERT INTO monitor_group (monitor_id, group_id, weight, send_url) VALUES (?, ?, 0, 0)",
            [ id, groupID ]
        );
    }

    return { added: toAdd.length, removed: toRemove.length };
}

/**
 * All monitor ids belonging to a group monitor, including nested groups.
 *
 * A group may itself contain groups, so a client can be structured. Use
 * getAllChildrenIDs so nested monitors are published too.
 * @param {number} groupMonitorID The `type: "group"` monitor
 * @returns {Promise<number[]>} Descendant monitor ids
 */
async function descendantMonitorIDs(groupMonitorID) {
    return (await Monitor.getAllChildrenIDs(groupMonitorID)).map(Number);
}

/**
 * Create the status page for a group, or return the existing one.
 *
 * Idempotent: calling it twice for the same group returns the same page rather
 * than creating a duplicate.
 * @param {number} groupMonitorID The `type: "group"` monitor
 * @param {object} options Options
 * @param {?string} options.slug Explicit slug; defaults to one derived from the name
 * @param {?string} options.title Explicit title; defaults to the group name
 * @param {?string} options.accentColor Hex accent for branding
 * @returns {Promise<{statusPage: Bean, created: boolean}>} The page
 */
async function ensureStatusPage(groupMonitorID, options = {}) {
    const group = await R.findOne("monitor", " id = ? AND type = ? ", [ groupMonitorID, "group" ]);

    if (!group) {
        throw new Error("No such group monitor.");
    }

    const existing = await R.findOne("status_page", " source_group_monitor_id = ? ", [ groupMonitorID ]);
    if (existing) {
        return { statusPage: existing, created: false };
    }

    const title = (options.title ?? group.name ?? "Status").trim() || "Status";
    const requested = options.slug ? slugify(options.slug) : slugify(group.name);
    const slug = await uniqueSlug(requested);

    let statusPage = R.dispense("status_page");
    statusPage.slug = slug;
    statusPage.title = title;
    statusPage.description = `Service status for ${title}.`;
    statusPage.theme = "auto";
    statusPage.icon = "";
    statusPage.autoRefreshInterval = 0;
    statusPage.published = 1;
    statusPage.showPoweredBy = 0;
    statusPage.generated = 1;
    statusPage.sourceGroupMonitorId = groupMonitorID;

    if (options.accentColor) {
        statusPage.accentColor = normaliseAccent(options.accentColor);
    }

    await R.store(statusPage);

    // One section per generated page, named after the group it mirrors.
    let section = R.dispense("group");
    section.statusPageId = statusPage.id;
    section.name = title;
    section.public = 1;
    section.active = 1;
    await R.store(section);

    await reconcileSectionMonitors(section.id, await descendantMonitorIDs(groupMonitorID));

    log.info("status-page", `Generated status page "${slug}" for group monitor ${groupMonitorID}`);

    return { statusPage, created: true };
}

/**
 * Re-sync a generated page from its group.
 *
 * Follows the group on rename, but never on slug. Safe to call often.
 * @param {number} groupMonitorID The `type: "group"` monitor
 * @returns {Promise<?{statusPage: Bean, changed: object}>} Result, or null if
 * the group has no generated page
 */
async function syncStatusPage(groupMonitorID) {
    const statusPage = await R.findOne("status_page", " source_group_monitor_id = ? ", [ groupMonitorID ]);

    if (!statusPage) {
        return null;
    }

    const group = await R.findOne("monitor", " id = ? ", [ groupMonitorID ]);
    if (!group) {
        return null;
    }

    let titleChanged = false;

    // Title tracks the group; the slug is pinned at creation.
    if (statusPage.title !== group.name) {
        statusPage.title = group.name;
        titleChanged = true;
    }

    const section = await findSection(statusPage.id);
    if (!section) {
        return null;
    }

    if (section.name !== group.name) {
        section.name = group.name;
        await R.store(section);
        titleChanged = true;
    }

    const changed = await reconcileSectionMonitors(section.id, await descendantMonitorIDs(groupMonitorID));

    if (titleChanged) {
        await R.store(statusPage);
    }

    return { statusPage, changed };
}

/**
 * Unpublish a group's status page without deleting it.
 *
 * Keeps the slug and the incident history so the client's URL keeps working.
 * @param {number} groupMonitorID The `type: "group"` monitor
 * @returns {Promise<boolean>} True if a page was unpublished
 */
async function unpublishStatusPage(groupMonitorID) {
    const statusPage = await R.findOne("status_page", " source_group_monitor_id = ? ", [ groupMonitorID ]);

    if (!statusPage || !statusPage.published) {
        return false;
    }

    statusPage.published = 0;
    await R.store(statusPage);

    log.info("status-page", `Unpublished status page "${statusPage.slug}" for group ${groupMonitorID}`);

    return true;
}

/**
 * Unpublish a page by its own id, regardless of which group owns it.
 * @param {number} statusPageID Status page id
 * @returns {Promise<boolean>} True if unpublished
 */
async function unpublishByID(statusPageID) {
    const statusPage = await R.findOne("status_page", " id = ? ", [ statusPageID ]);

    if (!statusPage || !statusPage.published) {
        return false;
    }

    statusPage.published = 0;
    await R.store(statusPage);
    return true;
}

/**
 * Re-sync every generated page.
 *
 * Called on boot and after bulk monitor changes, so a restart or a reordering
 * cannot leave a page stale.
 * @returns {Promise<number>} Number of pages synced
 */
async function syncAllGenerated() {
    const pages = await R.getAll("SELECT id, source_group_monitor_id FROM status_page WHERE generated = 1");

    let synced = 0;

    for (const page of pages) {
        // A dangling source group means the monitor was deleted. Unpublish
        // rather than serving a frozen page that looks live.
        const group = await R.findOne("monitor", " id = ? ", [ page.source_group_monitor_id ]);
        if (!group) {
            const statusPage = await R.findOne("status_page", " id = ? ", [ page.id ]);
            if (statusPage && statusPage.published) {
                statusPage.published = 0;
                await R.store(statusPage);
            }
            continue;
        }

        await syncStatusPage(page.source_group_monitor_id);
        synced++;
    }

    return synced;
}

/**
 * Normalise and validate an accent colour.
 *
 * Free-form hex as chosen, but stored canonically uppercase 6-digit with a
 * leading `#`, so the public site can use it directly as a CSS value.
 * @param {string} value Candidate colour
 * @returns {?string} Canonical hex, or null when unset
 * @throws {Error} If the value is not a hex colour
 */
function normaliseAccent(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    let hex = String(value).trim();

    if (!hex.startsWith("#")) {
        hex = `#${hex}`;
    }

    // Expand #abc to #aabbcc.
    if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
        hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    }

    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
        throw new Error("Accent colour must be a hex colour such as #ff4d2e.");
    }

    return hex.toUpperCase();
}

module.exports = {
    slugify,
    uniqueSlug,
    normaliseAccent,
    ensureStatusPage,
    syncStatusPage,
    unpublishStatusPage,
    unpublishByID,
    syncAllGenerated,
    reconcileSectionMonitors,
    descendantMonitorIDs,
};
