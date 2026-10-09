import { cn } from "@/lib/utils";
import { usageTone } from "@/components/MetricBar";

const SQUARE: Record<ReturnType<typeof usageTone>, string> = {
    ok: "bg-ok",
    warn: "bg-warn",
    bad: "bg-bad",
    muted: "bg-quiet",
};

/**
 * One filled square per unit (CPU thread, GPU): green → red by load.
 *
 * Squares are deliberately number-free at a glance — twenty numbers would be
 * noise, not signal. The numbers live in two places instead: a tooltip per
 * square with the exact value, and a peak figure printed next to the total
 * by the caller. Colour alone would strand a colourblind operator; the peak
 * number is the mitigation that survives the wall.
 */
export function CoreSquares({ values, label }: { values?: number[]; label: string }) {
    if (!values || values.length === 0) {
        return null;
    }

    return (
        <div
            className="core-squares flex flex-wrap gap-1.5"
            role="img"
            aria-label={`${label} loads: ${values.map((v, i) => `${i}: ${Number.isFinite(v) ? `${Math.round(v)}%` : "unknown"}`).join(", ")}`}
        >
            {values.map((value, i) => {
                const safe = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
                return (
                    <div
                        key={i}
                        title={`${label} ${i}: ${Number.isFinite(value) ? `${safe.toFixed(1)}%` : "unknown"}`}
                        className={cn("core-square size-4 rounded-[3px] transition-opacity duration-300 motion-reduce:transition-none", SQUARE[usageTone(value)])}
                        style={{ opacity: Number.isFinite(value) ? 0.18 + safe / 100 * 0.82 : 0.18 }}
                    />
                );
            })}
        </div>
    );
}
