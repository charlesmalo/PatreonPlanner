import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { useCreator } from '../api/hooks';
import type { StaffList, StaffMember } from '../api/types';

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
      // Built here rather than returned by the API: the API does not know what origin the SPA is
      // served from, and a link is what the creator actually needs to send.
      setInviteLink(`${window.location.origin}/invite/${created.token}`);
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
            className="flex items-center justify-between rounded border border-slate-200 px-3 py-2 dark:border-slate-800"
          >
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
