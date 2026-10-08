import type { MonitorSummary, MetricsPayload } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { MetricBar, usageTone } from "@/components/MetricBar";

export interface FleetServer {
    monitor: MonitorSummary;
    time: string;
    metrics: MetricsPayload;
}

/**
 * Render a byte count compactly.
 * @param bytes Byte count, or undefined
 * @returns e.g. "12.4 GB"
 */
export function formatBytes(bytes: number | undefined): string {
    if (bytes === undefined || Number.isNaN(bytes)) {
        return "—";
    }
    const units = [ "B", "KB", "MB", "GB", "TB", "PB" ];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Relative age of a timestamp, or "—".
 * @param value Timestamp from the API (UTC, space-separated)
 * @returns e.g. "12s", "3m", "2h"
 */
export function ageOf(value: string | null | undefined): string {
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

/**
 * The fullest mount, or undefined when the payload carried none.
 * @param disks Disk entries from a sample
 * @returns The disk with the highest usage percentage
 */
function fullestDisk(disks: MetricsPayload["disk"]) {
    if (!disks || disks.length === 0) {
        return undefined;
    }
    return disks.reduce((worst, disk) => ((disk.percent ?? -1) > (worst.percent ?? -1) ? disk : worst));
}

/**
 * One server on the wall board.
 *
 * Sized for reading across a room: the hostname and the numbers are large, the
 * bars are secondary. Everything degrades gracefully — a server that has not
 * reported in a while dims rather than disappearing, because "missing" and
 * "quietly broken" must not look the same.
 */
export function FleetCard({ server }: { server: FleetServer }) {
    const { monitor, metrics, time } = server;
    const status = statusOf(monitor.status);

    const hostname = metrics.host?.hostname || monitor.name;
    const cpu = metrics.cpu;
    const mem = metrics.mem;
    const disk = fullestDisk(metrics.disk);
    const gpu = metrics.gpu;

    // A sample older than two intervals means the agent has missed at least
    // one beat: the monitor is about to (or already did) go down. Show the
    // last numbers but make clear they are stale.
    const ageMs = Date.now() - new Date(time.replace(" ", "T") + (time.includes("Z") ? "" : "Z")).getTime();
    const stale = Number.isFinite(ageMs) && ageMs > (monitor.interval || 60) * 2 * 1000;

    const containers = metrics.docker ?? [];
    const running = containers.filter((c) => c.state === "running");
    const unhealthy = containers.filter((c) => c.health !== undefined && c.health !== "healthy");
    const stopped = containers.length - running.length;
    const troubled = new Set([ ...unhealthy, ...containers.filter((c) => c.health === undefined && c.state === "restarting") ]);
    const troubledNames = [ ...troubled ].map((c) => c.name ?? "?");

    return (
        <div
            data-stale={stale || undefined}
            className="flex h-full min-h-[13rem] flex-col gap-3 rounded-lg border border-border bg-card p-4 data-[stale]:opacity-60"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="truncate text-lg leading-tight font-semibold" title={hostname}>
                        {hostname}
                    </h2>
                    <p className="mt-0.5 truncate text-xs text-quiet">
                        {metrics.host?.os ?? monitor.type}
                        {cpu?.cores ? ` · ${cpu.cores} cores` : ""}
                        {metrics.host?.uptime !== undefined ? ` · up ${ageOf(new Date(Date.now() - metrics.host.uptime * 1000).toISOString())}` : ""}
                    </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone={status.tone}>
                        <span className="size-1.5 rounded-full bg-current" />
                        {status.label}
                    </Badge>
                    <span className="tnum text-[11px] text-quiet">{ageOf(time)}</span>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-2.5">
                <MetricBar
                    label="CPU"
                    percent={cpu?.percent}
                    tone={cpu?.percent === undefined ? "muted" : usageTone(cpu.percent)}
                />
                <MetricBar
                    label="RAM"
                    percent={mem?.percent}
                    detail={mem ? `${formatBytes(mem.used)} / ${formatBytes(mem.total)}` : undefined}
                />
                <MetricBar
                    label={disk ? `Disk ${disk.mount}` : "Disk"}
                    percent={disk?.percent}
                    detail={disk ? `${formatBytes(disk.used)} / ${formatBytes(disk.total)}` : "no mounts reported"}
                />
                {gpu?.available ? (
                    <MetricBar
                        label={`GPU${gpu.name ? ` ${gpu.name}` : ""}`}
                        percent={gpu.util}
                        detail={[
                            gpu.memTotal !== undefined ? `${formatBytes(gpu.memUsed)} / ${formatBytes(gpu.memTotal)}` : null,
                            gpu.temp !== undefined ? `${Math.round(gpu.temp)}°C` : null,
                        ]
                            .filter(Boolean)
                            .join(" · ")}
                    />
                ) : null}
            </div>

            <div className="mt-auto flex items-baseline justify-between gap-2 border-t border-border/60 pt-2 text-xs">
                <span className="truncate text-quiet" title={troubledNames.join(", ")}>
                    {containers.length === 0 ? (
                        "no containers"
                    ) : (
                        <>
                            <span className="tnum">{running.length}</span>/{containers.length} containers up
                            {unhealthy.length > 0 ? (
                                <span className="ml-1 font-semibold text-bad">· {unhealthy.length} unhealthy</span>
                            ) : stopped > 0 ? (
                                <span className="ml-1 text-quiet">· {stopped} stopped</span>
                            ) : null}
                        </>
                    )}
                </span>
                {stale ? <span className="shrink-0 font-semibold text-warn">stale</span> : null}
            </div>
        </div>
    );
}
