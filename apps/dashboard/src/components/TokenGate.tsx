import { useState } from "react";
import type { SyntheticEvent } from "react";
import { ApiError, fetchHealth, setToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Token gate. Both the dashboard and the Superboard are useless without a
 * token, so each asks for one up front rather than showing an empty view and a
 * wall of 401s.
 *
 * The token is validated against /health before it is persisted, so a typo
 * fails here and not on every subsequent request.
 */
export function TokenGate({ onSaved }: { onSaved: () => void }) {
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);

    async function submit(event: SyntheticEvent) {
        event.preventDefault();
        setError(null);
        setToken(value.trim());

        try {
            await fetchHealth();
            onSaved();
        } catch (e) {
            setToken(null);
            setError(e instanceof ApiError ? e.message : "Could not reach the Flatline server.");
        }
    }

    return (
        <div className="flex min-h-screen items-center justify-center p-6">
            <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
                <h1 className="m-0 text-base font-semibold">Flatline</h1>
                <p className="mt-1 mb-4 text-xs text-muted-foreground">
                    Paste an API token. Create one under Settings → API Keys, or give the dashboard a
                    read-only token if it only needs to look.
                </p>

                {error ? (
                    <div className="mb-3 rounded-md bg-destructive/12 px-2.5 py-2 text-xs text-destructive">{error}</div>
                ) : null}

                <Input
                    type="password"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="uk1_…"
                    autoComplete="off"
                    autoFocus
                    required
                />

                <Button type="submit" className="mt-3 w-full">
                    Connect
                </Button>
            </form>
        </div>
    );
}
