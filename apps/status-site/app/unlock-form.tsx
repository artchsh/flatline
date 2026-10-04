"use client";

import { useState } from "react";

/**
 * Password prompt for a protected status page.
 *
 * Posts to the Flatline server, which sets the unlock cookie and redirects
 * back. Kept as a component rather than a Next route handler so the cookie
 * lands on the origin that actually serves the page, which is why the form
 * is server-relative rather than pointing at this app.
 */
export function UnlockForm({ slug, error: initialError }: { slug: string; error?: string | null }) {
    const [error, setError] = useState<string | null>(initialError ?? null);
    const [pending, setPending] = useState(false);

    const base = process.env.NEXT_PUBLIC_FLATLINE_URL ?? "";

    async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);

        const form = new FormData(event.currentTarget);
        const password = String(form.get("password") ?? "");

        try {
            const response = await fetch(`${base}/api/v1/status-pages/unlock/${encodeURIComponent(slug)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password }),
                credentials: "include",
                redirect: "manual",
            });

            if (response.status === 401) {
                setError("That password is not correct.");
                setPending(false);
                return;
            }

            // 302 from the server means the cookie is set; reload to render it.
            window.location.reload();
        } catch {
            setError("Could not reach the status server.");
            setPending(false);
        }
    }

    return (
        <div className="wrap">
            <form className="unlock" onSubmit={onSubmit}>
                <h1>This status page is private</h1>
                <p className="sub">Enter the password you were given.</p>

                {error ? <div className="error">{error}</div> : null}

                <input
                    type="password"
                    name="password"
                    placeholder="Password"
                    autoComplete="current-password"
                    autoFocus
                    required
                />
                <button type="submit" disabled={pending}>
                    {pending ? "Checking…" : "Unlock"}
                </button>
            </form>
        </div>
    );
}
