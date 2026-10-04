import {
    pageSeverity,
    resolveMonitorStates,
    stateLabel,
    type Heartbeat,
    type Incident,
    type MonitorEntry,
    type StatusPageData,
} from "@flatline/shared";

/** How many recent beats to draw per monitor. */
const BEAT_COUNT = 45;

/**
 * Expose the client accent as a CSS custom property.
 * @param {string} accent Hex accent from the page
 * @returns {React.CSSProperties} Style carrying --brand
 */
function brandVars(accent: string | null | undefined): React.CSSProperties {
    return { "--brand": accent ?? "#ff4d2e" } as React.CSSProperties;
}

/**
 * Beat bar for a single monitor.
 *
 * Rendered as divs rather than a canvas so it works without JS and stays
 * legible in a monochrome screenshot.
 */
/**
 * @param {object} props Component props
 * @param {Heartbeat[]} props.beats Recent beats, newest first
 * @returns {React.ReactElement} The beat bar
 */
function Beats({ beats }: { beats: Heartbeat[] }) {
    if (!beats || beats.length === 0) {
        return <div className="beats" aria-hidden="true" />;
    }

    // Oldest first so the newest beat is on the right, matching the trend.
    const recent = beats.slice(0, BEAT_COUNT).reverse();
    const lastCheck = beats[0]?.time;

    return (
        <>
            <div className="beats" aria-hidden="true">
                {recent.map((beat, i) => (
                    <span
                        key={i}
                        title={beat.time}
                        className={`beat ${
                            beat.status === 1 ? "up" : beat.status === 0 ? "down"
                            : beat.status === 3 ? "maintenance" : "pending"
                        }`}
                    />
                ))}
            </div>
            <span className="beat-time" aria-hidden="true">
                {lastCheck ? formatDate(lastCheck).slice(11) : `${beats.length} checks`}
            </span>
        </>
    );
}

/**
 * One monitor row.
 */
/**
 * @param {object} props Component props
 * @param {MonitorEntry} props.monitor The monitor
 * @param {number[]} props.beats Recent beat statuses
 * @returns {React.ReactElement} The row
 */
function MonitorRow({ monitor, state }: { monitor: MonitorEntry; state: { status: number; beats: Heartbeat[] } }) {
    const severity = state.status === 1 ? "up" : state.status === 0 ? "down"
        : state.status === 3 ? "maintenance" : "degraded";

    return (
        <div className="monitor">
            <span className="monitor-name">
                <span>{monitor.name}</span>
            </span>
            <span className={`pill ${severity}`}>
                <span className="dot" />
                {stateLabel(state.status)}
            </span>
            <Beats beats={state.beats} />
        </div>
    );
}

/**
 * Render a status page.
 * @param {object} props Component props
 * @returns {React.ReactElement} The rendered page
 */
export function StatusPageView({ data, heartbeats, history = [] }: {
    data: StatusPageData;
    heartbeats: Record<string, Heartbeat[]>;
    history?: Incident[];
}) {
    // Status lives in the heartbeat feed, not the config payload, so pair the
    // two before deciding anything about overall health.
    const states = resolveMonitorStates(data.publicGroupList, heartbeats);
    const byMonitor = new Map(states.map((s) => [s.monitor.id, s]));

    const severity = pageSeverity(states);
    const monitorCount = states.length;

    // StatusPage.getIcon() returns "/icon.svg" when no logo is set, which is a
    // path on the Flatline server and not this app. Treat that default as "no
    // logo" rather than rendering a broken image.
    const logoUrl = data.config.icon && !data.config.icon.includes("icon.svg")
        ? data.config.icon
        : null;

    // data.incidents holds pinned *active* incidents only; resolved ones come
    // from the separate history fetch.
    const activeIncidents = data.incidents ?? [];
    const pastIncidents = history;

    return (
        <div className="wrap" style={brandVars(data.config.accentColor)}>
            <header className="site-header">
                {logoUrl ? (
                    // Client-supplied path, so next/image optimisation is off:
                    // it must not be fetched and re-encoded on our side.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="site-logo" src={logoUrl} alt="" />
                ) : (
                    <span className="site-logo site-logo-fallback" aria-hidden="true" />
                )}
                <div>
                    <h1 className="site-title">{data.config.title}</h1>
                    {data.config.description ? <p className="site-description">{data.config.description}</p> : null}
                </div>
            </header>

            <section className={`hero ${severity}`}>
                <div className="hero-row">
                    <span className="hero-dot" />
                    <span className="hero-label">{heroLabel(severity)}</span>
                </div>
                {monitorCount > 0 ? (
                    <div className="hero-meta">
                        {monitorCount} {monitorCount === 1 ? "service" : "services"}
                    </div>
                ) : null}
            </section>

            {activeIncidents.length > 0 ? (
                <section className="section">
                    <h2 className="section-title">Active incidents</h2>
                    {activeIncidents.map((incident) => (
                        <article className={`incident ${incident.style}`} key={incident.id}>
                            <div className="incident-head">
                                <h3 className="incident-title">{incident.title}</h3>
                                <span className="incident-badge">Investigating</span>
                            </div>
                            <div className="incident-body">
                                <p>{stripTags(incident.content)}</p>
                            </div>
                            {incident.createdDate ? (
                                <div className="incident-time">{formatDate(incident.createdDate)}</div>
                            ) : null}
                        </article>
                    ))}
                </section>
            ) : null}

            {data.publicGroupList.map((group) => (
                <section className="section" key={group.id}>
                    <h2 className="section-title">{group.name}</h2>
                    <div className="group">
                        {(group.monitorList ?? []).map((monitor) => {
                            const entry = byMonitor.get(monitor.id);
                            return (
                                <MonitorRow
                                    key={monitor.id}
                                    monitor={monitor}
                                    state={entry?.state ?? { status: 2, beats: [], ping: null, msg: "" }}
                                />
                            );
                        })}
                    </div>
                </section>
            ))}

            {pastIncidents.length > 0 ? (
                <section className="section">
                    <h2 className="section-title">Recent incidents</h2>
                    {pastIncidents.map((incident) => (
                        <article className={`incident ${incident.style}`} key={incident.id}>
                            <div className="incident-head">
                                <h3 className="incident-title">{incident.title}</h3>
                                <span className="incident-badge incident-badge-resolved">Resolved</span>
                            </div>
                            <div className="incident-body">
                                <p>{stripTags(incident.content)}</p>
                            </div>
                            {incident.createdDate ? (
                                <div className="incident-time">{formatDate(incident.createdDate)}</div>
                            ) : null}
                        </article>
                    ))}
                </section>
            ) : null}

            <footer className="footer">
                {data.config.showPoweredBy ? <span>Status by Flatline</span> : null}
                <span>Updated {new Date().toISOString().slice(11, 16)} UTC</span>
            </footer>
        </div>
    );
}

/**
 * Headline for an overall severity.
 * @param {string} severity Severity key
 * @returns {string} Headline text
 */
function heroLabel(severity: string): string {
    switch (severity) {
        case "up":
            return "All systems operational";
        case "down":
            return "Major outage";
        case "degraded":
            return "Partially degraded";
        case "maintenance":
            return "Under maintenance";
        default:
            return "Status unavailable";
    }
}

/**
 * Incident bodies arrive as markdown/HTML. Strip tags rather than injecting
 * untrusted HTML into the page.
 */
/**
 * @param {string} value Value to clean
 * @returns {string} Plain text
 */
function stripTags(value: string): string {
    return String(value ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * @param {string} value Date string from the API
 * @returns {string} Formatted UTC timestamp
 */
function formatDate(value: string): string {
    const date = new Date(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z"));
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}
