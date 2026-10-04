import { cookies } from "next/headers";
import { fetchStatusPage, NotFoundError, PasswordRequiredError } from "@flatline/shared";
import { StatusPageView } from "../../_components/status-page-view";
import { UnlockForm } from "../../unlock-form";

/**
 * Origin of the Flatline server. This app renders in front of it rather than
 * replacing it.
 */
const BASE_URL = process.env.FLATLINE_URL ?? "http://localhost:3001";

// Always dynamic: the page depends on live heartbeats and on the caller's
// unlock cookie, so it must never be prerendered or cached.
export const dynamic = "force-dynamic";

/**
 * Render a status page by slug.
 *
 * A server component on purpose: every read endpoint is password gated, so the
 * fetch has to happen here with the unlock cookie forwarded. A client render
 * would either flash the page before auth or expose the data.
 */
export default async function Page(props: { params: Promise<{ slug: string }> }) {
    const { slug } = await props.params;
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
