import { describe, expect, it } from 'vitest';
import {
  combine,
  decodeGroups,
  encodeGroups,
  removeGroup,
  splitAt,
  toggleLabel,
} from './label-groups';

describe('label groups', () => {
  it('encodes groups as pipes inside commas', () => {
    expect(encodeGroups([['a', 'b'], ['c']])).toBe('a|b,c');
    expect(encodeGroups([])).toBe('');
  });

  it('decodes what it encodes', () => {
    expect(decodeGroups('a|b,c')).toEqual([['a', 'b'], ['c']]);
    expect(decodeGroups('')).toEqual([]);
  });

  it('drops malformed stored values rather than throwing during a render', () => {
    // This value comes from localStorage, which a reader can edit and an old build may have
    // written. A board that cannot paint because its filter is unreadable is worse than one that
    // paints unfiltered.
    //
    // `a||b` reads as `a AND b` — the empty member is dropped, not treated as a group boundary.
    expect(decodeGroups('a||b')).toEqual([['a', 'b']]);
    expect(decodeGroups(',,')).toEqual([]);
  });

  it('adds a label as its own group', () => {
    expect(toggleLabel([['a']], 'b')).toEqual([['a'], ['b']]);
  });

  it('removes a label from wherever it sits, and drops a group it empties', () => {
    expect(toggleLabel([['a', 'b'], ['c']], 'b')).toEqual([['a'], ['c']]);
    expect(toggleLabel([['a'], ['c']], 'c')).toEqual([['a']]);
  });

  it('combines a label into a group and takes it out of its old one', () => {
    // A label appears at most once across the whole filter: `(A AND B) OR (A)` is redundant.
    expect(combine([['a'], ['b']], 'b', 0)).toEqual([['a', 'b']]);
    expect(combine([['a', 'b'], ['c']], 'c', 0)).toEqual([['a', 'b', 'c']]);
  });

  it('leaves a label already in the target group alone', () => {
    expect(combine([['a', 'b']], 'b', 0)).toEqual([['a', 'b']]);
  });

  it('splits a group at the magnet, leaving what was left of it on the left', () => {
    expect(splitAt([['a', 'b', 'c']], 0, 0)).toEqual([['a'], ['b', 'c']]);
    expect(splitAt([['a', 'b', 'c']], 0, 1)).toEqual([['a', 'b'], ['c']]);
  });

  it('removes a whole group at once', () => {
    expect(removeGroup([['a', 'b'], ['c']], 0)).toEqual([['c']]);
  });

  it('never produces an empty group', () => {
    // A group of one is an ordinary chip; a group of none cannot be rendered at all.
    expect(encodeGroups(removeGroup([['a']], 0))).toBe('');
    expect(splitAt([['a']], 0, 0)).toEqual([['a']]);
  });
});
