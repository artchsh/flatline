const express = require("express");
const https = require("https");
const fs = require("fs");
const http = require("http");
const { R } = require("redbean-node");
const { log } = require("../src/util");
const Database = require("./database");
const util = require("util");
const { Settings } = require("./settings");
const dayjs = require("dayjs");
const childProcessAsync = require("promisify-child-process");
const path = require("path");
const axios = require("axios");
const { isSSL, sslKey, sslCert, sslKeyPassphrase } = require("./config");
const { getSession, getDisableAuthSession } = require("./better-auth");
// DO NOT IMPORT HERE IF THE MODULES USED `UptimeKumaServer.getInstance()`, put at the bottom of this file instead.

/**
 * `module.exports` (alias: `server`) should be inside this class, in order to avoid circular dependency issue.
 * @type {UptimeKumaServer}
 */
class UptimeKumaServer {
    /**
     * Current server instance
     * @type {UptimeKumaServer}
     */
    static instance = null;

    /**
     * Main monitor list
     * @type {{}}
     */
    monitorList = {};

    /**
     * Main maintenance list
     * @type {{}}
     */
    maintenanceList = {};

    entryPage = "dashboard";
    app = undefined;
    httpServer = undefined;

    /**
     * Cache Index HTML
     * @type {string}
     */
    indexHTML = "";

    /**
     * @type {{}}
     */
    static monitorTypeList = {};

    /**
     * Get the current instance of the server if it exists, otherwise
     * create a new instance.
     * @returns {UptimeKumaServer} Server instance
     */
    static getInstance() {
        if (UptimeKumaServer.instance == null) {
            UptimeKumaServer.instance = new UptimeKumaServer();
        }
        return UptimeKumaServer.instance;
    }

    /**
     *
     */
    constructor() {
        // Set axios default user-agent to Uptime-Kuma/version
        axios.defaults.headers.common["User-Agent"] = this.getUserAgent();

        // Set default axios timeout to 5 minutes instead of infinity
        axios.defaults.timeout = 300 * 1000;

        log.info("server", "Creating express instance");
        this.app = express();
        if (isSSL) {
            log.info("server", "Server Type: HTTPS");
            this.httpServer = https.createServer(
                {
                    key: fs.readFileSync(sslKey),
                    cert: fs.readFileSync(sslCert),
                    passphrase: sslKeyPassphrase,
                },
                this.app
            );
        } else {
            log.info("server", "Server Type: HTTP");
            this.httpServer = http.createServer(this.app);
        }

        // The backend is API-only: it never serves HTML, so it must boot
        // without a frontend build on disk. `indexHTML` stays as the empty
        // string it initialises to; nothing reads it anymore.

        // Set Monitor Types
        UptimeKumaServer.monitorTypeList["real-browser"] = new RealBrowserMonitorType();
        UptimeKumaServer.monitorTypeList["tailscale-ping"] = new TailscalePing();
        UptimeKumaServer.monitorTypeList["websocket-upgrade"] = new WebSocketMonitorType();
        UptimeKumaServer.monitorTypeList["dns"] = new DnsMonitorType();
        UptimeKumaServer.monitorTypeList["postgres"] = new PostgresMonitorType();
        UptimeKumaServer.monitorTypeList["mqtt"] = new MqttMonitorType();
        UptimeKumaServer.monitorTypeList["smtp"] = new SMTPMonitorType();
        UptimeKumaServer.monitorTypeList["group"] = new GroupMonitorType();
        UptimeKumaServer.monitorTypeList["snmp"] = new SNMPMonitorType();
        UptimeKumaServer.monitorTypeList["grpc-keyword"] = new GrpcKeywordMonitorType();
        UptimeKumaServer.monitorTypeList["mongodb"] = new MongodbMonitorType();
        UptimeKumaServer.monitorTypeList["rabbitmq"] = new RabbitMqMonitorType();
        UptimeKumaServer.monitorTypeList["sip-options"] = new SIPMonitorType();
        UptimeKumaServer.monitorTypeList["gamedig"] = new GameDigMonitorType();
        UptimeKumaServer.monitorTypeList["steam"] = new SteamMonitorType();
        UptimeKumaServer.monitorTypeList["port"] = new TCPMonitorType();
        UptimeKumaServer.monitorTypeList["manual"] = new ManualMonitorType();
        UptimeKumaServer.monitorTypeList["globalping"] = new GlobalpingMonitorType(this.getUserAgent());
        UptimeKumaServer.monitorTypeList["redis"] = new RedisMonitorType();
        UptimeKumaServer.monitorTypeList["pm2"] = new PM2MonitorType();
        UptimeKumaServer.monitorTypeList["system-service"] = new SystemServiceMonitorType();
        UptimeKumaServer.monitorTypeList["sqlserver"] = new MssqlMonitorType();
        UptimeKumaServer.monitorTypeList["mysql"] = new MysqlMonitorType();
        UptimeKumaServer.monitorTypeList["sftp"] = new SFTPMonitorType();
        UptimeKumaServer.monitorTypeList["oracledb"] = new OracleDbMonitorType();
        UptimeKumaServer.monitorTypeList["ntp"] = new NTPMonitorType();
    }

    /**
     * Initialise app after the database has been set up
     * @returns {Promise<void>}
     */
    async initAfterDatabaseReady() {
        // Screenshots
        this.app.use("/screenshots", async (req, res, next) => {
            try {
                let session;
                if (!(await Settings.get("disableAuth"))) {
                    session = await getSession(req.headers.cookie);
                } else {
                    session = await getDisableAuthSession();
                }
                if (session) {
                    express.static(Database.screenshotDir)(req, res, next);
                } else {
                    res.sendStatus(401);
                }
            } catch (_) {
                res.sendStatus(401);
            }
        });

        process.env.TZ = await this.getTimezone();
        dayjs.tz.setDefault(process.env.TZ);
        log.debug("DEBUG", "Timezone: " + process.env.TZ);
        log.debug("DEBUG", "Current Time: " + dayjs.tz().format());

        await this.loadMaintenanceList();
    }

    
    
    
    /**
     * Get a list of monitors.
     *
     * Flatline is a shared instance, so monitors are never filtered by owner.
     * A leading userID argument is accepted and ignored so existing call sites
     * that pass `(userID, monitorID)` keep working.
     * @param {?string} _userID Ignored, kept for call-site compatibility
     * @param {?number} monitorID - The ID of monitor for
     * @returns {Promise<object>} Monitor ids mapped to monitor objects
     */
    async getMonitorJSONList(_userID = null, monitorID = null) {
        let queryKeys = [];
        let queryParams = [];

        if (monitorID) {
            queryKeys.push(" id = ? ");
            queryParams.push(monitorID);
        }

        const query = queryKeys.join(" AND ");
        const orderBy = "ORDER BY weight DESC, name";

        let monitorList;

        if (queryKeys.length === 0) {
            monitorList = await R.findAll("monitor", orderBy, queryParams);
        } else {
            monitorList = await R.find("monitor", query + orderBy, queryParams);
        }

        const monitorData = monitorList.map((monitor) => ({
            id: monitor.id,
            active: monitor.active,
            name: monitor.name,
        }));
        const preloadData = await Monitor.preparePreloadData(monitorData);

        const result = {};
        monitorList.forEach((monitor) => (result[monitor.id] = monitor.toJSON(preloadData)));
        return result;
    }

    
    
    /**
     * Get a list of maintenances.
     * @returns {Promise<object>} A promise that resolves to an object with maintenance IDs as keys and maintenances objects as values.
     */
    async getMaintenanceJSONList() {
        let result = {};
        for (let maintenanceID in this.maintenanceList) {
            result[maintenanceID] = await this.maintenanceList[maintenanceID].toJSON();
        }
        return result;
    }

    /**
     * Load maintenance list and run
     * @param {any} userID Unused
     * @returns {Promise<void>}
     */
    async loadMaintenanceList(userID) {
        let maintenanceList = await R.findAll("maintenance", " ORDER BY end_date DESC, title", []);

        for (let maintenance of maintenanceList) {
            this.maintenanceList[maintenance.id] = maintenance;
            maintenance.run(this);
        }
    }

    /**
     * Retrieve a specific maintenance
     * @param {number} maintenanceID ID of maintenance to retrieve
     * @returns {(object|null)} Maintenance if it exists
     */
    getMaintenance(maintenanceID) {
        if (this.maintenanceList[maintenanceID]) {
            return this.maintenanceList[maintenanceID];
        }
        return null;
    }

    /**
     * Write error to log file
     * @param {any} error The error to write
     * @param {boolean} outputToConsole Should the error also be output to console?
     * @returns {void}
     */
    static errorLog(error, outputToConsole = true) {
        const errorLogStream = fs.createWriteStream(path.join(Database.dataDir, "/error.log"), {
            flags: "a",
        });

        errorLogStream.on("error", () => {
            log.info("", "Cannot write to error.log");
        });

        if (errorLogStream) {
            const dateTime = R.isoDateTime();
            errorLogStream.write(`[${dateTime}] ` + util.format(error) + "\n");

            if (outputToConsole) {
                console.error(error);
            }
        }

        errorLogStream.end();
    }

    
    
    /**
     * Attempt to get the current server timezone
     * If this fails, fall back to environment variables and then make a
     * guess.
     * @returns {Promise<string>} Current timezone
     */
    async getTimezone() {
        // From process.env.TZ
        try {
            if (process.env.TZ) {
                this.checkTimezone(process.env.TZ);
                return process.env.TZ;
            }
        } catch (e) {
            log.warn("timezone", e.message + " in process.env.TZ");
        }

        let timezone = await Settings.get("serverTimezone");

        // From Settings
        try {
            log.debug("timezone", "Using timezone from settings: " + timezone);
            if (timezone) {
                this.checkTimezone(timezone);
                return timezone;
            }
        } catch (e) {
            log.warn("timezone", e.message + " in settings");
        }

        // Guess
        try {
            let guess = dayjs.tz.guess();
            log.debug("timezone", "Guessing timezone: " + guess);
            if (guess) {
                this.checkTimezone(guess);
                return guess;
            } else {
                return "UTC";
            }
        } catch (e) {
            // Guess failed, fall back to UTC
            log.debug("timezone", "Guessed an invalid timezone. Use UTC as fallback");
            return "UTC";
        }
    }

    /**
     * Get the current offset
     * @returns {string} Time offset
     */
    getTimezoneOffset() {
        return dayjs().format("Z");
    }

    /**
     * Throw an error if the timezone is invalid
     * @param {string} timezone Timezone to test
     * @returns {void}
     * @throws The timezone is invalid
     */
    checkTimezone(timezone) {
        try {
            dayjs.utc("2013-11-18 11:55").tz(timezone).format();
        } catch (e) {
            throw new Error("Invalid timezone:" + timezone);
        }
    }

    /**
     * Set the current server timezone and environment variables
     * @param {string} timezone Timezone to set
     * @returns {Promise<void>}
     */
    async setTimezone(timezone) {
        this.checkTimezone(timezone);
        await Settings.set("serverTimezone", timezone, "general");
        process.env.TZ = timezone;
        dayjs.tz.setDefault(timezone);
    }

    /**
     * TODO: Listen logic should be moved to here
     * @returns {Promise<void>}
     */
    async start() {
        let enable = await Settings.get("nscd");

        if (enable || enable === null) {
            await this.startNSCDServices();
        }
    }

    /**
     * Stop the server
     * @returns {Promise<void>}
     */
    async stop() {
        let enable = await Settings.get("nscd");

        if (enable || enable === null) {
            await this.stopNSCDServices();
        }
    }

    /**
     * Start all system services (e.g. nscd)
     * For now, only used in Docker
     * @returns {void}
     */
    async startNSCDServices() {
        if (process.env.UPTIME_KUMA_IS_CONTAINER) {
            try {
                log.info("services", "Starting nscd");
                await childProcessAsync.exec("sudo service nscd start");
            } catch (e) {
                log.info("services", "Failed to start nscd");
            }
        }
    }

    /**
     * Stop all system services
     * @returns {void}
     */
    async stopNSCDServices() {
        if (process.env.UPTIME_KUMA_IS_CONTAINER) {
            try {
                log.info("services", "Stopping nscd");
                await childProcessAsync.exec("sudo service nscd stop");
            } catch (e) {
                log.info("services", "Failed to stop nscd");
            }
        }
    }

    /**
     * Default User-Agent when making HTTP requests
     * @returns {string} User-Agent
     */
    getUserAgent() {
        return "Uptime-Kuma/" + require("../package.json").version;
    }

    }

module.exports = {
    UptimeKumaServer,
};

// Must be at the end to avoid circular dependencies
const { RealBrowserMonitorType } = require("./monitor-types/real-browser-monitor-type");
const { TailscalePing } = require("./monitor-types/tailscale-ping");
const { WebSocketMonitorType } = require("./monitor-types/websocket-upgrade");
const { DnsMonitorType } = require("./monitor-types/dns");
const { PostgresMonitorType } = require("./monitor-types/postgres");
const { MqttMonitorType } = require("./monitor-types/mqtt");
const { SMTPMonitorType } = require("./monitor-types/smtp");
const { GroupMonitorType } = require("./monitor-types/group");
const { SNMPMonitorType } = require("./monitor-types/snmp");
const { GrpcKeywordMonitorType } = require("./monitor-types/grpc");
const { MongodbMonitorType } = require("./monitor-types/mongodb");
const { RabbitMqMonitorType } = require("./monitor-types/rabbitmq");
const { SIPMonitorType } = require("./monitor-types/sip-options");
const { GameDigMonitorType } = require("./monitor-types/gamedig");
const { SteamMonitorType } = require("./monitor-types/steam");
const { TCPMonitorType } = require("./monitor-types/tcp.js");
const { ManualMonitorType } = require("./monitor-types/manual");
const { GlobalpingMonitorType } = require("./monitor-types/globalping");
const { RedisMonitorType } = require("./monitor-types/redis");
const { PM2MonitorType } = require("./monitor-types/pm2");
const { SystemServiceMonitorType } = require("./monitor-types/system-service");
const { MssqlMonitorType } = require("./monitor-types/mssql");
const { MysqlMonitorType } = require("./monitor-types/mysql");
const { SFTPMonitorType } = require("./monitor-types/sftp");
const { OracleDbMonitorType } = require("./monitor-types/oracledb");
const { NTPMonitorType } = require("./monitor-types/ntp");
const Monitor = require("./model/monitor");
