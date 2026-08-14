import type { CreatorNote } from '../api/types';

/**
 * Read-only rendering of an entry's notes, oldest first — a timeline read backwards is not a
 * timeline. Used on the board (where only TIMELINE notes ever arrive) and in the review queue
 * (where both kinds do), so the kind is labelled rather than assumed.
 */
export function NoteList({ notes }: { notes: CreatorNote[] }) {
  if (notes.length === 0) return null;

  return (
    <ul className="mt-2 space-y-1.5">
      {notes.map((note) => (
        <li key={note.id} className="rounded bg-slate-50 px-2 py-1.5 text-xs dark:bg-slate-800/60">
          <p className="flex flex-wrap items-baseline gap-2">
            <span className="rounded-full border border-slate-300 px-1.5 text-[10px] uppercase tracking-wide dark:border-slate-600">
              {/* Named for its audience, not its enum value: a moderator needs to know at a
                  glance which of these the patrons can read. */}
              {note.kind === 'TIMELINE' ? 'Public' : 'Private'}
            </span>
            {note.plannedFor ? (
              <span className="text-slate-500 dark:text-slate-400">
                {new Date(note.plannedFor).toLocaleDateString()}
              </span>
            ) : null}
            <span className="text-slate-500 dark:text-slate-400">
              {note.author.fullName ?? 'A moderator'}
            </span>
          </p>
          {/* Text, never markup. */}
          <p className="mt-0.5 whitespace-pre-line break-words">{note.body}</p>
        </li>
      ))}
    </ul>
  );
}
