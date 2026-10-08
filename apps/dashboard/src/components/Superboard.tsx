import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ApiError,
    fetchLatestMetrics,
    fetchMonitors,
    getToken,
    setToken,
    type MonitorSummary,
} from "@/lib/api";
import { navigate } from "@/lib/router";
import { TokenGate } from "@/components/TokenGate";
import { FleetCard, type FleetServer } from "@/components/FleetCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** Minimum card footprint used to work out how many fit on the wall. */
const MIN_CARD_W = 340;
const MIN_CARD_H = 220;
const GAP = 16;

/** How long the board stays paused after someone touches it. */
const IDLE_RESUME_MS = 30_000;

/** How often the numbers are refetched. */
const REFRESH_MS = 5_000;

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
 * Open a monitor's metrics as a board entry, or null when it has none.
 *
 * A 404 is not an error here: it is exactly how the board discovers which
 * monitors are servers. Any other failure propagates.
 * @param monitor Roster entry
 * @returns The sample, or null
 */
async function toFleetServer(monitor: MonitorSummary): Promise<FleetServer | null> {
    try {
        const res = await fetchLatestMetrics(monitor.id);
        return { monitor, time: res.time, metrics: res.metrics };
    } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
            return null;
        }
        throw e;
    }
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

    const gridRef = useRef<HTMLDivElement>(null);
    const resumeTimer = useRef<number | undefined>(undefined);

    const params = useMemo(() => new URLSearchParams(window.location.search), []);
    const rotateMs = intParam(params, "rotate", 5, 1, 300) * 1000;
    const rawPerPage = intParam(params, "perPage", 0, 1, 200);
    const overridePerPage = params.has("perPage") && rawPerPage > 0 ? rawPerPage : null;

    // -- data ---------------------------------------------------------------

    useEffect(() => {
        let alive = true;

        async function load() {
            try {
                const roster = await fetchMonitors({ perPage: 200 });

                // Groups are containers, not servers; anything else that has
                // recent metrics is one. Zero configuration, and a server that
                // stops pushing ages out of the board on its own.
                const candidates = roster.monitors.filter((m) => m.type !== "group" && m.active !== false);
                const samples = await Promise.all(candidates.map((m) => toFleetServer(m)));

                if (!alive) {
                    return;
                }

                const weights = new Map(roster.monitors.map((m) => [ m.id, m ]));

                const next = samples.filter((s): s is FleetServer => s !== null);

                // Operator-controlled order: parent group weight, then the
                // monitor's own weight, then name. Ties fall back to name so
                // the board never reshuffles between refreshes.
                next.sort((a, b) => {
                    const aw = weights.get(a.monitor.parent ?? -1)?.weight ?? 0;
                    const bw = weights.get(b.monitor.parent ?? -1)?.weight ?? 0;
                    return (
                        aw - bw ||
                        (a.monitor.weight ?? 0) - (b.monitor.weight ?? 0) ||
                        a.monitor.name.localeCompare(b.monitor.name)
                    );
                });

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
        void load();
        const timer = window.setInterval(() => {
            if (!document.hidden) {
                void load();
            }
        }, REFRESH_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
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
            const rows = Math.max(1, Math.floor((el.clientHeight + GAP) / (MIN_CARD_H + GAP)));
            setLayout((prev) => (prev.cols === cols && prev.rows === rows ? prev : { cols, rows }));
        };

        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const perPage = overridePerPage ?? layout.cols * layout.rows;
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
        if (paused || !visible || pageCount <= 1) {
            return;
        }
        const timer = window.setInterval(() => setPage((p) => (p + 1) % pageCount), rotateMs);
        return () => window.clearInterval(timer);
    }, [ paused, visible, pageCount, rotateMs ]);

    /** Any interaction pauses rotation for a while, so investigation is possible. */
    function noteInteraction() {
        setPaused(true);
        window.clearTimeout(resumeTimer.current);
        resumeTimer.current = window.setTimeout(() => setPaused(false), IDLE_RESUME_MS);
    }

    useEffect(() => () => window.clearTimeout(resumeTimer.current), []);

    const down = servers.filter((s) => s.monitor.status === 0).length;
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
            className="grid min-h-0 flex-1 gap-4"
            style={{
                gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
                gridAutoRows: "minmax(0, 1fr)",
            }}
        >
            {pageServers.map((server) => (
                <FleetCard key={server.monitor.id} server={server} />
            ))}
        </div>
    );

    const body = (
        <div
            className="flex h-full min-h-0 flex-col"
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
                            <Badge tone="up">
                                <span className="size-1.5 rounded-full bg-current" />
                                All up
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
                        <span className="tnum">{servers.length}</span> servers
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
        return <TokenGate onSaved={() => setAuthed(true)} />;
    }

    return <Superboard kiosk={kiosk} onDisconnect={disconnect} />;
}
