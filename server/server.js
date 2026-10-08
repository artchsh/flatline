/*
 * Flatline server
 * node "server/server.js"
 * DO NOT require("./server") in other modules, it likely creates circular dependency!
 */
import { getRandomInt, isDev, log, sleep } from "../src/util";
import { auth, doubleCheckPassword, getDisableAuthSession, getSession } from "./better-auth";
import { createBetterAuthRouter, needSetup } from "./routers/better-auth-router";
import { betterAuthSocketHandler } from "./socket-handlers/better-auth-socket-handler";
import { loadEnvFile } from "node:process";
import * as fs from "node:fs";

console.log("Welcome to Flatline");

// As the log function need to use dayjs, it should be very top
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("./modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

// Load environment variables from `.env`
try {
    loadEnvFile();
} catch (_) {}

// Check Node.js Version
const nodeVersion = process.versions.node;

// Get the required Node.js version from package.json
const requiredNodeVersions = require("../package.json").engines.node;
const bannedNodeVersions = "< 24";
console.log(`Your Node.js version: ${nodeVersion}`);

const semver = require("semver");
const requiredNodeVersionsComma = requiredNodeVersions
    .split("||")
    .map((version) => version.trim())
    .join(", ");

// Exit Flatline immediately if the Node.js version is banned
if (semver.satisfies(nodeVersion, bannedNodeVersions)) {
    console.error(
        "\x1b[31m%s\x1b[0m",
        `Error: Your Node.js version: ${nodeVersion} is not supported, please upgrade your Node.js to ${requiredNodeVersionsComma}.`
    );
    process.exit(-1);
}

// Warning if the Node.js version is not in the support list, but it maybe still works
if (!semver.satisfies(nodeVersion, requiredNodeVersions)) {
    console.warn(
        "\x1b[31m%s\x1b[0m",
        `Warning: Your Node.js version: ${nodeVersion} is not officially supported, please upgrade your Node.js to ${requiredNodeVersionsComma}.`
    );
}

const args = require("args-parser")(process.argv);
const config = require("./config");

process.title = "flatline";

log.debug("server", "Arguments");
log.debug("server", args);

if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = "production";
}

if (!process.env.UPTIME_KUMA_WS_ORIGIN_CHECK) {
    process.env.UPTIME_KUMA_WS_ORIGIN_CHECK = "cors-like";
}

log.info("server", "Env: " + process.env.NODE_ENV);
log.debug("server", "Inside Container: " + (process.env.UPTIME_KUMA_IS_CONTAINER === "1"));

if (process.env.UPTIME_KUMA_WS_ORIGIN_CHECK === "bypass") {
    log.warn("server", "WebSocket Origin Check: " + process.env.UPTIME_KUMA_WS_ORIGIN_CHECK);
}

if (isDev || process.env.UPTIME_KUMA_DEBUG_INSPECTOR === "1") {
    const inspector = require("inspector");
    let inspectorHost = "127.0.0.1";

    log.warn("server", "Node.js Inspector is enabled. You can connect to it via Chrome DevTools or VSCode.");
    log.warn("server", "Node.js Inspector is listening on:", inspector.url());

    if (process.env.UPTIME_KUMA_IS_CONTAINER === "1") {
        log.warn(
            "server",
            "You need to expose the port 9229:9229 in your docker command or docker compose, and ssh tunneling in order to connect to it."
        );
        inspectorHost = "0.0.0.0";
    }

    inspector.open(9229, inspectorHost);
}

const checkVersion = require("./check-version");
log.info("server", "Flatline version:", checkVersion.version);

log.info("server", "Loading modules");

log.debug("server", "Importing express");
const express = require("express");
log.debug("server", "Importing redbean-node");
const { R } = require("redbean-node");
log.debug("server", "Importing http-graceful-shutdown");
const gracefulShutdown = require("http-graceful-shutdown");
log.debug("server", "Importing prometheus-api-metrics");
const prometheusAPIMetrics = require("prometheus-api-metrics");

const { UptimeKumaServer } = require("./uptime-kuma-server");
const server = UptimeKumaServer.getInstance();
const io = (module.exports.io = server.io);
const app = server.app;

log.debug("server", "Importing Monitor");
const Monitor = require("./model/monitor");

log.debug("server", "Importing Settings");
const {
    getSettings,
    setSettings,
    setting,
    checkLogin,
    allowDevAllOrigin,
    printServerUrls,
    allowDevOrigin,
} = require("./util-server");

log.debug("server", "Importing Notification");
const { Notification } = require("./notification");
Notification.init();

const { SHARED_ROOM } = require("./shared-room");
const monitorService = require("./monitor-service");

log.debug("server", "Importing Database");
const Database = require("./database");

log.debug("server", "Importing Background Jobs");
const { initBackgroundJobs, stopBackgroundJobs } = require("./jobs");
const { apiAuth } = require("./auth");
const { Prometheus } = require("./prometheus");
const { UptimeCalculator } = require("./uptime-calculator");

const hostname = config.hostname;

if (hostname) {
    log.info("server", "Custom hostname: " + hostname);
}

const port = config.port;

const disableFrameSameOrigin =
    !!process.env.UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN || args["disable-frame-sameorigin"] || false;
const cloudflaredToken = args["cloudflared-token"] || process.env.UPTIME_KUMA_CLOUDFLARED_TOKEN || undefined;

/**
 * Run unit test after the server is ready
 * @type {boolean}
 */
const testMode = !!args["test"] || false;

// Must be after io instantiation
const {
    sendNotificationList,
    sendHeartbeatList,
    sendInfo,
    sendProxyList,
    sendDockerHostList,
    sendAPIKeyList,
    sendRemoteBrowserList,
    sendMonitorTypeList,
} = require("./client");
const { statusPageSocketHandler } = require("./socket-handlers/status-page-socket-handler");
const { databaseSocketHandler } = require("./socket-handlers/database-socket-handler");
const { remoteBrowserSocketHandler } = require("./socket-handlers/remote-browser-socket-handler");
const StatusPage = require("./model/status_page");
const {
    cloudflaredSocketHandler,
    autoStart: cloudflaredAutoStart,
    stop: cloudflaredStop,
} = require("./socket-handlers/cloudflared-socket-handler");
const { proxySocketHandler } = require("./socket-handlers/proxy-socket-handler");
const { dockerSocketHandler } = require("./socket-handlers/docker-socket-handler");
const { maintenanceSocketHandler } = require("./socket-handlers/maintenance-socket-handler");
const { apiKeySocketHandler } = require("./socket-handlers/api-key-socket-handler");
const { userInviteSocketHandler, startInvitePruner } = require("./socket-handlers/user-invite-socket-handler");
const { userSocketHandler } = require("./socket-handlers/user-socket-handler");
const { generalSocketHandler } = require("./socket-handlers/general-socket-handler");
const { Settings } = require("./settings");
const apicache = require("./modules/apicache");
const { resetChrome } = require("./monitor-types/real-browser-monitor-type");
const { EmbeddedMariaDB } = require("./embedded-mariadb");
const { SetupDatabase } = require("./setup-database");
const { chartSocketHandler } = require("./socket-handlers/chart-socket-handler");

app.use(express.json());

// Global Middleware
app.use(function (req, res, next) {
    if (!disableFrameSameOrigin) {
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
    }
    res.removeHeader("X-Powered-By");
    next();
});

(async () => {
    // Create a data directory
    Database.initDataDir(args);

    // Check if is chosen a database type
    let setupDatabase = new SetupDatabase(args, server);
    if (setupDatabase.isNeedSetup()) {
        // Hold here and start a special setup page until user choose a database type
        await setupDatabase.start(hostname, port);
    }

    // Connect to database
    try {
        await initDatabase(testMode);
    } catch (e) {
        log.error("server", "Failed to prepare your database: " + e.message);
        process.exit(1);
    }

    // Init Better Auth
    auth();

    // Database should be ready now
    await server.initAfterDatabaseReady();
    server.entryPage = await Settings.get("entryPage");
    await StatusPage.loadDomainMappingList();

    log.debug("server", "Initializing Prometheus");
    await Prometheus.init();

    log.debug("server", "Adding route");

    // ***************************
    // Normal Router here
    // ***************************

    // Entry Page
    // The backend is API-only and never serves HTML. Custom domains and
    // status pages are served by the Next.js status-site app, which resolves
    // hosts through /api/status-page/resolve-host; the operator dashboard is
    // a separate Vite app. This index exists so a browser pointed at the API
    // gets a pointer, not a redirect into an app that lives elsewhere.
    app.get("/", async (request, response) => {
        response.json({
            ok: true,
            name: "Flatline API",
            version: "v1",
            documentation: "/api/v1/openapi.json",
            dashboard: "Run the dashboard app (apps/dashboard) against this origin.",
            statusSite: "Run the status-site app (apps/status-site) against this origin.",
        });
    });

    app.get("/setup-database-info", (request, response) => {
        allowDevAllOrigin(response);
        response.json({
            runningSetup: false,
            needSetup: false,
        });
    });

    if (isDev) {
        app.options("/*", async (request, response) => {
            allowDevOrigin(request, response);
            response.end();
        });

        app.use(express.urlencoded({ extended: true }));
        app.post("/test-webhook", async (request, response) => {
            log.debug("test", request.headers);
            log.debug("test", request.body);
            response.send("OK");
        });

        app.get("/_e2e/take-sqlite-snapshot", async (request, response) => {
            // Checkpoint WAL to flush all data to the main .db file, then copy.
            // No close/reopen needed — the file is consistent after checkpoint.
            await R.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            fs.cpSync(Database.sqlitePath, `${Database.sqlitePath}.e2e-snapshot`);
            response.send("Snapshot taken.");
        });

        app.get("/_e2e/restore-sqlite-snapshot", async (request, response) => {
            if (!fs.existsSync(`${Database.sqlitePath}.e2e-snapshot`)) {
                throw new Error("Snapshot doesn't exist.");
            }

            await Database.close();
            try {
                fs.cpSync(`${Database.sqlitePath}.e2e-snapshot`, Database.sqlitePath);
            } catch (err) {
                throw new Error("Unable to copy snapshot file.");
            }
            await Database.connect();

            response.send("Snapshot restored.");
        });

        app.post("/test-x-www-form-urlencoded", async (request, response) => {
            log.debug("test", request.headers);
            log.debug("test", request.body);
            response.send("OK");
        });
    }

    // Robots.txt — API-only: nothing here is crawlable.
    app.get("/robots.txt", async (_request, response) => {
        response.setHeader("Content-Type", "text/plain");
        response.send("User-agent: *\nDisallow: /");
    });

    // Basic Auth Router here

    // Prometheus API metrics  /metrics
    // With Basic Auth using the first user's username/password
    app.get("/metrics", apiAuth, prometheusAPIMetrics());

    // ./data/upload
    app.use("/upload", express.static(Database.uploadDir));

    app.get("/.well-known/change-password", async (_, response) => {
        response.redirect("https://github.com/artchsh/flatline/wiki/Reset-Password-via-CLI");
    });

    // API Router
    const apiRouter = require("./routers/api-router");
    app.use(apiRouter);

    // REST API v1 (token auth, for automation and agents).
    // Mounted after apiRouter but before the SPA catch-all below.
    const apiV1Router = require("./routers/api-v1-router");
    app.use(apiV1Router);

    // Status pages, groups, incidents and domains. Separate file for
    // readability; it must be mounted before the SPA catch-all too.
    const apiV1StatusRouter = require("./routers/api-v1-status-router");
    app.use(apiV1StatusRouter);

    // Status Page Router
    const statusPageRouter = require("./routers/status-page-router");
    app.use(statusPageRouter);

    // Auth REST: password login, setup status, invites and account
    // administration. The dashboard's only credential flow; no sessions.
    const authRouter = require("./routers/auth-router");
    app.use(authRouter);

    // better auth API Router
    const betterAuthRouter = await createBetterAuthRouter();
    app.use(betterAuthRouter);

    // Catch-all, must be at the end of all express routes. The backend
    // serves no HTML, so anything that is not an API route is a JSON 404 —
    // never the old SPA shell.
    app.use(async (request, response) => {
        if (request.originalUrl.startsWith("/upload/")) {
            response.status(404).json({ ok: false, error: "not_found", message: "File not found." });
        } else {
            response.status(404).json({
                ok: false,
                error: "not_found",
                message: `No route for ${request.method} ${request.path}. See GET /api/v1.`,
            });
        }
    });

    log.debug("server", "Adding socket handler");
    io.on("connection", async (socket) => {
        await sendInfo(socket, true);

        if (await needSetup()) {
            log.info("server", "Redirect to setup page");
            socket.emit("setup");
        }

        let session;

        if (!(await Settings.get("disableAuth"))) {
            session = await getSession(socket.request.headers.cookie);
        } else {
            session = await getDisableAuthSession();
        }

        if (session) {
            socket.userID = session.user.id;
            socket.session = session;
            socket.emit("session", session.user.username);
            log.debug("auth", `Session active:`, session.session.ipAddress, session.user.username);
        }

        // ***************************
        // Auth Only API
        // ***************************

        // Add a new monitor
        socket.on("add", async (monitor, callback) => {
            try {
                checkLogin(socket);

                let notificationIDList = monitor.notificationIDList;
                delete monitor.notificationIDList;

                let bean = await monitorService.createMonitor(socket.userID, monitor, {
                    start: monitor.active !== false,
                    notificationIDList,
                });

                await server.sendUpdateMonitorIntoList(socket, bean.id);

                callback({
                    ok: true,
                    msg: "successAdded",
                    msgi18n: true,
                    monitorID: bean.id,
                });
            } catch (e) {
                log.error("monitor", `Error adding Monitor: ${monitor.id} User ID: ${socket.userID}`);

                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        // Edit a monitor
        socket.on("editMonitor", async (monitor, callback) => {
            try {
                checkLogin(socket);

                let notificationIDList = monitor.notificationIDList;
                delete monitor.notificationIDList;

                const bean = await monitorService.updateMonitor(monitor.id, monitor, {
                    notificationIDList,
                });

                await server.sendUpdateMonitorIntoList(socket, bean.id);

                callback({
                    ok: true,
                    msg: "Saved.",
                    msgi18n: true,
                    monitorID: bean.id,
                });
            } catch (e) {
                log.error("monitor", e);
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("getMonitorList", async (callback) => {
            try {
                checkLogin(socket);
                await server.sendMonitorList(socket);
                callback({
                    ok: true,
                });
            } catch (e) {
                log.error("monitor", e);
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("getMonitor", async (monitorID, callback) => {
            try {
                checkLogin(socket);

                log.info("monitor", `Get Monitor: ${monitorID} User ID: ${socket.userID}`);

                // Shared instance: any logged-in user may open any monitor.
                let monitor = await R.findOne("monitor", " id = ? ", [monitorID]);
                const monitorData = [{ id: monitor.id, active: monitor.active }];
                const preloadData = await Monitor.preparePreloadData(monitorData);
                callback({
                    ok: true,
                    monitor: monitor.toJSON(preloadData),
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        // partial { type, url, hostname, grpcUrl }
        socket.on("checkDomain", async (partial, callback) => {
            try {
                checkLogin(socket);
                const DomainExpiry = require("./model/domain_expiry");
                const supportInfo = await DomainExpiry.checkSupport(partial);
                callback({
                    ok: true,
                    domain: supportInfo.domain,
                    tld: supportInfo.tld,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                    msgi18n: !!e.msgi18n,
                    meta: e.meta ?? {},
                });
            }
        });

        socket.on("getMonitorBeats", async (monitorID, period, callback) => {
            try {
                checkLogin(socket);

                log.info("monitor", `Get Monitor Beats: ${monitorID} User ID: ${socket.userID}`);

                if (period == null) {
                    throw new Error("Invalid period.");
                }

                const sqlHourOffset = Database.sqlHourOffset();

                let list = await R.getAll(
                    `
                    SELECT *
                    FROM heartbeat
                    WHERE monitor_id = ?
                      AND time > ${sqlHourOffset}
                    ORDER BY time ASC
                `,
                    [monitorID, -period]
                );

                callback({
                    ok: true,
                    data: list,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        // Start or Resume the monitor
        socket.on("resumeMonitor", async (monitorID, callback) => {
            try {
                checkLogin(socket);
                await monitorService.startMonitor(monitorID);
                await server.sendUpdateMonitorIntoList(socket, monitorID);

                callback({
                    ok: true,
                    msg: "successResumed",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("pauseMonitor", async (monitorID, callback) => {
            try {
                checkLogin(socket);
                await monitorService.pauseMonitor(monitorID);
                await server.sendUpdateMonitorIntoList(socket, monitorID);

                callback({
                    ok: true,
                    msg: "successPaused",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("deleteMonitor", async (monitorID, deleteChildren, callback) => {
            try {
                // Backward compatibility: if deleteChildren is omitted, the second parameter is the callback
                if (typeof deleteChildren === "function") {
                    callback = deleteChildren;
                    deleteChildren = false;
                }

                checkLogin(socket);

                const startTime = Date.now();

                const deleted = await monitorService.deleteMonitor(monitorID, deleteChildren);

                // Fix #2880
                apicache.clear();

                const endTime = Date.now();
                log.info("DB", `Delete Monitor completed in: ${endTime - startTime} ms`);

                callback({
                    ok: true,
                    msg: "successDeleted",
                    msgi18n: true,
                });

                // Remove the deleted ids from any connected client's list, and
                // refresh children that were unlinked rather than deleted.
                for (const id of deleted) {
                    await server.sendDeleteMonitorFromList(socket, id);
                }

                if (!deleteChildren) {
                    const monitor = await R.findOne("monitor", " id = ? ", [ monitorID ]);
                    if (!monitor || monitor.type !== "group") {
                        const children = await Monitor.getChildren(monitorID);
                        for (const child of children ?? []) {
                            await server.sendUpdateMonitorIntoList(socket, child.id);
                        }
                    }
                }
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("getTags", async (callback) => {
            try {
                checkLogin(socket);

                const list = await R.findAll("tag");

                callback({
                    ok: true,
                    tags: list.map((bean) => bean.toJSON()),
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("addTag", async (tag, callback) => {
            try {
                checkLogin(socket);

                let bean = R.dispense("tag");
                bean.name = tag.name;
                bean.color = tag.color;
                await R.store(bean);

                callback({
                    ok: true,
                    tag: await bean.toJSON(),
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("editTag", async (tag, callback) => {
            try {
                checkLogin(socket);

                let bean = await R.findOne("tag", " id = ? ", [tag.id]);
                if (bean == null) {
                    callback({
                        ok: false,
                        msg: "tagNotFound",
                        msgi18n: true,
                    });
                    return;
                }


                bean.name = tag.name;
                bean.color = tag.color;
                await R.store(bean);

                callback({
                    ok: true,
                    msg: "Saved.",
                    msgi18n: true,
                    tag: await bean.toJSON(),
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("deleteTag", async (tagID, callback) => {
            try {
                checkLogin(socket);


                await R.exec("DELETE FROM tag WHERE id = ? ", [ tagID ]);

                callback({
                    ok: true,
                    msg: "successDeleted",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("addMonitorTag", async (tagID, monitorID, value, callback) => {
            try {
                checkLogin(socket);


                await R.exec("INSERT INTO monitor_tag (tag_id, monitor_id, value) VALUES (?, ?, ?)", [
                    tagID,
                    monitorID,
                    value,
                ]);

                await server.sendUpdateMonitorIntoList(socket, monitorID);

                callback({
                    ok: true,
                    msg: "successAdded",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("editMonitorTag", async (tagID, monitorID, value, callback) => {
            try {
                checkLogin(socket);


                await R.exec("UPDATE monitor_tag SET value = ? WHERE tag_id = ? AND monitor_id = ?", [
                    value,
                    tagID,
                    monitorID,
                ]);

                await server.sendUpdateMonitorIntoList(socket, monitorID);

                callback({
                    ok: true,
                    msg: "successEdited",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("deleteMonitorTag", async (tagID, monitorID, value, callback) => {
            try {
                checkLogin(socket);


                await R.exec("DELETE FROM monitor_tag WHERE tag_id = ? AND monitor_id = ? AND value = ?", [
                    tagID,
                    monitorID,
                    value,
                ]);

                await server.sendUpdateMonitorIntoList(socket, monitorID);

                callback({
                    ok: true,
                    msg: "successDeleted",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("monitorImportantHeartbeatListCount", async (monitorID, callback) => {
            try {
                checkLogin(socket);

                let count;
                if (monitorID == null) {
                    count = await R.count("heartbeat", "important = 1");
                } else {
                    count = await R.count("heartbeat", "monitor_id = ? AND important = 1", [monitorID]);
                }

                callback({
                    ok: true,
                    count: count,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("monitorImportantHeartbeatListPaged", async (monitorID, offset, count, callback) => {
            try {
                checkLogin(socket);

                let list;
                if (monitorID == null) {
                    list = await R.find(
                        "heartbeat",
                        `
                        important = 1
                        ORDER BY time DESC
                        LIMIT ?
                        OFFSET ?
                    `,
                        [count, offset]
                    );
                } else {
                    list = await R.find(
                        "heartbeat",
                        `
                        monitor_id = ?
                        AND important = 1
                        ORDER BY time DESC
                        LIMIT ?
                        OFFSET ?
                    `,
                        [monitorID, count, offset]
                    );
                }

                callback({
                    ok: true,
                    data: list,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("getSettings", async (callback) => {
            try {
                checkLogin(socket);
                const data = await getSettings("general");

                if (!data.serverTimezone) {
                    data.serverTimezone = await server.getTimezone();
                }

                callback({
                    ok: true,
                    data: data,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("setSettings", async (data, currentPassword, callback) => {
            try {
                checkLogin(socket);

                // If currently is disabled auth, don't need to check
                // Disabled Auth + Want to Disable Auth => No Check
                // Disabled Auth + Want to Enable Auth => No Check
                // Enabled Auth + Want to Disable Auth => Check!!
                // Enabled Auth + Want to Enable Auth => No Check
                const currentDisabledAuth = await setting("disableAuth");
                if (!currentDisabledAuth && data.disableAuth) {
                    await doubleCheckPassword(socket.request.headers.cookie, currentPassword);
                }

                // Log out all clients if enabling auth
                // GHSA-23q2-5gf8-gjpp
                if (currentDisabledAuth && !data.disableAuth) {
                    server.disconnectAllSocketClients(socket.userID, socket.id);
                }

                const previousChromeExecutable = await Settings.get("chromeExecutable");
                const previousNSCDStatus = await Settings.get("nscd");

                await setSettings("general", data);
                server.entryPage = data.entryPage;

                // Also need to apply timezone globally
                if (data.serverTimezone) {
                    await server.setTimezone(data.serverTimezone);
                }

                // If Chrome Executable is changed, need to reset the browser
                if (previousChromeExecutable !== data.chromeExecutable) {
                    log.info("settings", "Chrome executable is changed. Resetting Chrome...");
                    await resetChrome();
                }

                // Update nscd status
                if (previousNSCDStatus !== data.nscd) {
                    if (data.nscd) {
                        await server.startNSCDServices();
                    } else {
                        await server.stopNSCDServices();
                    }
                }

                callback({
                    ok: true,
                    msg: "Saved.",
                    msgi18n: true,
                });

                await sendInfo(socket);
                await server.sendMaintenanceList(socket);
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        // Add or Edit
        socket.on("addNotification", async (notification, notificationID, callback) => {
            try {
                checkLogin(socket);

                let notificationBean = await Notification.save(notification, notificationID, socket.userID);
                await sendNotificationList(socket);

                callback({
                    ok: true,
                    msg: "Saved.",
                    msgi18n: true,
                    id: notificationBean.id,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("deleteNotification", async (notificationID, callback) => {
            try {
                checkLogin(socket);

                await Notification.delete(notificationID, socket.userID);
                await sendNotificationList(socket);

                callback({
                    ok: true,
                    msg: "successDeleted",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("testNotification", async (notification, callback) => {
            try {
                checkLogin(socket);

                let msg = await Notification.send(notification, notification.name + " Testing");

                callback({
                    ok: true,
                    msg,
                });
            } catch (e) {
                log.error("server", e);

                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("clearEvents", async (monitorID, callback) => {
            try {
                checkLogin(socket);

                log.info("manage", `Clear Events Monitor: ${monitorID} User ID: ${socket.userID}`);


                await R.exec("UPDATE heartbeat SET msg = ?, important = ? WHERE monitor_id = ? ", ["", "0", monitorID]);

                callback({
                    ok: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("clearHeartbeats", async (monitorID, callback) => {
            try {
                checkLogin(socket);

                log.info("manage", `Clear Heartbeats Monitor: ${monitorID} User ID: ${socket.userID}`);


                await UptimeCalculator.clearStatistics(monitorID);

                if (monitorID in server.monitorList) {
                    const monitor = server.monitorList[monitorID];
                    if (monitor.active) {
                        await monitorService.restartMonitor(monitorID);
                    }
                }

                await sendHeartbeatList(socket, monitorID, true, true);

                callback({
                    ok: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("clearStatistics", async (callback) => {
            try {
                checkLogin(socket);

                log.info("manage", `Clear Statistics User ID: ${socket.userID}`);

                // Shared instance: statistics are global, so this clears every
                // monitor and restarts all of them.
                await UptimeCalculator.clearStatisticsForUser();

                for (let monitorID in server.monitorList) {
                    const monitor = server.monitorList[monitorID];
                    if (monitor.active) {
                        await monitorService.restartMonitor(monitorID);
                    }
                }

                callback({
                    ok: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        betterAuthSocketHandler(socket);

        // Status Page Socket Handler for admin only
        statusPageSocketHandler(socket);
        cloudflaredSocketHandler(socket);
        databaseSocketHandler(socket);
        proxySocketHandler(socket);
        dockerSocketHandler(socket);
        maintenanceSocketHandler(socket);
        apiKeySocketHandler(socket);
        userInviteSocketHandler(socket);
        userSocketHandler(socket);
        remoteBrowserSocketHandler(socket);
        generalSocketHandler(socket, server);
        chartSocketHandler(socket);

        log.debug("server", "added all socket handlers");

        // ***************************
        // Better do anything after added all socket handlers here
        // ***************************

        if (session) {
            await afterLogin(socket, session.user);
        } else {
            socket.emit("loginRequired");
            log.debug("auth", "need auth");
        }
    });

    log.debug("server", "Init the server");

    server.httpServer.once("error", async (err) => {
        log.error("server", "Cannot listen: " + err.message);
        await shutdownFunction();
        process.exit(1);
    });

    await server.start();

    server.httpServer.listen(port, hostname, async () => {
        printServerUrls("server", port, hostname, config.isSSL);

        await startMonitors();

        // Housekeeping for expired invite links.
        startInvitePruner();

        // Put this here. Start background jobs after the db and server is ready to prevent clear up during db migration.
        await initBackgroundJobs();

        checkVersion.startInterval();
    });

    // Start cloudflared at the end if configured
    await cloudflaredAutoStart(cloudflaredToken);
})();


/**
 * Function called after user login
 * This function is used to send the heartbeat list of a monitor.
 * @param {Socket} socket Socket.io instance
 * @param {object} user User object
 * @returns {Promise<void>}
 */
async function afterLogin(socket, user) {
    socket.userID = user.id;
    socket.join(user.id);

    // Shared instance: monitors, notifications, maintenance, proxies and
    // containers are visible to every user, so live updates go to a common
    // room. API keys and invites stay in the per-user room above.
    socket.join(SHARED_ROOM);

    let monitorList = await server.sendMonitorList(socket);
    await Promise.allSettled([
        sendInfo(socket),
        server.sendMaintenanceList(socket),
        sendNotificationList(socket),
        sendProxyList(socket),
        sendDockerHostList(socket),
        sendAPIKeyList(socket),
        sendRemoteBrowserList(socket),
        sendMonitorTypeList(socket),
    ]);

    await StatusPage.sendStatusPageList(io, socket);

    const monitorPromises = [];
    for (let monitorID in monitorList) {
        monitorPromises.push(sendHeartbeatList(socket, monitorID));
        monitorPromises.push(Monitor.sendStats(io, monitorID, user.id));
    }

    await Promise.all(monitorPromises);

    // Set server timezone from client browser if not set
    // It should be run once only
    if (!(await Settings.get("initServerTimezone"))) {
        log.debug("server", "emit initServerTimezone");
        socket.emit("initServerTimezone");
    }
}

/**
 * Initialize the database
 * @param {boolean} testMode Should the connection be
 * started in test mode?
 * @returns {Promise<void>}
 */
async function initDatabase(testMode = false) {
    log.debug("server", "Connecting to the database");
    await Database.connect(testMode);
    log.info("server", "Connected to the database");

    // Patch the database
    await Database.patch(port, hostname);
}

/**
 * Resume active monitors
 * @returns {Promise<void>}
 */
async function startMonitors() {
    let list = await R.find("monitor", " active = 1 ");

    for (let monitor of list) {
        server.monitorList[monitor.id] = monitor;
    }

    for (let monitor of list) {
        try {
            await monitor.start(io);
        } catch (e) {
            log.error("monitor", e);
        }
        // Give some delays, so all monitors won't make request at the same moment when just start the server.
        await sleep(getRandomInt(300, 1000));
    }
}

/**
 * Shutdown the application
 * Stops all monitors and closes the database connection.
 * @param {string} signal The signal that triggered this function to be called.
 * @returns {Promise<void>}
 */
async function shutdownFunction(signal) {
    log.info("server", "Shutdown requested");
    log.info("server", "Called signal: " + signal);

    await server.stop();

    log.info("server", "Stopping all monitors");
    for (let id in server.monitorList) {
        let monitor = server.monitorList[id];
        await monitor.stop();
    }
    await sleep(2000);
    await Database.close();

    if (EmbeddedMariaDB.hasInstance()) {
        EmbeddedMariaDB.getInstance().stop();
    }

    stopBackgroundJobs();
    await cloudflaredStop();
    Settings.stopCacheCleaner();
}

/**
 * Final function called before application exits
 * @returns {void}
 */
function finalFunction() {
    log.info("server", "Graceful shutdown successful!");
}

gracefulShutdown(server.httpServer, {
    signals: "SIGINT SIGTERM",
    timeout: 30000, // timeout: 30 secs
    development: false, // not in dev mode
    forceExit: true, // triggers process.exit() at the end of shutdown process
    onShutdown: shutdownFunction, // shutdown function (async) - e.g. for cleanup DB, ...
    finally: finalFunction, // finally function (sync) - e.g. for logging
});

// Catch unexpected errors here
let unexpectedErrorHandler = (error, promise) => {
    console.trace(error);
    UptimeKumaServer.errorLog(error, false);
    console.error("If you keep encountering errors, please report to https://github.com/artchsh/flatline/issues");
};
process.addListener("unhandledRejection", unexpectedErrorHandler);
process.addListener("uncaughtException", unexpectedErrorHandler);
