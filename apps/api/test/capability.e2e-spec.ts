import { Policy, Viewer, can } from '../src/access/capability';

const anonymous: Viewer = {
  userId: null,
  isAuthenticated: false,
  isActivePatron: false,
  pledgeAmountCents: null,
  staffRole: null,
  permissions: [],
};
const loggedIn: Viewer = { ...anonymous, userId: 'user-1', isAuthenticated: true };
const patron: Viewer = { ...loggedIn, isActivePatron: true, pledgeAmountCents: 500 };
const staff: Viewer = { ...loggedIn, staffRole: 'MOD' };

const open: Policy = {
  viewVisibility: 'PUBLIC',
  submitMinTierAmountCents: null,
  upvoteMinTierAmountCents: null,
};

describe('can()', () => {
  describe('VIEW', () => {
    it('lets anyone view a PUBLIC creator', () => {
      expect(can('VIEW', anonymous, open)).toBe(true);
    });

    it('requires a login for ANY_PATREON_USER', () => {
      const policy: Policy = { ...open, viewVisibility: 'ANY_PATREON_USER' };
      expect(can('VIEW', anonymous, policy)).toBe(false);
      expect(can('VIEW', loggedIn, policy)).toBe(true);
    });

    it('requires an active pledge for SUBSCRIBERS_ONLY', () => {
      const policy: Policy = { ...open, viewVisibility: 'SUBSCRIBERS_ONLY' };
      expect(can('VIEW', loggedIn, policy)).toBe(false);
      expect(can('VIEW', patron, policy)).toBe(true);
    });

    it('does not treat a lapsed patron as active', () => {
      const lapsed: Viewer = { ...patron, isActivePatron: false };
      expect(can('VIEW', lapsed, { ...open, viewVisibility: 'SUBSCRIBERS_ONLY' })).toBe(false);
    });

    it('ignores the tier gates, which apply to writing rather than reading', () => {
      const policy: Policy = { ...open, submitMinTierAmountCents: 10_000 };
      expect(can('VIEW', anonymous, policy)).toBe(true);
    });
  });

  describe('UPVOTE and SUBMIT', () => {
    it('requires an active pledge even with no tier gate', () => {
      expect(can('UPVOTE', loggedIn, open)).toBe(false);
      expect(can('UPVOTE', patron, open)).toBe(true);
      expect(can('SUBMIT', loggedIn, open)).toBe(false);
      expect(can('SUBMIT', patron, open)).toBe(true);
    });

    it('compares pledge amount against the gate', () => {
      const policy: Policy = { ...open, submitMinTierAmountCents: 1000 };
      expect(can('SUBMIT', patron, policy)).toBe(false);
      expect(can('SUBMIT', { ...patron, pledgeAmountCents: 1000 }, policy)).toBe(true);
      expect(can('SUBMIT', { ...patron, pledgeAmountCents: 1500 }, policy)).toBe(true);
    });

    it('gates upvote and submit independently', () => {
      const policy: Policy = {
        ...open,
        upvoteMinTierAmountCents: 300,
        submitMinTierAmountCents: 1000,
      };
      expect(can('UPVOTE', patron, policy)).toBe(true);
      expect(can('SUBMIT', patron, policy)).toBe(false);
    });

    it('treats an active patron with no entitled tier as pledging nothing', () => {
      const tierless: Viewer = { ...patron, pledgeAmountCents: null };
      expect(can('UPVOTE', tierless, open)).toBe(true);
      expect(can('UPVOTE', tierless, { ...open, upvoteMinTierAmountCents: 1 })).toBe(false);
    });

    it('never lets an anonymous caller write', () => {
      expect(can('UPVOTE', anonymous, open)).toBe(false);
      expect(can('SUBMIT', anonymous, open)).toBe(false);
    });
  });

  describe('MODERATE', () => {
    it('is granted only by a staff row', () => {
      expect(can('MODERATE', anonymous, open)).toBe(false);
      expect(can('MODERATE', loggedIn, open)).toBe(false);
      // Design §3: moderation power derives only from a CreatorStaff row — paying the top tier
      // must not confer it.
      expect(can('MODERATE', { ...patron, pledgeAmountCents: 100_000 }, open)).toBe(false);
      expect(can('MODERATE', staff, open)).toBe(true);
    });
  });

  describe('staff bypass', () => {
    it('lets staff view, upvote and submit without pledging', () => {
      const locked: Policy = {
        viewVisibility: 'SUBSCRIBERS_ONLY',
        submitMinTierAmountCents: 10_000,
        upvoteMinTierAmountCents: 10_000,
      };
      expect(can('VIEW', staff, locked)).toBe(true);
      expect(can('UPVOTE', staff, locked)).toBe(true);
      expect(can('SUBMIT', staff, locked)).toBe(true);
    });
  });
});

describe('can(ADMINISTER)', () => {
  const policy: Policy = {
    viewVisibility: 'PUBLIC',
    submitMinTierAmountCents: null,
    upvoteMinTierAmountCents: null,
  };
  const base: Viewer = {
    userId: 'u1',
    isAuthenticated: true,
    isActivePatron: false,
    pledgeAmountCents: null,
    staffRole: null,
    permissions: [],
  };

  it('lets an owner manage staff', () => {
    expect(can('ADMINISTER', { ...base, staffRole: 'OWNER' }, policy)).toBe(true);
  });

  it('refuses a mod', () => {
    // A mod who could appoint mods could appoint an accomplice; one who could remove staff could
    // remove the owner. Both are privilege escalation dressed as convenience.
    expect(can('ADMINISTER', { ...base, staffRole: 'MOD' }, policy)).toBe(false);
  });

  it('refuses a patron however much they pledge', () => {
    expect(
      can('ADMINISTER', { ...base, isActivePatron: true, pledgeAmountCents: 100_000 }, policy),
    ).toBe(false);
  });

  it('refuses an unauthenticated viewer', () => {
    expect(can('ADMINISTER', { ...base, userId: null, isAuthenticated: false }, policy)).toBe(
      false,
    );
  });

  it('still gives a mod MODERATE', () => {
    expect(can('MODERATE', { ...base, staffRole: 'MOD' }, policy)).toBe(true);
  });

  it('still lets staff bypass the patron gates', () => {
    expect(can('SUBMIT', { ...base, staffRole: 'MOD' }, policy)).toBe(true);
    expect(can('UPVOTE', { ...base, staffRole: 'MOD' }, policy)).toBe(true);
  });
});
