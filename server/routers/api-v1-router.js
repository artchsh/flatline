/**
 * Flatline REST API v1.
 *
 * A token-authenticated CRUD surface intended for automation and LLM agents.
 * Everything the Vue frontend does over Socket.IO has an HTTP equivalent here.
 *
 * Auth: `Authorization: Bearer <token>` (HTTP Basic with the token as the
 * password also works). Tokens carry `read` and/or `write` scopes; a token
 * without `write` cannot mutate anything.
 *
 * Every query is scoped to the token's user, so an agent can only ever reach
 * its own monitors.
 */
const express = require("express");
const { R } = require("redbean-node");
const { log } = require("../../src/util");
const { tokenAuth } = require("../auth");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const { UptimeCalculator } = require("../uptime-calculator");
const Monitor = require("../model/monitor");
const monitorService = require("../monitor-service");
const openApiDocument = require("./openapi.json");
const { UP, DOWN, PENDING, MAINTENANCE, flipStatus } = require("../../src/util");

const server = UptimeKumaServer.getInstance();

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

/**
 * Columns an API caller may set on a monitor.
 *
 * Anything outside this set is ignored rather than written, so a mistyped
 * field cannot create a phantom column or clobber ownership (`user_id`) or
 * bookkeeping (`id`). Derived columns live on the `monitor` table but are
 * computed, so they are deliberately absent.
 */
const MONITOR_WRITABLE_FIELDS = new Set([
    // scheduling and identity
    "active",
    "name",
    "type",
    "description",
    "parent",
    "weight",
    "interval",
    "retryInterval",
    "resendInterval",
    "maxretries",
    "timeout",
    "maxredirects",
    "packetSize",
    "packetLoss",
    "subtype",
    "ipFamily",
    "pushToken",

    // target
    "url",
    "method",
    "body",
    "headers",
    "hostname",
    "port",
    "location",
    "protocol",
    "path",
    "keyword",
    "invertKeyword",
    "expectedValue",
    "jsonPath",
    "jsonPathOperator",
    "JSONPath",
    "httpBodyEncoding",
    "cacheBust",
    "domainExpiryNotification",
    "expiryNotification",
    "upsideDown",
    "invertUpsideDown",
    "resendNotification",

    // http / websocket
    "wsIgnoreSecWebsocketAcceptHeader",
    "wsSubprotocol",
    "ignoreSSL",
    "ignoreTls",
    "allowSelfSigned",
    "basic_auth_user",
    "basic_auth_pass",
    "bearer_token",
    "tlsCa",
    "tlsCert",
    "tlsKey",
    "oauth_client_id",
    "oauth_client_secret",
    "oauth_auth_method",
    "oauth_token_url",
    "oauth_scopes",
    "oauth_audience",
    "expectedTlsAlert",

    // response checks
    "save_response",
    "save_error_response",
    "response_max_length",
    "accepted_statuscodes",
    "accepted_statuscodes_json",

    // dns
    "dns_resolve_server",
    "dns_resolve_type",
    "proto",
    "dnssec",

    // dns / ping / tcp
    "ignoreTls",

    // docker
    "docker_host",
    "docker_container",
    "dockerDaemon",

    // mqtt
    "mqttUsername",
    "mqttPassword",
    "mqttTopic",
    "mqttSuccessMessage",
    "mqttCheckType",
    "mqttWebsocketPath",

    // sql / radius
    "databaseConnectionString",
    "databaseQuery",
    "authMethod",
    "authWorkstation",
    "authDomain",
    "radiusUsername",
    "radiusPassword",
    "radiusSecret",
    "radiusCalledStationId",
    "radiusCallingStationId",
    "radiusServer",
    "radiusPort",

    // grpc
    "grpcUrl",
    "grpcProtobuf",
    "grpcServiceName",
    "grpcMethod",
    "grpcBody",
    "grpcMetadata",
    "grpcEnableTls",

    // kafka
    "kafkaProducerTopic",
    "kafkaProducerBrokers",
    "kafkaProducerAllowAutoTopicCreation",
    "kafkaProducerSaslOptions",
    "kafkaProducerMessage",
    "kafkaProducerSsl",

    // rabbitmq
    "rabbitmqNodes",
    "rabbitmqUsername",
    "rabbitmqPassword",

    // smtp / snmp
    "smtpSecurity",
    "snmpVersion",
    "snmpOid",

    // gamedig / steam / redis / pm2 / system
    "game",
    "gamedigGivenPortOnly",
    "gamedigToken",
    "gamedigPort",
    "gamedigServerID",
    "maxBytes",
    "rspBufferSize",
    "steamCollect",
    "server",
    "system_service_name",
    "manual_status",

    // sftp / ssh
    "sshUsername",
    "sshPassword",
    "sshPrivateKey",
    "sshPassphrase",
    "sshAuthMethod",
    "sftpPath",
    "sftpPathType",

    // ntp
    "ntpServer",
    "ntp_stratum_threshold",
    "ntp_time_offset_threshold",
    "ntp_root_dispersion_threshold",

    // conditions
    "condition",
    "conditions",
    "retry_only_on_status_code_failure",

    // real browser
    "remote_browser",
    "screenshot_delay",
    "realBrowserService",
    "realBrowserScreenshot",
    "realBrowserRemoteBrowserID",

    // ping advanced
    "ping_numeric",
    "ping_count",
    "ping_per_request_timeout",
]);

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
 * Parse and validate a positive integer path/query parameter.
 * @param {any} raw Raw value from params or query
 * @returns {?number} Parsed integer, or null if invalid
 */
function parseId(raw) {
    if (!/^[0-9]+$/.test(String(raw))) {
        return null;
    }
    return Number(raw);
}

/**
 * Parse `?page=` / `?perPage=` into LIMIT/OFFSET.
 *
 * Pages are 1-based. perPage is always capped so a caller cannot ask the
 * server to materialise an entire table in one response.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response, used to report a bad value
 * @param {number} defaultPerPage Page size when not supplied
 * @param {number} maxPerPage Hard ceiling on page size
 * @returns {?{limit: number, offset: number, page: number, perPage: number}}
 * Pagination to apply, or null after responding with a 400
 */
function parsePagination(req, res, defaultPerPage = 50, maxPerPage = 200) {
    let page = 1;
    let perPage = defaultPerPage;

    if (req.query.page !== undefined) {
        if (!/^[0-9]+$/.test(String(req.query.page)) || Number(req.query.page) < 1) {
            fail(res, 400, "bad_request", "`page` must be an integer of 1 or greater.");
            return null;
        }
        page = Number(req.query.page);
    }

    if (req.query.perPage !== undefined) {
        if (!/^[0-9]+$/.test(String(req.query.perPage)) || Number(req.query.perPage) < 1) {
            fail(res, 400, "bad_request", "`perPage` must be an integer of 1 or greater.");
            return null;
        }
        perPage = Math.min(Number(req.query.perPage), maxPerPage);
    }

    return { limit: perPage, offset: (page - 1) * perPage, page, perPage };
}

/**
 * Build the standard pagination block for a response body.
 * @param {{page: number, perPage: number}} pagination Result of parsePagination
 * @param {number} total Total rows matching the query, across all pages
 * @returns {object} Pagination metadata
 */
function paginationMeta(pagination, total) {
    return {
        page: pagination.page,
        perPage: pagination.perPage,
        total,
        totalPages: pagination.perPage > 0 ? Math.ceil(total / pagination.perPage) : 0,
        hasMore: pagination.offset + pagination.perPage < total,
    };
}

/**
 * Load a monitor belonging to the authenticated user.
 *
 * The `user_id` check is what stops one token reading another's monitors.
 * @param {express.Request} req Express request, carries `apiUser`
 * @param {express.Response} res Express response
 * @param {string} idParam Raw monitor id
 * @returns {Promise<?Bean>} The monitor, or null after responding with an error
 */
async function loadMonitor(req, res, idParam) {
    const id = parseId(idParam);

    if (id === null) {
        fail(res, 400, "bad_request", "Monitor id must be a positive integer.");
        return null;
    }

    const monitor = await R.findOne("monitor", " id = ? AND user_id = ? ", [ id, req.apiUser ]);

    if (!monitor) {
        fail(res, 404, "not_found", `No monitor with id ${id}.`);
        return null;
    }

    return monitor;
}

/**
 * Shape a monitor for API output, including live status and uptime.
 *
 * Uses toPublicJSON so secrets (URLs with credentials, tokens) never leave
 * the server, and adds the operational fields an agent actually needs.
 * @param {Bean} monitor Monitor bean
 * @param {boolean} withUptime Include uptime/ping stats
 * @returns {Promise<object>} Serialised monitor
 */
async function monitorToJSON(monitor, withUptime = true) {
    const obj = await monitor.toPublicJSON(true, true);

    const heartbeat = await Monitor.getPreviousHeartbeat(monitor.id);
    obj.status = heartbeat ? heartbeat.status : PENDING;
    obj.ping = heartbeat ? heartbeat.ping : null;
    obj.lastCheck = heartbeat ? heartbeat.time : null;
    obj.lastMessage = heartbeat ? heartbeat.msg : null;
    obj.active = !!monitor.active;
    obj.url = monitor.url;
    obj.interval = monitor.interval;

    if (withUptime) {
        try {
            const calculator = await UptimeCalculator.getUptimeCalculator(monitor.id);
            obj.uptime24h = calculator.get24Hour().uptime;
            obj.uptime7d = calculator.get7Day().uptime;
            obj.uptime30d = calculator.get30Day().uptime;
        } catch (e) {
            // A monitor with no heartbeat history yet has nothing to average.
            log.debug("api-v1", `No uptime data for monitor ${monitor.id}: ${e.message}`);
            obj.uptime24h = null;
            obj.uptime7d = null;
            obj.uptime30d = null;
        }
    }

    return obj;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Machine-readable index so an agent can discover the API without docs.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {void}
 */
router.get("/api/v1", (req, res) => {
    res.json({
        ok: true,
        name: "Flatline API",
        version: "v1",
        documentation: "/api/v1/openapi.json",
        authentication: "Authorization: Bearer <token>",
        scopes: {
            read: "GET requests",
            write: "POST, PATCH, DELETE requests",
        },
        endpoints: {
            monitors: "/api/v1/monitors",
            heartbeat: "/api/v1/monitors/{id}/heartbeat",
            heartbeats: "/api/v1/monitors/{id}/heartbeats",
            incidents: "/api/v1/incidents",
            statusPages: "/api/v1/status-pages",
            maintenance: "/api/v1/maintenance",
            tags: "/api/v1/tags",
            notifications: "/api/v1/notifications",
            health: "/api/v1/health",
        },
    });
});

/**
 * Serve the OpenAPI description.
 *
 * The document lives in openapi.json so it can be linted, diffed and read
 * without parsing JS. Served unauthenticated on purpose: it contains no
 * secrets, and an agent should be able to read it before minting a token.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {void}
 */
router.get("/api/v1/openapi.json", (req, res) => {
    res.type("application/json").send(openApiDocument);
});

// ---------------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------------

/**
 * List monitors for the authenticated user.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/monitors", tokenAuth("read"), async (req, res) => {
    try {
        const pagination = parsePagination(req, res);
        if (!pagination) {
            return;
        }

        const where = [ "user_id = ?" ];
        const params = [ req.apiUser ];

        if (req.query.tag !== undefined) {
            const tagID = parseId(req.query.tag);
            if (tagID === null) {
                fail(res, 400, "bad_request", "tag must be a positive integer.");
                return;
            }
            where.push("id IN (SELECT monitor_id FROM monitor_tag WHERE tag_id = ?)");
            params.push(tagID);
        }

        if (req.query.active !== undefined) {
            if (req.query.active !== "true" && req.query.active !== "false") {
                fail(res, 400, "bad_request", "`active` must be true or false.");
                return;
            }
            where.push("active = ?");
            params.push(req.query.active === "true" ? 1 : 0);
        }

        if (req.query.q !== undefined) {
            where.push("(name LIKE ? OR url LIKE ?)");
            const like = `%${String(req.query.q).slice(0, 100)}%`;
            params.push(like, like);
        }

        const whereSQL = ` WHERE ${where.join(" AND ")}`;

        const { total } = await R.getRow(`SELECT COUNT(*) AS total FROM monitor${whereSQL}`, params);

        // LIMIT/OFFSET are already-validated integers. R.getAll does not bind
        // them portably and this project supports both SQLite and MariaDB.
        // R.getAll returns plain rows; toPublicJSON/toJSON live on the Monitor
        // model, so re-hydrate each row before serialising.
        const rows = await R.getAll(
            `SELECT id FROM monitor${whereSQL} ORDER BY id LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
            params
        );

        const result = [];
        for (const row of rows) {
            const monitor = await R.findOne("monitor", " id = ? AND user_id = ? ", [ row.id, req.apiUser ]);
            if (!monitor) {
                continue;
            }
            const obj = await monitorToJSON(monitor);

            // Status depends on the latest heartbeat, so it is filtered after
            // resolution rather than in SQL.
            if (req.query.status && obj.status !== req.query.status) {
                continue;
            }

            result.push(obj);
        }

        res.json({
            ok: true,
            count: result.length,
            monitors: result,
            pagination: paginationMeta(pagination, Number(total)),
        });
    } catch (e) {
        log.error("api-v1", `GET /monitors failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Create a monitor.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.post("/api/v1/monitors", tokenAuth("write"), async (req, res) => {
    try {
        const body = req.body ?? {};

        if (!body.name || typeof body.name !== "string") {
            fail(res, 400, "bad_request", "`name` is required.");
            return;
        }

        if (!body.type || typeof body.type !== "string") {
            fail(res, 400, "bad_request", "`type` is required. See GET /api/v1/monitor-types.");
            return;
        }

        // Reject unknown types up front rather than creating a broken monitor.
        // "http" and "https" are handled inside monitor.js itself and are not
        // registered in monitorTypeList, so they are valid but special.
        const isHttp = body.type === "http" || body.type === "https";

        if (!isHttp && !UptimeKumaServer.monitorTypeList[body.type]) {
            fail(res, 400, "bad_request", `Unknown monitor type "${body.type}". See GET /api/v1/monitor-types.`);
            return;
        }

        // Copy through only allowed columns, so an unknown key in the agent's
        // payload is ignored instead of becoming a phantom field. Ownership is
        // supplied by the service, never the body.
        const payload = {};
        const rejected = [];

        for (const [ key, value ] of Object.entries(body)) {
            if (key === "notificationIDList") {
                continue;
            }
            if (key === "name" || key === "type") {
                continue;
            }
            if (MONITOR_WRITABLE_FIELDS.has(key)) {
                payload[key] = value;
            } else {
                rejected.push(key);
            }
        }

        if (rejected.length > 0) {
            log.warn("api-v1", `POST /monitors ignored unknown fields: ${rejected.join(", ")}`);
        }

        const monitorBean = await monitorService.createMonitor(req.apiUser, {
            ...payload,
            name: body.name,
            type: body.type,
            active: body.active ?? true,
            interval: body.interval ?? 20,
            maxretries: body.maxretries ?? 0,
        }, {
            start: true,
            notificationIDList: body.notificationIDList ?? null,
        });

        // Push the change to any connected UI so it appears without a refresh.
        server.io.to(req.apiUser).emit("monitorList", await server.getMonitorJSONList(req.apiUser));

        res.status(201).json({
            ok: true,
            monitor: await monitorToJSON(monitorBean),
            ignoredFields: rejected,
        });
    } catch (e) {
        log.error("api-v1", `POST /monitors failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Get a single monitor.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/monitors/:id", tokenAuth("read"), async (req, res) => {
    try {
        const monitor = await loadMonitor(req, res, req.params.id);
        if (!monitor) {
            return;
        }
        res.json({ ok: true, monitor: await monitorToJSON(monitor) });
    } catch (e) {
        log.error("api-v1", `GET /monitors/:id failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Partially update a monitor.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.patch("/api/v1/monitors/:id", tokenAuth("write"), async (req, res) => {
    try {
        const monitor = await loadMonitor(req, res, req.params.id);
        if (!monitor) {
            return;
        }

        const body = req.body ?? {};

        if (body.name !== undefined) {
            if (typeof body.name !== "string" || body.name.trim().length === 0) {
                fail(res, 400, "bad_request", "`name` must be a non-empty string.");
                return;
            }
            monitor.name = body.name;
        }

        if (body.type !== undefined && body.type !== monitor.type) {
            fail(res, 400, "bad_request", "Monitor `type` cannot be changed after creation.");
            return;
        }

        const payload = {};
        const rejected = [];

        for (const [ key, value ] of Object.entries(body)) {
            if (key === "notificationIDList") {
                continue;
            }
            if (key === "type") {
                continue;
            }
            if (key === "name") {
                payload.name = value;
                continue;
            }
            if (MONITOR_WRITABLE_FIELDS.has(key)) {
                payload[key] = value;
            } else {
                rejected.push(key);
            }
        }

        // Only keys present in the payload are written, so a partial PATCH
        // leaves every other field untouched.
        const updated = await monitorService.updateMonitor(req.apiUser, monitor.id, payload, {
            notificationIDList: body.notificationIDList ?? null,
        });

        server.io.to(req.apiUser).emit("monitorList", await server.getMonitorJSONList(req.apiUser));

        res.json({
            ok: true,
            monitor: await monitorToJSON(updated),
            ignoredFields: rejected,
        });
    } catch (e) {
        log.error("api-v1", `PATCH /monitors/:id failed: ${e.message}`);
        // A rejected group topology is the caller's mistake, not a server fault.
        if (e.message === "Invalid Monitor Group") {
            fail(res, 400, "bad_request", e.message);
            return;
        }
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Delete a monitor.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.delete("/api/v1/monitors/:id", tokenAuth("write"), async (req, res) => {
    try {
        const monitor = await loadMonitor(req, res, req.params.id);
        if (!monitor) {
            return;
        }

        // Group semantics match the UI: ?deleteChildren=true removes descendants,
        // otherwise they are unlinked and kept.
        const deleteChildren = req.query.deleteChildren === "true";

        const deleted = await monitorService.deleteMonitor(req.apiUser, monitor.id, deleteChildren);

        for (const id of deleted) {
            server.io.to(req.apiUser).emit("deleteMonitorFromList", id);
        }

        res.json({ ok: true, deleted, count: deleted.length });
    } catch (e) {
        log.error("api-v1", `DELETE /monitors/:id failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Recent heartbeats for a monitor, newest first.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/monitors/:id/heartbeats", tokenAuth("read"), async (req, res) => {
    try {
        const monitor = await loadMonitor(req, res, req.params.id);
        if (!monitor) {
            return;
        }

        // Heartbeats are high-volume, so this endpoint keeps a simple `limit`
        // rather than full pagination, but still reports the true total.
        let limit = 100;
        if (req.query.limit !== undefined) {
            if (!/^[0-9]+$/.test(String(req.query.limit))) {
                fail(res, 400, "bad_request", "limit must be a positive integer.");
                return;
            }
            limit = Math.min(Number(req.query.limit), 1000);
        }

        const { total } = await R.getRow(
            "SELECT COUNT(*) AS total FROM heartbeat WHERE monitor_id = ?",
            [ monitor.id ]
        );

        const heartbeats = await R.getAll(
            `SELECT * FROM heartbeat WHERE monitor_id = ? ORDER BY id DESC LIMIT ${limit}`,
            [ monitor.id ]
        );

        res.json({
            ok: true,
            monitorId: monitor.id,
            count: heartbeats.length,
            heartbeats: heartbeats.map((h) => ({
                time: h.time,
                status: h.status,
                ping: h.ping,
                msg: h.msg,
                important: !!h.important,
            })),
            total: Number(total),
            limit,
        });
    } catch (e) {
        log.error("api-v1", `GET /heartbeats failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Report a heartbeat for a monitor (agent-driven check result).
 *
 * Mirrors /api/push but authenticated and user-scoped, so an agent can
 * report results for monitors it created without holding a push token.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.post("/api/v1/monitors/:id/heartbeat", tokenAuth("write"), async (req, res) => {
    try {
        const monitor = await loadMonitor(req, res, req.params.id);
        if (!monitor) {
            return;
        }

        const body = req.body ?? {};

        if (![ "up", "down", "pending", "maintenance" ].includes(body.status)) {
            fail(res, 400, "bad_request", "`status` must be one of: up, down, pending, maintenance.");
            return;
        }

        let ping = null;
        if (body.ping !== undefined && body.ping !== null) {
            ping = Number(body.ping);
            if (!Number.isFinite(ping) || ping < 0 || ping > 100000000000) {
                fail(res, 400, "bad_request", "`ping` must be a number between 0 and 100000000000 ms.");
                return;
            }
        }

        const previousHeartbeat = await Monitor.getPreviousHeartbeat(monitor.id);
        const isFirstBeat = !previousHeartbeat;

        let bean = R.dispense("heartbeat");
        bean.time = R.isoDateTimeMillis(new Date());
        bean.monitor_id = monitor.id;
        bean.ping = ping;
        bean.msg = body.msg ?? "";
        bean.downCount = previousHeartbeat?.downCount ?? 0;
        bean.retries = 0;

        if (previousHeartbeat) {
            bean.duration = Math.max(
                0,
                Math.round((new Date(bean.time).getTime() - new Date(previousHeartbeat.time).getTime()) / 1000)
            );
        }

        if (await Monitor.isUnderMaintenance(monitor.id)) {
            bean.status = MAINTENANCE;
        } else {
            let status = body.status === "up" ? UP : DOWN;
            if (monitor.isUpsideDown()) {
                status = flipStatus(status);
            }

            // Honour maxretries so a single flaky report does not flap the UI.
            if (status === DOWN && previousHeartbeat?.status === UP && monitor.maxretries > 0) {
                bean.retries = (previousHeartbeat.retries ?? 0) + 1;
                bean.status = bean.retries <= monitor.maxretries ? PENDING : DOWN;
            } else {
                bean.status = status;
            }
        }

        bean.important = Monitor.isImportantBeat(isFirstBeat, previousHeartbeat?.status, bean.status);

        const calculator = await UptimeCalculator.getUptimeCalculator(monitor.id);
        const endTime = await calculator.update(bean.status, ping);
        bean.end_time = R.isoDateTimeMillis(endTime);

        await R.store(bean);

        // Push to any connected UI, and fire notifications on state change.
        server.io.to(monitor.user_id).emit("heartbeat", bean.toJSON());
        Monitor.sendStats(server.io, monitor.id, monitor.user_id);

        if (Monitor.isImportantForNotification(isFirstBeat, previousHeartbeat?.status, bean.status)) {
            await Monitor.sendNotification(isFirstBeat, monitor, bean);
        }

        res.status(201).json({
            ok: true,
            monitorId: monitor.id,
            status: bean.status,
            heartbeat: {
                time: bean.time,
                status: bean.status,
                ping: bean.ping,
                msg: bean.msg,
            },
        });
    } catch (e) {
        log.error("api-v1", `POST /heartbeat failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Supported monitor types, so an agent knows what it may create.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/monitor-types", tokenAuth("read"), async (req, res) => {
    try {
        // http/https are handled by monitor.js directly rather than by a
        // MonitorType subclass, so they are advertised separately.
        const types = {
            http: { name: "HTTP", supportsConditions: true, allowCustomStatus: false },
            https: { name: "HTTPS", supportsConditions: true, allowCustomStatus: false },
        };

        for (const [ key, def ] of Object.entries(UptimeKumaServer.monitorTypeList)) {
            types[key] = {
                name: def.name ?? key,
                supportsConditions: !!def.supportsConditions,
                allowCustomStatus: !!def.allowCustomStatus,
            };
        }

        res.json({
            ok: true,
            count: Object.keys(types).length,
            types,
            writableFields: [ ...MONITOR_WRITABLE_FIELDS ],
        });
    } catch (e) {
        log.error("api-v1", `GET /monitor-types failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

/**
 * List incidents for the authenticated user.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/incidents", tokenAuth("read"), async (req, res) => {
    try {
        const pagination = parsePagination(req, res);
        if (!pagination) {
            return;
        }

        // Incidents belong to a status page and status pages are shared (no
        // user_id column), so this spans every page, matching what the UI sees.
        const where = [];
        const params = [];

        if (req.query.statusPageId !== undefined) {
            const statusPageID = parseId(req.query.statusPageId);
            if (statusPageID === null) {
                fail(res, 400, "bad_request", "statusPageId must be a positive integer.");
                return;
            }
            where.push("incident.status_page_id = ?");
            params.push(statusPageID);
        }

        if (req.query.active !== undefined) {
            if (req.query.active !== "true" && req.query.active !== "false") {
                fail(res, 400, "bad_request", "`active` must be true or false.");
                return;
            }
            where.push("incident.active = ?");
            params.push(req.query.active === "true" ? 1 : 0);
        }

        const whereSQL = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";

        const { total } = await R.getRow(`SELECT COUNT(*) AS total FROM incident${whereSQL}`, params);

        // LIMIT/OFFSET are already-validated integers; R.getAll does not bind
        // them portably and this project supports SQLite and MariaDB.
        const rows = await R.getAll(
            `SELECT incident.* FROM incident
             JOIN status_page ON incident.status_page_id = status_page.id${whereSQL}
             ORDER BY incident.id DESC
             LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
            params
        );

        res.json({
            ok: true,
            count: rows.length,
            incidents: rows.map((i) => ({
                id: i.id,
                statusPageId: i.status_page_id,
                title: i.title,
                content: i.content,
                style: i.style,
                active: !!i.active,
                pin: !!i.pin,
                createdDate: i.created_date,
                lastUpdatedDate: i.last_updated_date,
            })),
            pagination: paginationMeta(pagination, Number(total)),
        });
    } catch (e) {
        log.error("api-v1", `GET /incidents failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Post an incident to a status page.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.post("/api/v1/incidents", tokenAuth("write"), async (req, res) => {
    try {
        const body = req.body ?? {};

        if (body.statusPageId === undefined) {
            fail(res, 400, "bad_request", "`statusPageId` is required.");
            return;
        }

        const statusPageID = parseId(body.statusPageId);
        if (statusPageID === null) {
            fail(res, 400, "bad_request", "`statusPageId` must be a positive integer.");
            return;
        }

        if (!body.title || typeof body.title !== "string" || body.title.trim() === "") {
            fail(res, 400, "bad_request", "`title` is required.");
            return;
        }

        if (!body.content || typeof body.content !== "string" || body.content.trim() === "") {
            fail(res, 400, "bad_request", "`content` is required.");
            return;
        }

        // Status pages are shared across users (no user_id column), so this
        // only validates that the page exists.
        const statusPage = await R.findOne("status_page", " id = ? ", [ statusPageID ]);

        if (!statusPage) {
            fail(res, 404, "not_found", `No status page with id ${statusPageID}.`);
            return;
        }

        let bean = R.dispense("incident");
        bean.status_page_id = statusPageID;
        bean.title = body.title;
        bean.content = body.content;
        bean.style = body.style ?? "warning";
        bean.pin = body.pin ?? true;
        bean.active = true;
        await R.store(bean);

        // Let any connected client refresh its status page (incidents included).
        server.io.to(req.apiUser).emit("statusPage", await statusPage.toJSON());

        res.status(201).json({
            ok: true,
            incident: {
                id: bean.id,
                statusPageId: bean.status_page_id,
                title: bean.title,
                content: bean.content,
                style: bean.style,
                active: true,
                pin: !!bean.pin,
                createdDate: bean.created_date,
            },
        });
    } catch (e) {
        log.error("api-v1", `POST /incidents failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

// ---------------------------------------------------------------------------
// Read-only collections
// ---------------------------------------------------------------------------

/**
 * List status pages.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/status-pages", tokenAuth("read"), async (req, res) => {
    try {
        // status_page has no user_id column. Upstream treats the whole table as
        // shared (see StatusPage.sendStatusPageList, which returns every page),
        // so scoping to one user here would hide pages the UI still shows.
        const pages = await R.getAll("SELECT * FROM status_page ORDER BY title");

        const result = [];
        for (const page of pages) {
            result.push({
                id: page.id,
                slug: page.slug,
                title: page.title,
                description: page.description,
                published: !!page.published,
                theme: page.theme,
            });
        }

        res.json({ ok: true, count: result.length, statusPages: result });
    } catch (e) {
        log.error("api-v1", `GET /status-pages failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * List maintenance windows.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/maintenance", tokenAuth("read"), async (req, res) => {
    try {
        const windows = await R.getAll(
            "SELECT * FROM maintenance WHERE user_id = ? ORDER BY start_date DESC",
            [ req.apiUser ]
        );
        res.json({
            ok: true,
            count: windows.length,
            maintenance: windows.map((m) => ({
                id: m.id,
                title: m.title,
                description: m.description,
                startDate: m.start_date,
                endDate: m.end_date,
                active: m.active,
                status: m.status,
            })),
        });
    } catch (e) {
        log.error("api-v1", `GET /maintenance failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * List tags.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/tags", tokenAuth("read"), async (req, res) => {
    try {
        // The tag table has no user_id either: tags are global and reached from
        // a monitor via monitor_tag. Return only tags this user actually uses,
        // so the list still reflects their own monitors.
        const tags = await R.getAll(
            `SELECT DISTINCT tag.id, tag.name, tag.color FROM tag
             JOIN monitor_tag ON monitor_tag.tag_id = tag.id
             JOIN monitor ON monitor.id = monitor_tag.monitor_id
             WHERE monitor.user_id = ?
             ORDER BY tag.name`,
            [ req.apiUser ]
        );

        res.json({
            ok: true,
            count: tags.length,
            tags: tags.map((t) => ({
                id: t.id,
                name: t.name,
                color: t.color,
            })),
        });
    } catch (e) {
        log.error("api-v1", `GET /tags failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * List notification configs with secrets redacted.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/notifications", tokenAuth("read"), async (req, res) => {
    try {
        const notifications = await R.getAll("SELECT * FROM notification WHERE user_id = ? ORDER BY id", [ req.apiUser ]);

        res.json({
            ok: true,
            count: notifications.length,
            notifications: notifications.map((n) => {
                let config = {};
                try {
                    config = JSON.parse(n.config);
                } catch {
                    // A malformed row should not break the whole listing.
                    config = {};
                }

                // Never echo credentials back out.
                delete config.telegramBotToken;

                return {
                    id: n.id,
                    name: n.name,
                    type: n.type ?? config.type ?? null,
                    isDefault: !!n.is_default,
                    config,
                };
            }),
        });
    } catch (e) {
        log.error("api-v1", `GET /notifications failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

/**
 * Aggregate health across all monitors.
 * @param {express.Request} req Express request
 * @param {express.Response} res Express response
 * @returns {Promise<void>}
 */
router.get("/api/v1/health", tokenAuth("read"), async (req, res) => {
    try {
        const rows = await R.getAll("SELECT id, active FROM monitor WHERE user_id = ?", [ req.apiUser ]);

        const summary = { total: rows.length, up: 0, down: 0, pending: 0, maintenance: 0, paused: 0, downMonitors: [] };

        for (const row of rows) {
            if (!row.active) {
                summary.paused++;
                continue;
            }

            const heartbeat = await Monitor.getPreviousHeartbeat(row.id);

            if (!heartbeat) {
                summary.pending++;
                continue;
            }

            if (heartbeat.status === UP) {
                summary.up++;
            } else if (heartbeat.status === DOWN) {
                summary.down++;
                const monitor = await R.findOne("monitor", " id = ? ", [ row.id ]);
                if (monitor) {
                    summary.downMonitors.push({ id: monitor.id, name: monitor.name, url: monitor.url });
                }
            } else if (heartbeat.status === MAINTENANCE) {
                summary.maintenance++;
            } else {
                summary.pending++;
            }
        }

        // A single non-responding monitor makes the whole instance unhealthy.
        summary.status = summary.down > 0 ? "down" : "up";

        res.json({ ok: true, health: summary });
    } catch (e) {
        log.error("api-v1", `GET /health failed: ${e.message}`);
        fail(res, 500, "server_error", e.message);
    }
});

module.exports = router;