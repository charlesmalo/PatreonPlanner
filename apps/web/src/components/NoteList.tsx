import type { CreatorNote } from '../api/types';

/**
 * Read-only rendering of an entry's notes, oldest first — a timeline read backwards is not a
 * timeline. Used on the board (where only TIMELINE notes ever arrive) and in the review queue
 * (where both kinds do), so the kind is labelled rather than assumed.
 */
interface NoteListProps {
  notes: CreatorNote[];
  /** Staff surfaces pass this; the board does not, so patrons get no controls. */
  onDelete?: (note: CreatorNote) => void;
}

export function NoteList({ notes, onDelete }: NoteListProps) {
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
                {/* Rendered in UTC, because it was picked as a plain date and stored at UTC
                    midnight — without this the author who chose 1 March reads 28 February back
                    on their own machine. */}
                {new Date(note.plannedFor).toLocaleDateString(undefined, { timeZone: 'UTC' })}
              </span>
            ) : null}
            <span className="text-slate-500 dark:text-slate-400">
              {note.author.fullName ?? 'A moderator'}
            </span>
            {onDelete ? (
              <button
                type="button"
                onClick={() => onDelete(note)}
                aria-label={`Delete this ${note.kind === 'TIMELINE' ? 'timeline' : 'private'} note`}
                className="ml-auto text-[10px] underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              >
                Delete
              </button>
            ) : null}
          </p>
          {/* Text, never markup. */}
          <p className="mt-0.5 whitespace-pre-line break-words">{note.body}</p>
        </li>
      ))}
    </ul>
  );
}
