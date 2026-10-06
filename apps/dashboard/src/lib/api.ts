/**
 * Client for the Flatline REST API v1.
 *
 * The dashboard runs in the browser (the API is same-origin or CORS-enabled),
 * so it holds a bearer token rather than a session cookie. That is the same
 * token shape an agent uses, which keeps one auth model instead of two.
 */

const BASE = (import.meta.env.VITE_FLATLINE_URL as string | undefined) ?? "";

const TOKEN_KEY = "flatline.token";

/**
 * Read the operator's token from local storage.
 * @returns The token, or null
 */
export function getToken(): string | null {
    try {
        return window.localStorage.getItem(TOKEN_KEY);
    } catch {
        return null;
    }
}

/**
 * Persist the operator's token.
 * @param token Token to store, or null to forget it
 */
export function setToken(token: string | null): void {
    try {
        if (token) {
            window.localStorage.setItem(TOKEN_KEY, token);
        } else {
            window.localStorage.removeItem(TOKEN_KEY);
        }
    } catch {
        // Storage can be unavailable (private mode); the app still works for
        // the current session, the token just will not persist.
    }
}

export interface ApiErrorBody {
    ok: false;
    error: string;
    message: string;
}

/** Error carrying the API's machine-readable code. */
export class ApiError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
    }
}

/**
 * Perform an authenticated request.
 * @param path API path, e.g. "/api/v1/monitors"
 * @param init Fetch options
 * @returns Parsed body
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = getToken();

    const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            Accept: "application/json",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...init.headers,
        },
    });

    if (!response.ok) {
        let body: Partial<ApiErrorBody> = {};
        try {
            body = await response.json();
        } catch {
            // Non-JSON error body; fall back to the status.
        }
        throw new ApiError(response.status, body.error ?? "unknown", body.message ?? response.statusText);
    }

    return await response.json() as T;
}

export interface MonitorSummary {
    id: number;
    name: string;
    type: string;
    url: string | null;
    status: number;
    ping: number | null;
    lastCheck: string | null;
    lastMessage: string | null;
    active: boolean;
    interval: number;
    uptime24h: number | null;
    uptime7d: number | null;
    uptime30d: number | null;
    tags?: { id: number; name: string; color: string }[];
}

export interface HealthSummary {
    total: number;
    up: number;
    down: number;
    pending: number;
    maintenance: number;
    paused: number;
    status: "up" | "down";
    downMonitors: { id: number; name: string; url: string | null }[];
}

export interface Pagination {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
}

/**
 * Fetch the aggregate health summary.
 * @returns Health counts for every monitor
 */
export function fetchHealth(): Promise<{ ok: true; health: HealthSummary }> {
    return request("/api/v1/health");
}

/**
 * Fetch monitors.
 * @param params Optional filters
 * @returns Monitors plus pagination metadata
 */
export function fetchMonitors(params: { status?: string; q?: string; page?: number; perPage?: number } = {}): Promise<{
    ok: true;
    count: number;
    monitors: MonitorSummary[];
    pagination: Pagination;
}> {
    const query = new URLSearchParams();
    for (const [ key, value ] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
            query.set(key, String(value));
        }
    }

    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request(`/api/v1/monitors${suffix}`);
}

/**
 * Pause a monitor.
 * @param id Monitor id
 * @returns The updated monitor
 */
export function pauseMonitor(id: number): Promise<{ ok: true; monitor: MonitorSummary }> {
    return request(`/api/v1/monitors/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: false }),
    });
}

/**
 * Resume a monitor.
 * @param id Monitor id
 * @returns The updated monitor
 */
export function resumeMonitor(id: number): Promise<{ ok: true; monitor: MonitorSummary }> {
    return request(`/api/v1/monitors/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: true }),
    });
}
