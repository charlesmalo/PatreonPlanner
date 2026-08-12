import { isLegalTransition, PATRON_VISIBLE_STATUSES } from '../src/moderation/transitions';

describe('isLegalTransition', () => {
  it('walks the lifecycle forward', () => {
    expect(isLegalTransition('PENDING', 'ACCEPTED')).toBe(true);
    expect(isLegalTransition('ACCEPTED', 'ACTIVE')).toBe(true);
    expect(isLegalTransition('ACTIVE', 'COMPLETED')).toBe(true);
  });

  it('refuses to skip stages', () => {
    expect(isLegalTransition('PENDING', 'ACTIVE')).toBe(false);
    expect(isLegalTransition('PENDING', 'COMPLETED')).toBe(false);
  });

  it('refuses to walk backwards', () => {
    expect(isLegalTransition('COMPLETED', 'ACTIVE')).toBe(false);
    expect(isLegalTransition('ACTIVE', 'ACCEPTED')).toBe(false);
  });

  it('allows rejection from any live status', () => {
    for (const from of ['PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED'] as const) {
      expect(isLegalTransition(from, 'REJECTED')).toBe(true);
    }
  });

  it('allows soft deletion from any status', () => {
    for (const from of ['PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED', 'REJECTED'] as const) {
      expect(isLegalTransition(from, 'DELETED')).toBe(true);
    }
  });

  it('restores rejected and deleted entries to PENDING only', () => {
    expect(isLegalTransition('DELETED', 'PENDING')).toBe(true);
    expect(isLegalTransition('REJECTED', 'PENDING')).toBe(true);
    expect(isLegalTransition('DELETED', 'ACTIVE')).toBe(false);
  });

  it('rejects a no-op transition', () => {
    // Not an error the client has to distinguish, but it must not write an audit row claiming
    // something changed.
    expect(isLegalTransition('ACTIVE', 'ACTIVE')).toBe(false);
  });

  it('keeps rejected and deleted entries off the patron board', () => {
    expect(PATRON_VISIBLE_STATUSES).toEqual(['PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED']);
  });
});
