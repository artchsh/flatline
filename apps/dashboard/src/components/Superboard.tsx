import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ApiError,
    fetchLatestMetricsBulk,
    fetchAllMonitors,
    watchLive,
    getToken,
    setToken,
    type MonitorSummary,
} from "@/lib/api";
import { navigate } from "@/lib/router";
import { TokenGate } from "@/components/TokenGate";
import { FleetCard, type FleetServer } from "@/components/FleetCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fleetAttention } from "@/lib/fleet-presentation";
import { fleetPageSize } from "@/lib/fleet-layout";
import { ServerHistory } from "@/components/ServerHistory";

/** Minimum card footprint used to work out how many fit on the wall. */
const MIN_CARD_W = 340;
const MIN_CARD_H = 420;
const GAP = 16;

/** How long the board stays paused after someone touches it. */
const IDLE_RESUME_MS = 30_000;

/**
 * Parse an integer query parameter, clamped to a range.
 * @param params URL search params
 * @param key Parameter name
 * @param fallback Value when absent or invalid
 * @param min Lower bound
 * @param max Upper bound
 * @returns The clamped integer
 */
function intParam(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
    const raw = params.get(key);
    if (raw === null || !/^[0-9]+$/.test(raw)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Number(raw)));
}

/**
 * Open monitors' metrics as board entries in one request.
 *
 * A null sample is not an error: it is exactly how the board discovers which
 * monitors are servers. Any transport failure propagates.
 * @param monitors Roster entries with metrics candidates
 * @returns One entry per monitor that has a sample
 */
async function toFleetServers(monitors: MonitorSummary[]): Promise<FleetServer[]> {
    if (monitors.length === 0) {
        return [];
    }

    const samples = {} as Record<number, { time: string; metrics: FleetServer["metrics"]; cpuPeak10m?: FleetServer["cpuPeak10m"] } | null>;
    const batches = Array.from({ length: Math.ceil(monitors.length / 200) }, (_, index) =>
        fetchLatestMetricsBulk(monitors.slice(index * 200, (index + 1) * 200).map(m => m.id)));
    for (const batch of await Promise.all(batches)) { Object.assign(samples, batch.samples); }
    const out: FleetServer[] = [];

    for (const monitor of monitors) {
        const sample = samples[monitor.id];
        if (sample) {
            out.push({ monitor, time: sample.time, metrics: sample.metrics, cpuPeak10m: sample.cpuPeak10m });
        }
    }

    return out;
}

/**
 * Wall clock for the kiosk view.
 *
 * Only mounted in kiosk mode: the desk board does not need a running clock,
 * and a per-second re-render is not free.
 */
function Clock() {
    const [now, setNow] = useState(() => new Date());

    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    return (
        <span className="tnum text-sm text-quiet">
            {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
    );
}

/**
 * The board itself: fleet cards, auto-pagination, and the kiosk chrome.
 */
function Superboard({ kiosk, onDisconnect }: { kiosk: boolean; onDisconnect: () => void }) {
    const [servers, setServers] = useState<FleetServer[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);

    const [page, setPage] = useState(0);
    const [paused, setPaused] = useState(false);
    const [layout, setLayout] = useState({ cols: 3, rows: 2 });
    const [visible, setVisible] = useState(() => !document.hidden);
    const [now, refreshFreshness] = useState(Date.now);
    const [historyId, setHistoryId] = useState<number | null>(null);
    const openHistory = useCallback((id: number) => setHistoryId(id), []);
    const closeHistory = useCallback(() => setHistoryId(null), []);
    const historyMonitor = servers.find(server => server.monitor.id === historyId)?.monitor;

    // Freshness must age even when the last/only host stops sending.
    useEffect(() => {
        const timer = window.setInterval(() => {
            if (!document.hidden) { refreshFreshness(Date.now()); }
        }, 1000);
        return () => window.clearInterval(timer);
    }, []);

    const gridRef = useRef<HTMLDivElement>(null);
    const resumeTimer = useRef<number | undefined>(undefined);

    const params = useMemo(() => new URLSearchParams(window.location.search), []);
    const rotateMs = intParam(params, "rotate", 5, 1, 300) * 1000;
    const rawPerPage = intParam(params, "perPage", 0, 1, 200);
    const overridePerPage = params.has("perPage") && rawPerPage > 0 ? rawPerPage : null;

    // -- data ---------------------------------------------------------------

    useEffect(() => {
        let alive = true;
        let roster = new Map<number, MonitorSummary>();
        const order = (a: FleetServer, b: FleetServer) =>
            (roster.get(a.monitor.parent ?? -1)?.weight ?? 0) - (roster.get(b.monitor.parent ?? -1)?.weight ?? 0) ||
            (a.monitor.weight ?? 0) - (b.monitor.weight ?? 0) || a.monitor.name.localeCompare(b.monitor.name);

        async function load() {
            try {
                const monitors = await fetchAllMonitors();
                roster = new Map(monitors.map(m => [m.id, m]));

                // Groups are containers, not servers; anything else that has
                // recent metrics is one. Zero configuration, and a server that
                // stops pushing ages out of the board on its own. One bulk
                // request, not one per monitor, so the board sips the rate
                // budget instead of drinking it.
                const candidates = monitors.filter((m) => m.type !== "group" && m.active !== false);
                const next = await toFleetServers(candidates);

                if (!alive) {
                    return;
                }


                // Operator-controlled order: parent group weight, then the
                // monitor's own weight, then name. Ties fall back to name so
                // the board never reshuffles between refreshes.
                next.sort(order);

                setServers(next);
                setError(null);
            } catch (e) {
                if (!alive) {
                    return;
                }
                if (e instanceof ApiError && e.status === 401) {
                    onDisconnect();
                    return;
                }
                setError(e instanceof Error ? e.message : "Could not load the board.");
                throw e;
            } finally {
                if (alive) {
                    setLoaded(true);
                }
            }
        }

        // Always load once, even if the tab is hidden at mount: a kiosk that
        // wakes up foregrounded must never flash "no servers" because the
        // first fetch was cancelled by a visibility change. The interval,
        // however, skips hidden ticks — no point polling a board nobody sees.
        const stop = watchLive({
            snapshot: load,
            event: event => {
                if (!alive) { return; }
                const monitor = roster.get(event.monitorId);
                if (event.type === "heartbeat" && monitor) { roster.set(event.monitorId, { ...monitor, ...event.patch }); }
                setServers(previous => {
                    if (event.type === "metrics" && !previous.some(s => s.monitor.id === event.monitorId) && monitor?.active && monitor.type !== "group") {
                        return [...previous, { monitor, time: event.time, metrics: event.metrics, cpuPeak10m: event.cpuPeak10m }].sort(order);
                    }
                    return previous.map(server => server.monitor.id !== event.monitorId ? server :
                        event.type === "metrics" ? { ...server, time: event.time, metrics: event.metrics, cpuPeak10m: event.cpuPeak10m } :
                            { ...server, monitor: { ...server.monitor, ...event.patch } });
                });
                setError(null);
            },
            error: error => {
                if (!alive) { return; }
                if (error instanceof ApiError && (error.status === 401 || error.status === 403)) { onDisconnect(); return; }
                setError("Live updates disconnected; reconnecting. Last readings remain visible.");
                // A metrics-free/new host is discovered on reconnect snapshot.
            },
        });
        return () => {
            alive = false;
            stop();
        };
    }, [ onDisconnect ]);

    // Pause work while the tab is hidden; resume when it comes back.
    useEffect(() => {
        const onVisibility = () => setVisible(!document.hidden);
        document.addEventListener("visibilitychange", onVisibility);
        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, []);

    // -- how many cards fit -------------------------------------------------

    useEffect(() => {
        const el = gridRef.current;
        if (!el) {
            return;
        }

        const measure = () => {
            const cols = Math.max(1, Math.floor((el.clientWidth + GAP) / (MIN_CARD_W + GAP)));
            // Content-sized cards can be taller with GPUs or long names.
            // Measure them rather than packing rows against an assumed height.
            const cardHeight = Math.max(MIN_CARD_H, ...Array.from(el.children)
                .map(card => card.getBoundingClientRect().height));
            const rows = Math.max(1, Math.floor((el.clientHeight + GAP) / (cardHeight + GAP)));
            setLayout((prev) => (prev.cols === cols && prev.rows === rows ? prev : { cols, rows }));
        };

        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        Array.from(el.children).forEach(card => observer.observe(card));
        return () => observer.disconnect();
    }, [servers.length]);

    // A tall GPU card must not force eight hosts onto rotating single rows.
    // Pack at least ten per page; CSS uses additional rows/scrolling as needed.
    const perPage = fleetPageSize(layout.cols, layout.rows, overridePerPage);
    const pageCount = Math.max(1, Math.ceil(servers.length / perPage));
    const pageServers = servers.slice(page * perPage, page * perPage + perPage);

    // Keep the page in range as the fleet or the viewport changes.
    useEffect(() => {
        if (page >= pageCount) {
            setPage(0);
        }
    }, [ page, pageCount ]);

    // -- rotation -----------------------------------------------------------

    useEffect(() => {
        if (paused || !visible || pageCount <= 1 || historyId !== null) {
            return;
        }
        const timer = window.setInterval(() => setPage((p) => (p + 1) % pageCount), rotateMs);
        return () => window.clearInterval(timer);
    }, [ paused, visible, pageCount, rotateMs, historyId ]);

    /** Any interaction pauses rotation for a while, so investigation is possible. */
    function noteInteraction() {
        setPaused(true);
        window.clearTimeout(resumeTimer.current);
        resumeTimer.current = window.setTimeout(() => setPaused(false), IDLE_RESUME_MS);
    }

    useEffect(() => () => window.clearTimeout(resumeTimer.current), []);

    const down = servers.filter((s) => s.monitor.status === 0).length;
    const attentionCount = servers.filter(s => {
        const state = fleetAttention(s.metrics, s.time, s.monitor.interval || 60);
        return s.monitor.status === 0 || s.monitor.status === 2 || state.stale || state.issues > 0 || state.hot;
    }).length;
    const rotated = pageCount > 1;

    const position = (
        <span className="tnum text-xs text-quiet">
            {page + 1} / {pageCount}
            {paused && rotated ? <span className="ml-2 font-semibold text-warn">paused</span> : null}
        </span>
    );

    // -- render -------------------------------------------------------------

    const content = loaded && servers.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-lg font-semibold">No servers reporting yet.</p>
            <p className="max-w-md text-sm text-quiet">
                Install the Superboard agent on a box, or POST metrics to a push monitor. Any monitor
                that sends a metrics sample shows up here automatically.
            </p>
        </div>
    ) : (
        <div
            ref={gridRef}
            className="fleet-grid grid min-h-0 flex-1 items-start content-start gap-4 overflow-y-auto"
            style={{
                gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
            }}
        >
            {pageServers.map((server) => (
                <FleetCard key={server.monitor.id} server={server} now={now} onOpenHistory={openHistory} />
            ))}
        </div>
    );

    const body = (
        <div
            className="superboard flex h-full min-h-0 flex-col"
            data-kiosk={kiosk || undefined}
            onPointerDown={noteInteraction}
            onKeyDown={noteInteraction}
            onTouchStart={noteInteraction}
        >
            {kiosk ? (
                <div className="flex items-center justify-between px-4 py-2">
                    <span className="text-sm font-semibold tracking-tight">
                        Flatline <span className="font-normal text-quiet">Superboard</span>
                    </span>
                    <span className="flex items-center gap-4">
                        {down > 0 ? (
                            <Badge tone="down">
                                <span className="size-1.5 rounded-full bg-current" />
                                {down} down
                            </Badge>
                        ) : (
                            <Badge tone={attentionCount > 0 ? "degraded" : "neutral"}>
                                <span className="size-1.5 rounded-full bg-current" />
                                {attentionCount > 0 ? `${attentionCount} need attention` : "All hosts up"}
                            </Badge>
                        )}
                        {position}
                        <Clock />
                    </span>
                </div>
            ) : (
                <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                    <button
                        type="button"
                        className="text-sm font-semibold tracking-tight hover:text-primary"
                        onClick={() => navigate("/")}
                    >
                        ← Flatline
                    </button>
                    <span className="text-sm text-quiet">Superboard</span>
                    <span className="text-xs text-quiet">
                        <span className="tnum">{servers.length}</span> {servers.length === 1 ? "server" : "servers"}
                        {down > 0 ? <span className="ml-1 font-semibold text-bad">· {down} down</span> : null}
                    </span>
                    <div className="ml-auto flex items-center gap-3">
                        {position}
                        <Button size="sm" variant="outline" onClick={() => navigate("/superboard/kiosk")}>
                            Kiosk
                        </Button>
                        <Button size="sm" variant="ghost" title="Forget token" onClick={onDisconnect}>
                            Disconnect
                        </Button>
                    </div>
                </div>
            )}

            {error ? (
                <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
                    {error}
                </div>
            ) : null}

            <div className={`flex min-h-0 flex-1 flex-col p-4 ${kiosk ? "pt-0" : ""}`}>{content}</div>
            {historyMonitor ? <ServerHistory monitor={historyMonitor} onClose={closeHistory} /> : null}
        </div>
    );

    // Kiosk fills the viewport and does not scroll: the wall URL is opened
    // fullscreen and must never show a scrollbar.
    return kiosk ? <div className="h-screen w-screen overflow-hidden">{body}</div> : <div className="h-screen">{body}</div>;
}

/**
 * Superboard entry point: auth gate plus the board.
 *
 * Auth is the same bearer-token model as the dashboard, so the board inherits
 * every scope rule without a second login.
 * @param props.kiosk Render chrome-free for a wall display
 */
export function SuperboardApp({ kiosk }: { kiosk: boolean }) {
    const [authed, setAuthed] = useState(() => Boolean(getToken()));

    const disconnect = useCallback(() => {
        setToken(null);
        setAuthed(false);
    }, []);

    if (!authed) {
        return <TokenGate inviteToken={null} onSaved={() => setAuthed(true)} />;
    }

    return <Superboard kiosk={kiosk} onDisconnect={disconnect} />;
}
