import { useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * The signing secret Patreon uses for this board's webhook.
 *
 * `PUT webhook-secret` has existed since Phase 1 and nothing called it, so per-creator webhooks
 * were dead in production: without a secret the signature guard rejects **every** delivery, and
 * membership changes arrived only from the periodic sync job. Nothing visibly failed — the board
 * simply updated more slowly than it should — which is why it went unnoticed.
 *
 * Owner-only, matching the API. Whoever holds this secret can forge membership events, minting
 * active-patron status at any pledge for anyone on the campaign.
 */
export function WebhookSecret({ creatorId }: { creatorId: string }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const path = `/creators/${creatorId}/webhook-secret`;

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ configured: boolean }>(path)
      .then((body) => !cancelled && setConfigured(body?.configured === true))
      .catch(() => !cancelled && setConfigured(null));
    return () => {
      cancelled = true;
    };
  }, [path]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    // Not sent empty: the API takes 1 to 256 characters, and a blank submit is a slip rather than
    // a request to clear it — there is no way to clear it here on purpose.
    if (secret.trim() === '') return;
    setMessage(null);
    try {
      await api.put(path, { secret: secret.trim() });
      setConfigured(true);
      // Cleared rather than left in the field. Nothing echoes a secret back, and a value sitting
      // in an input is a value on somebody's screen.
      setSecret('');
      setMessage('Saved.');
    } catch {
      setMessage('That did not save. Nothing changed.');
    }
  }

  // The board's own id is in the URL, and a creator has no other way to learn it — the secret
  // field alone would leave them unable to finish, with nowhere to point the webhook.
  //
  // At the **root**, not under `/api/v1`: webhook paths are excluded from the global prefix on
  // purpose, because the URL is registered with Patreon and must not move when the API version
  // does. Getting this wrong is the exact failure this whole section exists to prevent — every
  // delivery would fail, and nothing would look broken.
  const deliveryUrl = `${window.location.origin}/webhooks/patreon/${creatorId}`;

  return (
    <div className="mt-3">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Patreon signs each webhook with a secret from your developer portal. Register it here and
        membership changes reach the board as they happen rather than at the next sync.
      </p>

      <p className="mt-3 text-sm font-medium">Send the webhook to</p>
      <code className="mt-1 block overflow-x-auto rounded border border-slate-200 px-2 py-1 text-xs dark:border-slate-800">
        {deliveryUrl}
      </code>

      <p className="mt-3 text-sm">
        {configured === null ? (
          <span className="text-slate-600 dark:text-slate-300">
            Whether a secret is set could not be read.
          </span>
        ) : configured ? (
          // Not a masked value: any prefix of a secret is a head start, so there is nothing safe
          // to show. Whether one exists is the only fact needed here.
          <span className="text-slate-600 dark:text-slate-300">
            A secret is set. Saving another replaces it.
          </span>
        ) : (
          <span className="text-slate-600 dark:text-slate-300">
            <span className="font-medium">No secret is set</span>, so every delivery Patreon makes
            to this board is rejected. Nothing looks broken when this happens — the board just
            updates at the next sync instead of immediately.
          </span>
        )}
      </p>

      <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="webhook-secret" className="block text-sm font-medium">
            Signing secret
          </label>
          <input
            id="webhook-secret"
            // Off the screen while it is typed: a creator pasting this is often sharing their
            // screen with whoever asked them to set it up.
            type="password"
            autoComplete="off"
            value={secret}
            maxLength={256}
            onChange={(event) => setSecret(event.target.value)}
            className="mt-1 w-64 max-w-full rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-950"
          />
        </div>
        <button
          type="submit"
          className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Save the secret
        </button>
      </form>

      {message ? (
        <p role="status" className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {message}
        </p>
      ) : null}
    </div>
  );
}
