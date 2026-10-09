import type { MonitorSummary, MetricsPayload } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { CoreSquares } from "@/components/CoreSquares";
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

/**
 * Format a duration in seconds compactly.
 * @param seconds Duration, or undefined
 * @returns e.g. "3d", or null when unknown
 */
export function formatDuration(seconds: number | undefined): string | null {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
        return null;
    }
    if (seconds < 60) {
        return `${Math.round(seconds)}s`;
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
 * A temperature chip, or nothing.
 *
 * Zero and absent both mean "no sensor" — VPS boxes report neither, and a
 * 0°C chip would be a lie. The caller passes the raw value; this decides.
 * @param temp Celsius, or undefined
 * @returns e.g. "68°C", or null
 */
function tempChip(temp: number | undefined): string | null {
    if (temp === undefined || !Number.isFinite(temp) || temp <= 0) {
        return null;
    }
    return `${Math.round(temp)}°C`;
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

    // New agents send every GPU; old ones send only the scalar first-GPU
    // fields. Normalise to a list so the render has one shape.
    const gpu = metrics.gpu;
    const gpus = gpu?.gpus?.length
        ? gpu.gpus
        : gpu?.available
          ? [{ name: gpu.name, util: gpu.util, memUsed: gpu.memUsed, memTotal: gpu.memTotal, temp: gpu.temp }]
          : [];

    // Peak core carries the numbers the squares cannot: twenty tooltips do
    // not survive the wall, one peak figure does.
    const peak =
        cpu?.perCore?.length ? Math.max(...cpu.perCore.filter((v) => Number.isFinite(v))) : undefined;

    const cpuTemp = tempChip(cpu?.temp);
    const memTemp = tempChip(mem?.temp);

    // A sample older than two intervals means the agent has missed at least
    // one beat: the monitor is about to (or already did) go down. Show the
    // last numbers but make clear they are stale.
    const ageMs = Date.now() - new Date(time.replace(" ", "T") + (time.includes("Z") ? "" : "Z")).getTime();
    const stale = Number.isFinite(ageMs) && ageMs > (monitor.interval || 60) * 2 * 1000;

    const containers = metrics.docker ?? [];
    const dockerError = metrics.dockerError;
    const running = containers.filter((c) => c.state === "running");
    const unhealthy = containers.filter((c) => c.health !== undefined && c.health !== "healthy");

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
                <div>
                    <MetricBar
                        label="CPU"
                        percent={cpu?.percent}
                        tone={cpu?.percent === undefined ? "muted" : usageTone(cpu.percent)}
                        detail={[
                            peak !== undefined && Number.isFinite(peak) ? `peak ${Math.round(peak)}%` : null,
                            cpuTemp,
                        ]
                            .filter(Boolean)
                            .join(" · ")}
                    />
                    {cpu?.perCore && cpu.perCore.length > 0 ? (
                        <div className="mt-1.5">
                            <CoreSquares values={cpu.perCore} label="core" />
                        </div>
                    ) : null}
                </div>
                <MetricBar
                    label="RAM"
                    percent={mem?.percent}
                    detail={[
                        mem ? `${formatBytes(mem.used)} / ${formatBytes(mem.total)}` : null,
                        memTemp,
                    ]
                        .filter(Boolean)
                        .join(" · ")}
                />
                <MetricBar
                    label={disk ? `Disk ${disk.mount}` : "Disk"}
                    percent={disk?.percent}
                    detail={disk ? `${formatBytes(disk.used)} / ${formatBytes(disk.total)}` : "no mounts reported"}
                />
                {gpus.map((g, i) => {
                    const gpuName = g.name ?? (gpus.length > 1 ? `GPU ${i}` : "GPU");
                    const gpuTemp = tempChip(g.temp);
                    return (
                        <div key={i}>
                            <div className="flex items-baseline justify-between gap-2">
                                <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                                    {gpuName}
                                </span>
                                <span className="tnum text-sm font-semibold">
                                    {g.util === undefined || Number.isNaN(g.util) ? "—" : `${Math.round(g.util)}%`}
                                    {gpuTemp ? <span className="ml-2 text-xs font-normal text-quiet">{gpuTemp}</span> : null}
                                </span>
                            </div>
                            <div className="mt-1.5">
                                <CoreSquares values={g.util !== undefined ? [g.util] : []} label={gpuName} />
                            </div>
                            {g.memTotal !== undefined ? (
                                <div className="mt-1.5">
                                    <MetricBar
                                        label="VRAM"
                                        percent={
                                            g.memUsed !== undefined
                                                ? (g.memUsed / g.memTotal) * 100
                                                : undefined
                                        }
                                        detail={`${formatBytes(g.memUsed)} / ${formatBytes(g.memTotal)}`}
                                    />
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>

            <div className="mt-auto border-t border-border/60 pt-2">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        Containers
                    </span>
                    {containers.length > 0 ? (
                        <span className="text-xs text-quiet">
                            <span className="tnum">{running.length}</span>/{containers.length} up
                            {unhealthy.length > 0 ? (
                                <span className="ml-1 font-semibold text-bad">· {unhealthy.length} unhealthy</span>
                            ) : null}
                        </span>
                    ) : null}
                </div>
                {containers.length === 0 ? (
                    dockerError ? (
                        <p className="text-xs font-semibold text-warn" title={dockerError}>
                            containers unavailable
                        </p>
                    ) : (
                        <p className="text-xs text-quiet">no containers</p>
                    )
                ) : (
                    <ul className="max-h-28 space-y-1 overflow-y-auto">
                        {containers.map((c) => {
                            // Uptime counts only while running: a stopped
                            // container "started 8d ago" is not "up 8d".
                            const up = c.state === "running" ? formatDuration(c.uptime) : null;
                            const tone =
                                c.state === "running" && (c.health === undefined || c.health === "healthy")
                                    ? "text-ok"
                                    : c.state === "running"
                                      ? "text-bad"
                                      : "text-quiet";
                            return (
                                <li key={c.name ?? c.image} className="flex items-baseline gap-2 text-xs">
                                    <span className="min-w-0 flex-1 truncate font-medium" title={c.image ?? undefined}>
                                        {c.name ?? "?"}
                                    </span>
                                    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap ${tone}`}>
                                        <span className="size-1.5 rounded-full bg-current" />
                                        {c.state ?? "?"}
                                        {c.health !== undefined && c.health !== "healthy" ? ` (${c.health})` : ""}
                                    </span>
                                    <span className="tnum w-10 shrink-0 text-right whitespace-nowrap text-quiet">
                                        {up ? `up ${up}` : "—"}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                )}
                {stale ? <p className="mt-1 text-xs font-semibold text-warn">stale</p> : null}
            </div>
        </div>
    );
}
