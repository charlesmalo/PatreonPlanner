import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { useCreator } from '../api/hooks';
import type { StaffList, StaffMember, StaffPermission } from '../api/types';

/** Named for what they let someone do, not for the enum. */
const PERMISSIONS: Array<[StaffPermission, string]> = [
  ['MOVE_ENTRIES', 'Move entries'],
  ['EDIT_ENTRIES', 'Edit entries'],
  ['HANDLE_REPORTS', 'Handle reports'],
  ['WRITE_NOTES', 'Write notes'],
  ['MANAGE_THEMES', 'Manage themes'],
  // Deciding who may read the board is a bigger power than running its queue, which is why it is
  // grantable rather than implied by being staff.
  ['MANAGE_POLICY', 'Change board settings'],
];

export function StaffPage() {
  const { slug = '' } = useParams();
  const { creator } = useCreator(slug);
  const [staff, setStaff] = useState<StaffList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const path = `/creators/${encodeURIComponent(slug)}/staff`;

  useEffect(() => {
    let cancelled = false;
    api
      .get<StaffList>(path)
      .then((value) => !cancelled && setStaff(value))
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err : new ApiError(0));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  async function invite() {
    setBusy(true);
    setMessage(null);
    try {
      const created = await api.post<{ token: string }>(`${path}/invites`);
      // Refresh the pending list so the new invite is revocable straight away.
      api
        .get<StaffList>(path)
        .then(setStaff)
        .catch(() => undefined);
      // The token goes in the *fragment*, never the path. A fragment is not sent to the server,
      // so it stays out of nginx's access log, out of any Referer header, and out of every proxy
      // in between — otherwise storing only its hash would be pointless, since the log would hold
      // a live, redeemable credential for the whole seven days.
      setInviteLink(`${window.location.origin}/invite#${created.token}`);
    } catch (err) {
      setMessage(
        err instanceof ApiError && err.status === 409
          ? 'There are too many invitations outstanding. Revoke one first.'
          : 'Could not create an invitation. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Without this the 409 above tells an owner to "revoke one first" with nothing anywhere to
   * revoke with — and since invites live seven days, ten of them locks inviting for a week.
   */
  async function revoke(inviteId: string) {
    setBusy(true);
    setMessage(null);
    try {
      await api.del(`${path}/invites/${inviteId}`);
      setStaff((current) =>
        current
          ? { ...current, invites: current.invites.filter((i) => i.id !== inviteId) }
          : current,
      );
      setMessage('That invitation is no longer valid.');
    } catch {
      setMessage('Could not revoke that invitation. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function togglePermission(member: StaffMember, permission: StaffPermission, on: boolean) {
    // The whole set, not a change to it: the API replaces it outright, so two tabs cannot race
    // into a merge nobody asked for.
    const held = member.permissions ?? [];
    const next = on ? [...held, permission] : held.filter((p) => p !== permission);
    setBusy(true);
    setMessage(null);
    try {
      await api.patch(`${path}/${member.userId}/permissions`, { permissions: next });
      setStaff((current) =>
        current
          ? {
              ...current,
              members: current.members.map((m) =>
                m.userId === member.userId ? { ...m, permissions: next } : m,
              ),
            }
          : current,
      );
    } catch {
      // Left as it was rather than showing a checkbox the server disagrees with.
      setMessage('Could not change that. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(member: StaffMember) {
    setBusy(true);
    setMessage(null);
    try {
      await api.del(`${path}/${member.userId}`);
      setStaff((current) =>
        current
          ? { ...current, members: current.members.filter((m) => m.userId !== member.userId) }
          : current,
      );
      setMessage(`${member.fullName ?? 'That person'} is no longer a moderator.`);
    } catch {
      setMessage('Could not remove them. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <p role="status" className="text-slate-600 dark:text-slate-300">
        {error.status === 403 || error.status === 401
          ? 'Only the creator can manage moderators.'
          : 'Could not load the moderators. Try again.'}
      </p>
    );
  }

  if (!staff) return <p role="status">Loading moderators…</p>;

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">
        Moderators{creator ? ` — ${creator.displayName}` : ''}
      </h1>
      <Link
        to={`/c/${encodeURIComponent(slug)}`}
        className="mt-1 inline-block text-sm text-sky-700 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-400"
      >
        Back to the board
      </Link>

      <ul className="mt-6 space-y-2">
        {staff.members.map((member) => (
          <li
            key={member.userId}
            className="rounded border border-slate-200 px-3 py-2 dark:border-slate-800"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm">
                {/* Text, never markup: a display name comes from Patreon. */}
                {member.fullName ?? 'A moderator'}
                <span className="ml-2 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {member.role}
                </span>
              </span>
              {/* No control for the owner: the API refuses, and a button that cannot work is a lie. */}
              {member.role === 'OWNER' ? null : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => remove(member)}
                  aria-label={`Remove ${member.fullName ?? 'this moderator'}`}
                  className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Remove
                </button>
              )}
            </div>
            {/* An owner's row shows nothing to edit: they hold everything by role, and the API
                refuses to write to it. A moderator holding nothing is a real state and says so,
                since otherwise the board offers them work that every action refuses. */}
            {member.role === 'OWNER' ? null : (
              <fieldset className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                <legend className="sr-only">
                  What {member.fullName ?? 'this moderator'} may do
                </legend>
                {PERMISSIONS.map(([value, label]) => (
                  <label key={value} className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={(member.permissions ?? []).includes(value)}
                      disabled={busy}
                      onChange={(event) => togglePermission(member, value, event.target.checked)}
                    />
                    {label}
                  </label>
                ))}
                {(member.permissions ?? []).length === 0 ? (
                  <span className="text-xs text-amber-700 dark:text-amber-300">
                    Cannot do anything yet
                  </span>
                ) : null}
              </fieldset>
            )}
          </li>
        ))}
      </ul>

      <button
        type="button"
        disabled={busy}
        onClick={invite}
        className="mt-4 rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:opacity-50 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-slate-200 dark:text-slate-900"
      >
        Invite a moderator
      </button>

      {staff.invites.length > 0 ? (
        <div className="mt-6">
          <h2 className="text-sm font-medium">Pending invitations</h2>
          <ul className="mt-2 space-y-2">
            {staff.invites.map((pending) => (
              <li
                key={pending.id}
                className="flex items-center justify-between rounded border border-slate-200 px-3 py-2 text-xs dark:border-slate-800"
              >
                <span>Expires {new Date(pending.expiresAt).toLocaleDateString()}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => revoke(pending.id)}
                  aria-label={`Revoke the invitation expiring ${new Date(
                    pending.expiresAt,
                  ).toLocaleDateString()}`}
                  className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-50 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {inviteLink ? (
        <div className="mt-3 rounded border border-slate-200 p-3 dark:border-slate-800">
          <label htmlFor="invite-link" className="block text-xs font-medium">
            Send this link to whoever you want to moderate
          </label>
          <input
            id="invite-link"
            readOnly
            value={inviteLink}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
          />
          {/* The token is returned once and stored only as a hash; nothing can recover it later. */}
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            It will not be shown again. Anyone with this link can moderate this board until it is
            used or expires.
          </p>
        </div>
      ) : null}

      {message ? (
        <p role="status" aria-live="polite" className="mt-2 text-sm">
          {message}
        </p>
      ) : null}
    </section>
  );
}
