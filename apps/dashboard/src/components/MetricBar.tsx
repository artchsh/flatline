import { cn } from "@/lib/utils";

export type BarTone = "ok" | "warn" | "bad" | "muted";

/**
 * Severity bucket for a 0–100 percentage.
 *
 * Thresholds are deliberately conservative: a busy box is not a problem until
 * it is, and a board that cries wolf at 60% gets ignored at 95%.
 * @param percent Usage percentage
 * @returns Tone to render
 */
export function usageTone(percent: number | undefined): BarTone {
    if (percent === undefined || Number.isNaN(percent)) {
        return "muted";
    }
    if (percent >= 90) {
        return "bad";
    }
    if (percent >= 75) {
        return "warn";
    }
    return "ok";
}

const FILL: Record<BarTone, string> = {
    ok: "bg-ok",
    warn: "bg-warn",
    bad: "bg-bad",
    muted: "bg-quiet",
};

/**
 * A labelled usage bar: label, the number, and a proportional fill.
 *
 * The percentage is always printed next to the bar, never conveyed by colour
 * or width alone — width is hard to judge and colour is unreliable for a
 * colourblind operator. The fill is decoration on top of the number.
 */
export function MetricBar({
    label,
    percent,
    detail,
    tone,
}: {
    label: string;
    percent: number | undefined;
    detail?: string;
    tone?: BarTone;
}) {
    const safe = percent === undefined || Number.isNaN(percent) ? null : Math.max(0, Math.min(100, percent));
    const resolved = tone ?? usageTone(percent ?? undefined);

    return (
        <div>
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
                <span className="tnum text-sm font-semibold">
                    {safe === null ? "—" : `${safe.toFixed(safe < 10 ? 1 : 0)}%`}
                    {detail ? <span className="ml-2 text-xs font-normal text-quiet">{detail}</span> : null}
                </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2">
                <div
                    className={cn("h-full rounded-full transition-[width] duration-500", FILL[resolved])}
                    style={{ width: safe === null ? "0%" : `${safe}%` }}
                />
            </div>
        </div>
    );
}
