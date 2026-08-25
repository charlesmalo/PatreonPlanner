import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

/**
 * Statements that break an old instance still serving traffic.
 *
 * A rolling deploy runs old and new code against one database for the length of the rollout. A
 * dropped column is still in the old instance's SELECT list; a column made NOT NULL has no
 * default in the old instance's INSERT. Both are expand/contract changes: add and backfill in
 * one release, stop using it in the next, drop it in a third.
 *
 * `DROP CONSTRAINT` is deliberately absent — re-defining a foreign key's delete behaviour is how
 * that is spelled, and it does not change any shape the old instance reads.
 */
const UNSAFE = [
  { pattern: /\bDROP\s+COLUMN\b/i, what: 'DROP COLUMN' },
  { pattern: /\bDROP\s+TABLE\b/i, what: 'DROP TABLE' },
  { pattern: /\bSET\s+NOT\s+NULL\b/i, what: 'SET NOT NULL' },
  { pattern: /\bRENAME\s+(COLUMN|TO)\b/i, what: 'RENAME' },
];

/**
 * Written before this check existed, and applied everywhere that matters.
 *
 * They are not fixed in place on purpose: Prisma checksums an applied migration, so editing one
 * fails every database that already ran it. Nothing is deployed, so the cost of leaving them is
 * zero — and the point of this list is that the *next* one is a deliberate decision rather than
 * an oversight.
 */
const GRANDFATHERED: Record<string, string> = {
  '20260823000000_theme_source':
    'Backfills ThemeSource then drops Theme.sourceKey in one step. Would need the drop split ' +
    'into a later migration if this ever ran against a live rollout.',
  '20260907000000_link_candidates':
    'Backfills canonicalUrl then makes it NOT NULL in one step. An old instance inserting a ' +
    'link without the column would fail for the length of the rollout.',
};

describe('Migration safety', () => {
  const directories = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it('finds migrations to check, so a wrong path cannot make this vacuous', () => {
    // Without this the whole suite passes by reading an empty directory, which is exactly the
    // shape of a test that guards nothing.
    expect(directories.length).toBeGreaterThan(5);
  });

  it.each(directories)('%s makes no change an old instance cannot survive', (name) => {
    const sql = readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8')
      // Comments explain these statements; they must not count as them.
      .replace(/--[^\n]*/g, '');
    const found = UNSAFE.filter(({ pattern }) => pattern.test(sql)).map(({ what }) => what);

    if (GRANDFATHERED[name]) {
      // Kept honest in both directions: a grandfathered entry whose migration no longer contains
      // anything unsafe is a stale exemption, and stale exemptions are how allowlists rot.
      expect(found.length).toBeGreaterThan(0);
      return;
    }

    expect(found).toEqual([]);
  });

  it('has no exemption for a migration that no longer exists', () => {
    expect(Object.keys(GRANDFATHERED).filter((name) => !directories.includes(name))).toEqual([]);
  });
});
