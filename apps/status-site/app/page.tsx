import { headers } from "next/headers";
import { cookies } from "next/headers";
import { fetchStatusPage, NotFoundError, PasswordRequiredError } from "@flatline/shared";
import { StatusPageView } from "./_components/status-page-view";
import { UnlockForm } from "./unlock-form";

/**
 * Origin of the Flatline server.
 */
const BASE_URL = process.env.FLATLINE_URL ?? "http://localhost:3001";

export const dynamic = "force-dynamic";

/**
 * Resolve this request's hostname to a slug.
 *
 * Lets status.client-a.kz render the right page with no path. The domain map
 * lives only on the Flatline server, so ask it rather than keeping a second
 * copy here. Returns the slug only, never page content.
 */
async function slugFromHost(): Promise<string | null> {
    const h = await headers();
    const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(":")[0].trim().toLowerCase();

    if (!host) {
        return null;
    }

    try {
        const res = await fetch(`${BASE_URL}/api/status-page/resolve-host?host=${encodeURIComponent(host)}`, {
            cache: "no-store",
        });

        if (!res.ok) {
            return null;
        }

        const body = await res.json() as { slug: string | null };
        return body.slug;
    } catch {
        return null;
    }
}

/**
 * Host-routed status page.
 */
export default async function Page() {
    const slug = await slugFromHost();

    if (!slug) {
        return (
            <div className="wrap">
                <h1 className="site-title">Status</h1>
                <p className="site-description">
                    This address is not mapped to a status page.
                </p>
            </div>
        );
    }

    const cookieHeader = (await cookies()).toString();

    try {
        const snapshot = await fetchStatusPage(BASE_URL, slug, { cookie: cookieHeader });
        return (
            <StatusPageView
                data={snapshot.data}
                heartbeats={snapshot.heartbeats}
                history={snapshot.history}
            />
        );
    } catch (error) {
        if (error instanceof PasswordRequiredError) {
            return <UnlockForm slug={slug} />;
        }

        if (error instanceof NotFoundError) {
            return (
                <div className="wrap">
                    <p className="site-description">No status page found.</p>
                </div>
            );
        }

        throw error;
    }
}
