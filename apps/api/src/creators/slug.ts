/**
 * Lowercase, ASCII-ish, hyphen-separated. Written out rather than pulled from a library because
 * design §9 requires identifier normalization to be explicit and paired with DB-level
 * uniqueness — a slug that silently changes shape would strand existing URLs.
 */
export function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    // Strip combining marks so an accented letter folds to its base rather than disappearing.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    // Trim again: the slice can leave a trailing hyphen behind.
    .replace(/-+$/g, '');
  // A name of entirely non-Latin characters reduces to nothing; it still needs a usable URL.
  return base.length > 0 ? base : 'creator';
}
