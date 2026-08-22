import { hasPermission } from '../src/access/permissions';
import type { Viewer } from '../src/access/capability';

const base: Viewer = {
  userId: 'u1',
  isAuthenticated: true,
  isActivePatron: false,
  pledgeAmountCents: null,
  staffRole: null,
  permissions: [],
};

describe('hasPermission', () => {
  it('gives an owner everything, without granting it', () => {
    // Not by holding the full set: an owner whose permissions could be edited is an owner who
    // can be locked out of their own board.
    const owner = { ...base, staffRole: 'OWNER' as const, permissions: [] };

    expect(hasPermission(owner, 'MOVE_ENTRIES')).toBe(true);
    expect(hasPermission(owner, 'MANAGE_THEMES')).toBe(true);
  });

  it('gives a moderator only what was granted', () => {
    const mod = { ...base, staffRole: 'MOD' as const, permissions: ['MOVE_ENTRIES' as const] };

    expect(hasPermission(mod, 'MOVE_ENTRIES')).toBe(true);
    expect(hasPermission(mod, 'HANDLE_REPORTS')).toBe(false);
  });

  it('gives a moderator with an empty set nothing', () => {
    const mod = { ...base, staffRole: 'MOD' as const, permissions: [] };

    expect(hasPermission(mod, 'MOVE_ENTRIES')).toBe(false);
  });

  it('gives a non-staff viewer nothing, whatever is attached to them', () => {
    // Fails closed on the role first: a permission list on someone who is not staff here is not
    // a grant, it is a bug upstream.
    const patron = { ...base, permissions: ['MOVE_ENTRIES' as const, 'HANDLE_REPORTS' as const] };

    expect(hasPermission(patron, 'MOVE_ENTRIES')).toBe(false);
  });

  it('gives an unauthenticated viewer nothing', () => {
    const anon = {
      ...base,
      isAuthenticated: false,
      staffRole: 'OWNER' as const,
      permissions: [],
    };

    expect(hasPermission(anon, 'MOVE_ENTRIES')).toBe(false);
  });
});
