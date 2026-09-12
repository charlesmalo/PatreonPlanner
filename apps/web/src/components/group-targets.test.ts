import { describe, expect, it } from 'vitest';
import { groupTargets } from './group-targets';
import { recommendation } from '../test-support';

/**
 * The filter exists so the menu cannot offer something the API refuses with a 409 — every rule
 * here is one of `GroupingService.group`'s three refusals, mirrored.
 */
const entry = recommendation({ id: 'a' });
const none = () => false;

describe('groupTargets', () => {
  it('offers the other entries in the column', () => {
    const column = [entry, recommendation({ id: 'b' }), recommendation({ id: 'c' })];

    expect(groupTargets(entry, column, none).map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('never offers the entry itself', () => {
    expect(groupTargets(entry, [entry], none)).toEqual([]);
  });

  it('offers nothing at all when the entry already heads a group', () => {
    // One level, in both directions: the API refuses every target for such an entry, so a menu
    // of them would be a list of refusals.
    const column = [entry, recommendation({ id: 'b' })];

    expect(groupTargets(entry, column, (id) => id === 'a')).toEqual([]);
  });

  it('never offers an entry that is already inside a group', () => {
    const inside = recommendation({ id: 'b', parentId: 'c', parentSource: 'STAFF' });
    const column = [entry, inside];

    expect(groupTargets(entry, column, none)).toEqual([]);
  });

  it('still offers an entry the catalogue nested, which is in no group at all', () => {
    // The distinction `parentSource` exists for. A season shown under its show was never grouped
    // by anybody, so the API accepts it as a head — filtering on `parentId` would have hidden it.
    const implied = recommendation({ id: 'b', parentId: 'c', parentSource: 'CATALOGUE' });
    const column = [entry, implied];

    expect(groupTargets(entry, column, none).map((t) => t.id)).toEqual(['b']);
  });
});
