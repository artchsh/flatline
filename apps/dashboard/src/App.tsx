import { useEffect, useMemo, useState } from "react";
import {
    ApiError,
    deleteMonitor,
    fetchHealth,
    fetchMonitors,
    getToken,
    pauseMonitor,
    resumeMonitor,
    setToken,
    type HealthSummary,
    type MonitorSummary,
} from "@/lib/api";
import { MonitorForm } from "@/components/MonitorForm";
import { MonitorDetail } from "@/components/MonitorDetail";
import { AgentPanel } from "@/components/AgentPanel";
import { UsersPanel } from "@/components/UsersPanel";
import { TokenGate } from "@/components/TokenGate";
import { SuperboardApp } from "@/components/Superboard";
import { inviteTokenFrom, navigate, usePath } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Map a numeric monitor status onto a label and a badge tone.
 *
 * Status is never colour alone; a word always accompanies it.
 */
function statusOf(status: number): { label: string; tone: "up" | "down" | "degraded" | "maintenance" | "neutral" } {
    switch (status) {
        case 1:
            return { label: "Up", tone: "up" };
        case 0:
            return { label: "Down", tone: "down" };
        case 2:
            return { label: "Pending", tone: "degraded" };
        case 3:
            return { label: "Maintenance", tone: "maintenance" };
        default:
            return { label: "Unknown", tone: "neutral" };
    }
}

function formatUptime(value: number | null): string {
    if (value === null || value === undefined) {
        return "—";
    }
    // The API returns a 0..1 ratio.
    return `${(value * 100).toFixed(value >= 0.9999 ? 2 : 1)}%`;
}

function formatPing(value: number | null): string {
    return value === null || value === undefined ? "—" : `${Math.round(value)}ms`;
}

/**
 * Relative age of a timestamp, e.g. "12s".
 */
function ageOf(value: string | null): string {
    if (!value) {
        return "—";
    }

    const then = new Date(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z")).getTime();
    if (Number.isNaN(then)) {
        return "—";
    }

    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    if (seconds < 3600) {
        return `${Math.round(seconds / 60)}m`;
    }
    if (seconds < 86400) {
        return `${Math.round(seconds / 3600)}h`;
    }
    return `${Math.round(seconds / 86400)}d`;
}

/**
 * One-line health strip.
 *
 * Dense on purpose: the operator's question is "is anything broken", and it
 * should be answerable without reading five equal-weight cards.
 */
function HealthStrip({ health }: { health: HealthSummary }) {
    const items: Array<{ label: string; value: number; tone: string }> = [
        { label: "up", value: health.up, tone: "text-ok" },
        { label: "down", value: health.down, tone: health.down > 0 ? "text-bad font-semibold" : "text-quiet" },
        { label: "pending", value: health.pending, tone: health.pending > 0 ? "text-warn" : "text-quiet" },
        { label: "maintenance", value: health.maintenance, tone: health.maintenance > 0 ? "text-maint" : "text-quiet" },
        { label: "paused", value: health.paused, tone: "text-quiet" },
    ];

    return (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-4 py-3">
            <span
                className={`inline-flex items-center gap-2 text-sm font-semibold ${
                    health.down > 0 ? "text-bad" : "text-ok"
                }`}
            >
                <span className="size-2 rounded-full bg-current" />
                {health.down > 0 ? "Degraded" : "Operational"}
            </span>

            {items.map((item) => (
                <span key={item.label} className="text-xs">
                    <span className={`tnum font-semibold ${item.tone}`}>{item.value}</span>{" "}
                    <span className="text-quiet">{item.label}</span>
                </span>
            ))}

            <span className="ml-auto text-xs text-quiet">
                <span className="tnum">{health.total}</span> monitors
            </span>
        </div>
    );
}

/**
 * The monitor table.
 *
 * Dense by design: a row is one line, numbers are tabular so columns align,
 * and select-then-act is keyboard reachable.
 */
function MonitorTable({
    monitors,
    selected,
    onToggle,
    onEdit,
}: {
    monitors: MonitorSummary[];
    selected: Set<number>;
    onToggle: (id: number) => void;
    onEdit: (id: number) => void;
}) {
    return (
        <div className="overflow-x-auto">
        {/* table-fixed with an explicit colgroup: an auto layout table lets the
            name column absorb all the width, which squeezes the numeric columns
            until their headers collide. Fixed widths keep rows comparable down
            a column, which is the point of this view. */}
        <table className="w-full table-fixed border-collapse text-sm">
            <colgroup>
                <col className="w-8" />
                <col className="w-[30rem]" />
                <col className="w-32" />
                <col className="w-20" />
                <col className="w-20" />
                <col className="w-20" />
                <col className="w-24" />
                <col className="w-24" />
            </colgroup>
            <thead>
                <tr className="border-b border-border text-left text-xs tracking-wide text-muted-foreground uppercase">
                    <th className="w-8 py-2 pl-4" />
                    <th className="py-2 pl-1 font-medium">Monitor</th>
                    <th className="w-32 py-2 font-medium">Status</th>
                    <th className="w-20 py-2 pl-3 text-right font-medium whitespace-nowrap">24h</th>
                    <th className="w-20 py-2 pl-3 text-right font-medium whitespace-nowrap">7d</th>
                    <th className="w-20 py-2 pl-3 text-right font-medium whitespace-nowrap">Ping</th>
                    <th className="w-24 py-2 pl-3 text-right font-medium whitespace-nowrap">Checked</th>
                    <th className="w-24 py-2 pr-4 pl-3 font-medium whitespace-nowrap">Type</th>
                </tr>
            </thead>
            <tbody>
                {monitors.map((monitor) => {
                    const status = statusOf(monitor.status);
                    const isSelected = selected.has(monitor.id);

                    return (
                        <tr
                            key={monitor.id}
                            data-selected={isSelected || undefined}
                            className="border-b border-border/60 last:border-0 hover:bg-surface data-[selected]:bg-surface"
                        >
                            <td className="py-2 pl-4">
                                <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => onToggle(monitor.id)}
                                    aria-label={`Select ${monitor.name}`}
                                    className="size-3.5 accent-[var(--primary)]"
                                />
                            </td>
                            <td className="py-2 pr-4 pl-1">
                                {/* Name and target on one line: this view is for
                                    scanning many rows, so vertical space in a row
                                    is the scarce resource. */}
                                <div className="flex items-baseline gap-2 truncate">
                                    <button
                                        type="button"
                                        onClick={() => onEdit(monitor.id)}
                                        className="truncate font-medium hover:text-primary hover:underline"
                                    >
                                        {monitor.name}
                                    </button>
                                    <span className="truncate text-xs text-quiet">
                                        {monitor.url ?? monitor.lastMessage ?? "—"}
                                    </span>
                                </div>
                            </td>
                            <td className="py-2 whitespace-nowrap">
                                <Badge tone={status.tone}>
                                    <span className="size-1.5 rounded-full bg-current" />
                                    {status.label}
                                </Badge>
                                {!monitor.active ? (
                                    <span className="ml-2 text-[11px] text-quiet">paused</span>
                                ) : null}
                            </td>
                            <td className="tnum py-2 pl-3 text-right whitespace-nowrap">{formatUptime(monitor.uptime24h)}</td>
                            <td className="tnum py-2 pl-3 text-right whitespace-nowrap">{formatUptime(monitor.uptime7d)}</td>
                            <td className="tnum py-2 pl-3 text-right whitespace-nowrap">{formatPing(monitor.ping)}</td>
                            <td className="tnum py-2 pl-3 text-right whitespace-nowrap text-quiet">
                                {ageOf(monitor.lastCheck)} ago
                            </td>
                            <td className="py-2 pr-4 pl-3 text-xs whitespace-nowrap text-quiet">{monitor.type}</td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
        </div>
    );
}

/**
 * The operator's monitor table.
 */
function Dashboard({ inviteToken }: { inviteToken: string | null }) {
    const [authed, setAuthed] = useState(() => Boolean(getToken()));
    const [health, setHealth] = useState<HealthSummary | null>(null);
    const [monitors, setMonitors] = useState<MonitorSummary[]>([]);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [query, setQuery] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [formState, setFormState] = useState<
        | { mode: "create" }
        | { mode: "edit"; monitor: MonitorSummary & Record<string, unknown> }
        | null
    >(null);
    const [detailId, setDetailId] = useState<number | null>(null);
    const [agentsOpen, setAgentsOpen] = useState(false);
    const [usersOpen, setUsersOpen] = useState(false);

    async function load() {
        try {
            const [ h, m ] = await Promise.all([ fetchHealth(), fetchMonitors({ perPage: 200 }) ]);
            setHealth(h.health);
            setMonitors(m.monitors);
            setError(null);
        } catch (e) {
            if (e instanceof ApiError && e.status === 401) {
                setToken(null);
                setAuthed(false);
                return;
            }
            setError(e instanceof Error ? e.message : "Failed to load.");
        }
    }

    // Refresh on mount and every 15s. The dashboard is a passive view, so a
    // short poll is simpler than holding a socket open for every operator.
    useEffect(() => {
        if (!authed) {
            return;
        }

        void load();
        const timer = window.setInterval(() => void load(), 15000);
        return () => window.clearInterval(timer);
    }, [ authed ]);

    // "/" focuses search, escape clears it and any selection.
    useEffect(() => {
        function onKey(event: KeyboardEvent) {
            const target = event.target as HTMLElement | null;
            const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

            if (event.key === "/" && !typing) {
                event.preventDefault();
                document.getElementById("monitor-search")?.focus();
            }

            if (event.key === "Escape") {
                setQuery("");
                setSelected(new Set());
                (document.activeElement as HTMLElement | null)?.blur();
            }
        }

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const filtered = useMemo(() => {
        if (!query.trim()) {
            return monitors;
        }
        const needle = query.trim().toLowerCase();
        return monitors.filter(
            (m) =>
                m.name.toLowerCase().includes(needle) ||
                (m.url ?? "").toLowerCase().includes(needle) ||
                m.type.toLowerCase().includes(needle)
        );
    }, [ monitors, query ]);

    async function applyToSelection(action: "pause" | "resume" | "delete") {
        if (action === "delete") {
            const count = selected.size;
            if (!window.confirm(`Delete ${count} monitor${count === 1 ? "" : "s"}? This cannot be undone.`)) {
                return;
            }
        }
        setBusy(true);
        try {
            await Promise.all(
                [ ...selected ].map((id) => {
                    if (action === "pause") {
                        return pauseMonitor(id);
                    }
                    if (action === "resume") {
                        return resumeMonitor(id);
                    }
                    return deleteMonitor(id);
                })
            );
            setSelected(new Set());
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Action failed.");
        } finally {
            setBusy(false);
        }
    }

    if (!authed) {
        return <TokenGate inviteToken={inviteToken} onSaved={() => setAuthed(true)} />;
    }

    return (
        <div className="min-h-screen">
            <header className="flex items-center gap-3 border-b border-border px-4 py-3">
                <span className="text-sm font-semibold tracking-tight">Flatline</span>

                <Input
                    id="monitor-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search  ( / )"
                    className="ml-2 h-7 max-w-xs"
                />

                {query ? (
                    <span className="text-xs text-quiet">
                        <span className="tnum">{filtered.length}</span> of{" "}
                        <span className="tnum">{monitors.length}</span>
                    </span>
                ) : null}

                <div className="ml-auto flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => navigate("/superboard")}>
                        Superboard
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                            setDetailId(null);
                            setUsersOpen((v) => !v);
                        }}
                    >
                        Users
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                            setDetailId(null);
                            setAgentsOpen((v) => !v);
                        }}
                    >
                        Agents
                    </Button>
                    <Button size="sm" onClick={() => setFormState({ mode: "create" })}>
                        New monitor
                    </Button>
                    {selected.size > 0 ? (
                        <>
                            <span className="text-xs text-quiet">
                                <span className="tnum">{selected.size}</span> selected
                            </span>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => void applyToSelection("pause")}
                            >
                                Pause
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => void applyToSelection("resume")}
                            >
                                Resume
                            </Button>
                            <Button
                                variant="destructive"
                                size="sm"
                                disabled={busy}
                                onClick={() => void applyToSelection("delete")}
                            >
                                Delete
                            </Button>
                        </>
                    ) : null}
                    <Button
                        variant="ghost"
                        size="sm"
                        title="Forget token"
                        onClick={() => {
                            setToken(null);
                            setAuthed(false);
                        }}
                    >
                        Disconnect
                    </Button>
                </div>
            </header>

            {health ? <HealthStrip health={health} /> : null}

            {error ? (
                <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
                    {error}
                </div>
            ) : null}

            {usersOpen ? (
                <UsersPanel
                    onClose={() => {
                        setUsersOpen(false);
                        void load();
                    }}
                />
            ) : agentsOpen ? (
                <AgentPanel
                    onClose={() => {
                        setAgentsOpen(false);
                        void load();
                    }}
                />
            ) : detailId !== null ? (
                <MonitorDetail
                    id={detailId}
                    onBack={() => {
                        setDetailId(null);
                        void load();
                    }}
                    onEdit={(monitor) => setFormState({ mode: "edit", monitor })}
                />
            ) : filtered.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-quiet">
                    {monitors.length === 0 ? "No monitors yet." : "Nothing matches that search."}
                </p>
            ) : (
                <MonitorTable
                    monitors={filtered}
                    selected={selected}
                    onToggle={(id) =>
                        setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(id)) {
                                next.delete(id);
                            } else {
                                next.add(id);
                            }
                            return next;
                        })
                    }
                    onEdit={(id) => {
                        setAgentsOpen(false);
                        setUsersOpen(false);
                        setDetailId(id);
                    }}
                />
            )}

            {formState ? (
                <div
                    className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
                    onClick={() => setFormState(null)}
                >
                    <div
                        className="mt-8 w-full max-w-2xl rounded-lg border border-border bg-card p-5"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h2 className="mb-4 text-base font-semibold">
                            {formState.mode === "create" ? "New monitor" : `Edit ${formState.monitor.name}`}
                        </h2>
                        <MonitorForm
                            initial={formState.mode === "edit" ? formState.monitor : null}
                            onSaved={() => {
                                setFormState(null);
                                void load();
                            }}
                            onCancel={() => setFormState(null)}
                        />
                    </div>
                </div>
            ) : null}
        </div>
    );
}

/**
 * Application root.
 *
 * Four routes: the monitor table at "/", the wall board at "/superboard",
 * the chrome-free board at "/superboard/kiosk", and invite redemption at
 * "/invite/:token". The route is resolved before either view mounts, so the
 * dashboard's polling never runs while the board is open.
 */
export default function App() {
    const path = usePath();
    const inviteToken = inviteTokenFrom(path);

    if (path === "/superboard" || path === "/superboard/kiosk") {
        return <SuperboardApp kiosk={path === "/superboard/kiosk"} />;
    }

    return <Dashboard inviteToken={inviteToken} />;
}
