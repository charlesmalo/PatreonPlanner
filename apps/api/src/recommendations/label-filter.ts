import { BadRequestException } from '@nestjs/common';

/**
 * The filter a reader has built, as disjunctive normal form: an OR of groups, each an AND of
 * labels. `a|b,c` is `(a AND b) OR (c)`.
 *
 * Parsed here rather than by class-validator because the value is nested — `each: true` reaches
 * one level and this is two. `board-query.ts` already decodes an opaque parameter and throws
 * `BadRequestException` when it will not read; this is the same job on the same request.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_GROUPS = 8;
export const MAX_GROUP_MEMBERS = 8;
/** Every id is checked against the board before the query runs, so the list is bounded. */
export const MAX_LABELS = 20;

export function parseLabelFilter(raw: string | undefined): string[][] {
  if (!raw) return [];

  const groups = raw.split(',').map((group) => group.split('|'));
  const flat = groups.flat();

  if (groups.length > MAX_GROUPS) throw new BadRequestException('Too many label groups');
  if (flat.length > MAX_LABELS) throw new BadRequestException('Too many labels');
  for (const group of groups) {
    if (group.length > MAX_GROUP_MEMBERS) {
      throw new BadRequestException('Too many labels in one group');
    }
    // An empty member is `a|` or `a,,b`: no interaction produces either.
    if (group.some((id) => !UUID.test(id))) throw new BadRequestException('Invalid label');
  }
  if (new Set(flat).size !== flat.length) throw new BadRequestException('Duplicate label');

  return groups;
}
