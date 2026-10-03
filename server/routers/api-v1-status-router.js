/**
 * REST API v1 — status pages, groups, incidents and domains.
 *
 * Split out of api-v1-router.js purely for readability; mounted alongside it.
 *
 * Scopes follow the ordered hierarchy in server/auth.js:
 *   read < write < publish
 * `publish` is required for anything that makes a page reachable from the
 * internet (publishing, attaching a CNAME, deleting a page), so an agent can
 * rearrange a client's status page without being able to expose it.
 *
 * `PUT .../groups/:groupId/monitors` is the rearrangement verb. It takes the
 * full desired membership and reconciles, so it is idempotent and safe for an
 * agent to retry.
 */
const express = require("express");
const { R } = require("redbean-node");
const { log } = require("../../src/util");
const { tokenAuth } = require("../auth");
const StatusPage = require("../model/status_page");
const generator = require("../model/status-page-generator");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

/**
 * Send a consistent error body and stop.
 * @param {express.Response} res Express response
 * @param {number} status HTTP status code
 * @param {string} error Machine-readable error code
 * @param {string} message Human-readable explanation
 * @returns {void}
 */
function fail(res, status, error, message) {
    res.status(status).json({ ok: false, error, message });
}

/**
 * Parse a positive integer id.
 * @param {any} raw Raw value
 * @returns {?number} Parsed integer or null
 */
function parseId(raw) {
    if (!/^[0-9]+$/.test(String(raw))) {
        return null;
    }
    return Number(raw);
}

/**
 * Load a status page, or respond with an error.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @param {string} idParam Raw id
 * @returns {Promise<?Bean>} The page, or null after responding
 */
async function loadPage(req, res, idParam) {
    const id = parseId(idParam);
    if (id === null) {
        fail(res, 400, "bad_request", "Status page id must be a positive integer.");
        return null;
    }

    const page = await R.findOne("status_page", " id = ? ", [ id ]);
    if (!page) {
        fail(res, 404, "not_found", `No status page with id ${id}.`);
        return null;
    }

    return page;
}

/**
 * Serialise a status page for API output.
 * @param {Bean} page Status page bean
 * @returns {Promise<object>} Safe representation
 */
async function pageToJSON(page) {
    return {
        id: page.id,
        slug: page.slug,
        title: page.title,
        description: page.description ?? null,
        published: !!page.published,
        accentColor: page.accentColor ?? null,
        theme: page.theme,
        icon: page.icon ?? null,
        showPoweredBy: !!page.show_powered_by,
        // Set on pages Flatline generated from a group monitor.
        generated: !!page.generated,
        sourceGroupMonitorId: page.source_group_monitor_id ?? null,
        domains: await page.getDomainNameList(),
        autoRefreshInterval: page.auto_refresh_interval ?? null,
        createdDate: page.created_date,
        modifiedDate: page.modified_date ?? null,
    };
}

/**
 * Serialise a status page section (the `group` table).
 * @param {Bean} section Section bean
 * @returns {Promise<object>} Safe representation
 */
async function sectionToJSON(section) {
    const monitors = await R.getAll(
        `SELECT mg.monitor_id, m.name, m.type FROM monitor_group mg
         JOIN monitor m ON m.id = mg.monitor_id
         WHERE mg.group_id = ?
         ORDER BY m.name`,
        [ section.id ]
    );

    return {
        id: section.id,
        name: section.name,
        public: !!section.public,
        active: !!section.active,
        weight: section.weight,
        monitors: monitors.map((m) => ({ id: m.monitor_id, name: m.name, type: m.type })),
    };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * Create a status page.
 */
router.post("/api/v1/status-pages", tokenAuth("write"), async (req, res) => {
    try {
        const body = req.body ?? {};

        if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
            fail(res, 400, "bad_request", "`title` is required.");
            return;
        }

        let slug;
        if (body.slug) {
            slug = await generator.uniqueSlug(generator.slugify(body.slug));
        } else {
            slug = await generator.uniqueSlug(generator.slugify(body.title));
        }

        if (!slug) {
            fail(res, 400, "bad_request", "Could not derive a slug; pass an explicit `slug`.");
            return;
        }

        let accentColor = null;
        if (body.accentColor) {
            try {
                accentColor = generator.normaliseAccent(body.accentColor);
            } catch (e) {
                fail(res, 400, "bad_request", e.message);
                return;
            }
        }

        const page = R.dispense("status_page");
        page.slug = slug;
        page.title = body.title.trim();
        page.description = body.description ?? "";
        page.theme = body.theme ?? "auto";
        page.icon = body.icon ?? "";
        page.accentColor = accentColor;
        page.published = body.published ?? 0;
        page.showPoweredBy = body.showPoweredBy ?? 0;
        page.generated = 0;
        page.autoRefreshInterval = body.autoRefreshInterval ?? 0;
        await R.store(page);

        log.info("api-v1", `Created status page "${slug}"`);
        res.status(201).json({ ok: true, statusPage: await pageToJSON(page) });
    } catch (e) {
        log.error("api-v1", `POST /status-pages failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Read one status page.
 */
router.get("/api/v1/status-pages/:id", tokenAuth("read"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }
        res.json({ ok: true, statusPage: await pageToJSON(page) });
    } catch (e) {
        log.error("api-v1", `GET /status-pages/:id failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Update a status page's configuration.
 */
router.patch("/api/v1/status-pages/:id", tokenAuth("write"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }

        const body = req.body ?? {};

        if (body.title !== undefined) {
            if (typeof body.title !== "string" || !body.title.trim()) {
                fail(res, 400, "bad_request", "`title` must be a non-empty string.");
                return;
            }
            page.title = body.title.trim();
        }

        if (body.description !== undefined) {
            page.description = String(body.description);
        }

        if (body.theme !== undefined) {
            page.theme = String(body.theme);
        }

        if (body.icon !== undefined) {
            page.icon = String(body.icon);
        }

        if (body.accentColor !== undefined) {
            try {
                page.accentColor = generator.normaliseAccent(body.accentColor);
            } catch (e) {
                fail(res, 400, "bad_request", e.message);
                return;
            }
        }

        if (body.showPoweredBy !== undefined) {
            page.showPoweredBy = Boolean(body.showPoweredBy);
        }

        if (body.autoRefreshInterval !== undefined) {
            page.autoRefreshInterval = Number(body.autoRefreshInterval) || 0;
        }

        // Slug is intentionally immutable here: generated pages pin it at
        // creation so a rename cannot break a published URL.
        if (body.slug !== undefined && body.slug !== page.slug) {
            fail(res, 400, "bad_request", "Slug cannot be changed; create a new page instead.");
            return;
        }

        // Publishing needs the publish scope, checked explicitly because the
        // route is already behind `write`.
        if (body.published !== undefined && Boolean(body.published) !== !!page.published) {
            if (!req.apiScopes.includes("publish")) {
                fail(res, 403, "forbidden", "Publishing a status page requires the \"publish\" scope.");
                return;
            }
            page.published = Boolean(body.published);
        }

        page.modified_date = R.isoDateTime();
        await R.store(page);

        res.json({ ok: true, statusPage: await pageToJSON(page) });
    } catch (e) {
        log.error("api-v1", `PATCH /status-pages/:id failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Publish or unpublish a status page.
 */
router.post("/api/v1/status-pages/:id/publish", tokenAuth("publish"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }

        const published = req.body?.published ?? !page.published;
        page.published = Boolean(published);
        page.modified_date = R.isoDateTime();
        await R.store(page);

        // The host->slug map is cached in memory; refresh it or a newly
        // published custom domain keeps 404ing until restart.
        await StatusPage.loadDomainMappingList();

        log.info("api-v1", `${page.published ? "Published" : "Unpublished"} status page "${page.slug}"`);
        res.json({ ok: true, statusPage: await pageToJSON(page) });
    } catch (e) {
        log.error("api-v1", `POST /status-pages/:id/publish failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Delete a status page and its sections.
 */
router.delete("/api/v1/status-pages/:id", tokenAuth("publish"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }

        const slug = page.slug;

        // cascade handles status_page_cname; sections and incidents do not.
        await R.exec("DELETE FROM incident WHERE status_page_id = ? ", [ page.id ]);
        await R.exec("DELETE FROM monitor_group WHERE group_id IN (SELECT id FROM `group` WHERE status_page_id = ?) ", [ page.id ]);
        await R.exec("DELETE FROM `group` WHERE status_page_id = ? ", [ page.id ]);
        await R.exec("DELETE FROM status_page WHERE id = ? ", [ page.id ]);

        await StatusPage.loadDomainMappingList();

        log.info("api-v1", `Deleted status page "${slug}"`);
        res.json({ ok: true, deleted: page.id, slug });
    } catch (e) {
        log.error("api-v1", `DELETE /status-pages/:id failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Re-sync a generated page from its source group.
 */
router.post("/api/v1/status-pages/:id/regenerate", tokenAuth("write"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }

        if (!page.source_group_monitor_id) {
            fail(res, 400, "bad_request", "This page was not generated from a group monitor.");
            return;
        }

        const result = await generator.syncStatusPage(page.source_group_monitor_id);
        if (!result) {
            fail(res, 409, "conflict", "The source group no longer exists; the page has been unpublished.");
            return;
        }

        res.json({
            ok: true,
            statusPage: await pageToJSON(result.statusPage),
            changed: result.changed,
        });
    } catch (e) {
        log.error("api-v1", `POST /status-pages/:id/regenerate failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

// ---------------------------------------------------------------------------
// Domains (custom host routing)
// ---------------------------------------------------------------------------

/**
 * List custom domains for a page.
 */
router.get("/api/v1/status-pages/:id/domains", tokenAuth("read"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }
        res.json({ ok: true, domains: await page.getDomainNameList() });
    } catch (e) {
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Attach a custom domain. Requires `publish`: this is what makes the page
 * reachable at its own hostname.
 */
router.post("/api/v1/status-pages/:id/domains", tokenAuth("publish"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }

        const domain = String(req.body?.domain ?? "").trim().toLowerCase();
        if (!domain) {
            fail(res, 400, "bad_request", "`domain` is required.");
            return;
        }

        const existing = await page.getDomainNameList();
        if (existing.includes(domain)) {
            fail(res, 409, "conflict", "That domain is already attached to this page.");
            return;
        }

        const taken = await R.findOne("status_page_cname", " domain = ? ", [ domain ]);
        if (taken && taken.status_page_id !== page.id) {
            fail(res, 409, "conflict", "That domain is already mapped to another status page.");
            return;
        }

        await page.updateDomainNameList([ ...existing, domain ]);
        await StatusPage.loadDomainMappingList();

        log.info("api-v1", `Attached domain "${domain}" to "${page.slug}"`);
        res.status(201).json({ ok: true, domains: await page.getDomainNameList() });
    } catch (e) {
        log.error("api-v1", `POST /status-pages/:id/domains failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Detach a custom domain.
 */
router.delete("/api/v1/status-pages/:id/domains/:domain", tokenAuth("publish"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }

        const domain = String(req.params.domain).trim().toLowerCase();
        const remaining = (await page.getDomainNameList()).filter((d) => d !== domain);

        if (remaining.length === (await page.getDomainNameList()).length) {
            fail(res, 404, "not_found", "That domain is not attached to this page.");
            return;
        }

        await page.updateDomainNameList(remaining);
        await StatusPage.loadDomainMappingList();

        res.json({ ok: true, domains: await page.getDomainNameList() });
    } catch (e) {
        log.error("api-v1", `DELETE /status-pages/:id/domains failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

// ---------------------------------------------------------------------------
// Sections and monitor membership
// ---------------------------------------------------------------------------

/**
 * List sections on a page.
 */
router.get("/api/v1/status-pages/:id/groups", tokenAuth("read"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }

        const sections = await R.findAll("group", " status_page_id = ? ORDER BY weight, name ", [ page.id ]);
        const groups = [];
        for (const section of sections) {
            groups.push(await sectionToJSON(section));
        }

        res.json({ ok: true, count: groups.length, groups });
    } catch (e) {
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Create a section on a page.
 */
router.post("/api/v1/status-pages/:id/groups", tokenAuth("write"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }

        const name = String(req.body?.name ?? "").trim();
        if (!name) {
            fail(res, 400, "bad_request", "`name` is required.");
            return;
        }

        const section = R.dispense("group");
        section.statusPageId = page.id;
        section.name = name;
        section.public = req.body?.public ?? true;
        section.active = req.body?.active ?? true;
        section.weight = Number(req.body?.weight) || 1000;
        await R.store(section);

        res.status(201).json({ ok: true, group: await sectionToJSON(section) });
    } catch (e) {
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Update a section.
 */
router.patch("/api/v1/status-pages/:id/groups/:groupId", tokenAuth("write"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }

        const groupID = parseId(req.params.groupId);
        if (groupID === null) {
            fail(res, 400, "bad_request", "Group id must be a positive integer.");
            return;
        }

        const section = await R.findOne("group", " id = ? AND status_page_id = ? ", [ groupID, page.id ]);
        if (!section) {
            fail(res, 404, "not_found", `No section with id ${groupID} on this page.`);
            return;
        }

        const body = req.body ?? {};
        if (body.name !== undefined) {
            if (!String(body.name).trim()) {
                fail(res, 400, "bad_request", "`name` must be a non-empty string.");
                return;
            }
            section.name = String(body.name).trim();
        }
        if (body.public !== undefined) {
            section.public = Boolean(body.public);
        }
        if (body.active !== undefined) {
            section.active = Boolean(body.active);
        }
        if (body.weight !== undefined) {
            section.weight = Number(body.weight) || 1000;
        }

        await R.store(section);
        res.json({ ok: true, group: await sectionToJSON(section) });
    } catch (e) {
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Delete a section.
 */
router.delete("/api/v1/status-pages/:id/groups/:groupId", tokenAuth("write"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }

        const groupID = parseId(req.params.groupId);
        if (groupID === null) {
            fail(res, 400, "bad_request", "Group id must be a positive integer.");
            return;
        }

        const section = await R.findOne("group", " id = ? AND status_page_id = ? ", [ groupID, page.id ]);
        if (!section) {
            fail(res, 404, "not_found", `No section with id ${groupID} on this page.`);
            return;
        }

        await R.exec("DELETE FROM monitor_group WHERE group_id = ? ", [ section.id ]);
        await R.trash(section);

        res.json({ ok: true, deleted: groupID });
    } catch (e) {
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Set a section's monitor membership.
 *
 * Takes the full desired list and reconciles. Idempotent, so an agent can
 * retry safely. This is the rearrangement verb.
 */
router.put("/api/v1/status-pages/:id/groups/:groupId/monitors", tokenAuth("write"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }

        const groupID = parseId(req.params.groupId);
        if (groupID === null) {
            fail(res, 400, "bad_request", "Group id must be a positive integer.");
            return;
        }

        const section = await R.findOne("group", " id = ? AND status_page_id = ? ", [ groupID, page.id ]);
        if (!section) {
            fail(res, 404, "not_found", `No section with id ${groupID} on this page.`);
            return;
        }

        const requested = req.body?.monitors;
        if (!Array.isArray(requested)) {
            fail(res, 400, "bad_request", "`monitors` must be an array of monitor ids.");
            return;
        }

        const ids = [];
        for (const raw of requested) {
            const id = parseId(raw);
            if (id === null) {
                fail(res, 400, "bad_request", `Invalid monitor id "${raw}".`);
                return;
            }
            ids.push(id);
        }

        // Drop duplicates so a client sending the same id twice is not an error.
        const desired = [ ...new Set(ids) ];

        const changed = await generator.reconcileSectionMonitors(section.id, desired);

        log.info(
            "api-v1",
            `Set membership of section ${groupID} on "${page.slug}" (+${changed.added}/-${changed.removed})`
        );

        res.json({ ok: true, group: await sectionToJSON(section), changed });
    } catch (e) {
        log.error("api-v1", `PUT monitors failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

/**
 * Serialise an incident.
 * @param {Bean} i Incident bean
 * @returns {object} Safe representation
 */
function incidentToJSON(i) {
    return {
        id: i.id,
        statusPageId: i.status_page_id,
        title: i.title,
        content: i.content,
        style: i.style,
        active: !!i.active,
        pin: !!i.pin,
        createdDate: i.created_date,
        lastUpdatedDate: i.last_updated_date,
    };
}

/**
 * List incidents on a page.
 */
router.get("/api/v1/status-pages/:id/incidents", tokenAuth("read"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }

        const incidents = await R.getAll(
            "SELECT * FROM incident WHERE status_page_id = ? ORDER BY id DESC",
            [ page.id ]
        );

        res.json({
            ok: true,
            count: incidents.length,
            incidents: incidents.map(incidentToJSON),
        });
    } catch (e) {
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Post an incident to a page.
 */
router.post("/api/v1/status-pages/:id/incidents", tokenAuth("write"), async (req, res) => {
    try {
        const page = await loadPage(req, res, req.params.id);
        if (!page) {
            return;
        }

        const body = req.body ?? {};

        if (!body.title || !String(body.title).trim()) {
            fail(res, 400, "bad_request", "`title` is required.");
            return;
        }
        if (!body.content || !String(body.content).trim()) {
            fail(res, 400, "bad_request", "`content` is required.");
            return;
        }

        const incident = R.dispense("incident");
        incident.statusPageId = page.id;
        incident.title = String(body.title).trim();
        incident.content = String(body.content);
        incident.style = body.style ?? "warning";
        incident.pin = body.pin ?? true;
        incident.active = body.active ?? true;
        await R.store(incident);

        log.info("api-v1", `Posted incident "${incident.title}" on "${page.slug}"`);
        res.status(201).json({ ok: true, incident: incidentToJSON(incident) });
    } catch (e) {
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Edit an incident.
 */
router.patch("/api/v1/incidents/:id", tokenAuth("write"), async (req, res) => {
    try {
        const id = parseId(req.params.id);
        if (id === null) {
            fail(res, 400, "bad_request", "Incident id must be a positive integer.");
            return;
        }

        const incident = await R.findOne("incident", " id = ? ", [ id ]);
        if (!incident) {
            fail(res, 404, "not_found", `No incident with id ${id}.`);
            return;
        }

        const body = req.body ?? {};
        if (body.title !== undefined) {
            incident.title = String(body.title);
        }
        if (body.content !== undefined) {
            incident.content = String(body.content);
        }
        if (body.style !== undefined) {
            incident.style = String(body.style);
        }
        if (body.pin !== undefined) {
            incident.pin = Boolean(body.pin);
        }

        incident.last_updated_date = R.isoDateTime();
        await R.store(incident);

        res.json({ ok: true, incident: incidentToJSON(incident) });
    } catch (e) {
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Resolve an incident: mark it inactive and unpin it.
 */
router.post("/api/v1/incidents/:id/resolve", tokenAuth("write"), async (req, res) => {
    try {
        const id = parseId(req.params.id);
        if (id === null) {
            fail(res, 400, "bad_request", "Incident id must be a positive integer.");
            return;
        }

        const incident = await R.findOne("incident", " id = ? ", [ id ]);
        if (!incident) {
            fail(res, 404, "not_found", `No incident with id ${id}.`);
            return;
        }

        incident.active = false;
        incident.pin = false;
        incident.last_updated_date = R.isoDateTime();
        await R.store(incident);

        log.info("api-v1", `Resolved incident ${id}`);
        res.json({ ok: true, incident: incidentToJSON(incident) });
    } catch (e) {
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Delete an incident.
 */
router.delete("/api/v1/incidents/:id", tokenAuth("write"), async (req, res) => {
    try {
        const id = parseId(req.params.id);
        if (id === null) {
            fail(res, 400, "bad_request", "Incident id must be a positive integer.");
            return;
        }

        const incident = await R.findOne("incident", " id = ? ", [ id ]);
        if (!incident) {
            fail(res, 404, "not_found", `No incident with id ${id}.`);
            return;
        }

        await R.trash(incident);
        res.json({ ok: true, deleted: id });
    } catch (e) {
        fail(res, 500, "server_error", e.message);
    }
});

module.exports = router;
