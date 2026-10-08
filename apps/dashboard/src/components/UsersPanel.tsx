import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import {
    createInvite,
    deleteUser,
    fetchInvites,
    fetchUsers,
    revokeInvite,
    setUserBanned,
    type InviteSummary,
    type UserSummary,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Accounts and invite links.
 *
 * Flatline has no roles: every operator sees the same panel and can manage
 * the same accounts. Deleting an account never touches shared data
 * (monitors, notifications, maintenance) — only the account, its sessions
 * and the invites it minted.
 */
export function UsersPanel({ onClose }: { onClose: () => void }) {
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [invites, setInvites] = useState<InviteSummary[]>([]);
    const [note, setNote] = useState("");
    const [freshInvite, setFreshInvite] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);

    async function load() {
        try {
            const [u, i] = await Promise.all([fetchUsers(), fetchInvites()]);
            setUsers(u.users);
            setInvites(i.invites);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not load accounts.");
        }
    }

    useEffect(() => {
        void load();
    }, []);

    async function mint(event: SyntheticEvent) {
        event.preventDefault();
        setError(null);
        setFreshInvite(null);
        setBusy(true);
        try {
            const res = await createInvite(note.trim() ? { note: note.trim() } : {});
            // The link is the dashboard invite route with the token appended:
            // anyone opening it gets the redeem form, no account needed.
            setFreshInvite(`${window.location.origin}/invite/${res.token}`);
            setNote("");
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not create the invite.");
        } finally {
            setBusy(false);
        }
    }

    async function copy(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            setError("Copy failed — select the link manually.");
        }
    }

    async function ban(user: UserSummary) {
        if (user.isCurrent) {
            return;
        }
        setError(null);
        try {
            await setUserBanned(user.id, !user.banned);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not change the ban.");
        }
    }

    async function remove(user: UserSummary) {
        if (user.isCurrent) {
            return;
        }
        if (!window.confirm(`Remove ${user.username ?? user.name}? Their sessions end immediately. Shared monitors are untouched.`)) {
            return;
        }
        setError(null);
        try {
            await deleteUser(user.id);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not remove the account.");
        }
    }

    async function revoke(id: number) {
        setError(null);
        try {
            await revokeInvite(id);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not revoke the invite.");
        }
    }

    return (
        <div className="border-b border-border px-4 py-4">
            <div className="mb-3 flex items-center gap-2">
                <h2 className="text-sm font-semibold">Users</h2>
                <span className="text-xs text-quiet">
                    <span className="tnum">{users.length}</span> accounts
                </span>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
                    Close
                </Button>
            </div>

            {error ? (
                <div className="mb-3 rounded-md bg-destructive/12 px-2.5 py-2 text-xs text-destructive">{error}</div>
            ) : null}

            <ul className="mb-4 divide-y divide-border/60">
                {users.map((user) => (
                    <li key={user.id} className="flex items-center gap-2 py-1.5 text-sm">
                        <span className="font-medium">{user.username ?? user.name}</span>
                        {user.isCurrent ? <span className="text-xs text-quiet">(you)</span> : null}
                        {user.banned ? <Badge tone="down">banned</Badge> : null}
                        {!user.isCurrent ? (
                            <span className="ml-auto flex gap-1">
                                <Button size="sm" variant="outline" onClick={() => void ban(user)}>
                                    {user.banned ? "Unban" : "Ban"}
                                </Button>
                                <Button size="sm" variant="destructive" onClick={() => void remove(user)}>
                                    Remove
                                </Button>
                            </span>
                        ) : null}
                    </li>
                ))}
            </ul>

            <h3 className="mb-2 text-sm font-semibold">Invite links</h3>
            <p className="mb-2 text-xs text-muted-foreground">
                Single-use, expire after 24 hours. Send the link over any channel — the recipient chooses
                their own username and password.
            </p>

            {freshInvite ? (
                <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-2">
                    <code className="tnum min-w-0 flex-1 truncate text-xs">{freshInvite}</code>
                    <Button size="sm" variant="outline" onClick={() => void copy(freshInvite)}>
                        {copied ? "Copied" : "Copy"}
                    </Button>
                </div>
            ) : null}

            <form onSubmit={mint} className="mb-2 flex gap-2">
                <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Note (optional, e.g. who it is for)"
                    className="h-7 max-w-xs"
                    maxLength={255}
                />
                <Button size="sm" type="submit" disabled={busy}>
                    New invite
                </Button>
            </form>

            {invites.length > 0 ? (
                <ul className="divide-y divide-border/60">
                    {invites.map((invite) => (
                        <li key={invite.id} className="flex items-center gap-2 py-1.5 text-xs">
                            <span className="text-quiet">#{invite.id}</span>
                            <span className="truncate">{invite.note ?? "no note"}</span>
                            <Badge tone={invite.status === "active" ? "up" : "neutral"}>{invite.status}</Badge>
                            {invite.status === "active" ? (
                                <Button size="sm" variant="outline" className="ml-auto" onClick={() => void revoke(invite.id)}>
                                    Revoke
                                </Button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-xs text-quiet">No outstanding invites.</p>
            )}
        </div>
    );
}
