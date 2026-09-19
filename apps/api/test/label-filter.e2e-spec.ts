import { BadRequestException } from '@nestjs/common';
import { parseLabelFilter } from '../src/recommendations/label-filter';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('parseLabelFilter', () => {
  it('reads nothing as no filter', () => {
    expect(parseLabelFilter(undefined)).toEqual([]);
    expect(parseLabelFilter('')).toEqual([]);
  });

  it('reads a flat list as one group each, which is what it meant before groups existed', () => {
    expect(parseLabelFilter(`${A},${B}`)).toEqual([[A], [B]]);
  });

  it('reads a pipe as AND inside one group', () => {
    expect(parseLabelFilter(`${A}|${B},${C}`)).toEqual([[A, B], [C]]);
  });

  it('keeps the order it was given, so the filter reads as the chips look', () => {
    expect(parseLabelFilter(`${C},${A}|${B}`)).toEqual([[C], [A, B]]);
  });

  it('refuses a label that is not a uuid', () => {
    expect(() => parseLabelFilter('not-a-uuid')).toThrow(BadRequestException);
  });

  it('refuses an empty group, which no interaction can produce', () => {
    // `a|` and `a,,b` mean nothing; a client sending one has a bug, and quietly repairing it
    // makes that bug harder to find.
    expect(() => parseLabelFilter(`${A}|`)).toThrow(BadRequestException);
    expect(() => parseLabelFilter(`${A},,${B}`)).toThrow(BadRequestException);
  });

  it('refuses the same label twice anywhere in the expression', () => {
    // `(A AND B) OR (A)` is redundant — the second term can never add a row the first did not.
    expect(() => parseLabelFilter(`${A}|${B},${A}`)).toThrow(BadRequestException);
  });

  it('refuses more groups than the cap', () => {
    const many = Array.from({ length: 9 }, (_, i) => `${i}1111111-1111-4111-8111-111111111111`);
    expect(() => parseLabelFilter(many.join(','))).toThrow(BadRequestException);
  });

  it('refuses more members in a group than the cap', () => {
    const many = Array.from({ length: 9 }, (_, i) => `${i}2222222-2222-4222-8222-222222222222`);
    expect(() => parseLabelFilter(many.join('|'))).toThrow(BadRequestException);
  });
});
