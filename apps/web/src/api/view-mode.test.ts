import { narrowCapabilities } from './view-mode';
import type { Capabilities } from './types';

const staff: Capabilities = {
  view: true,
  upvote: true,
  submit: true,
  moderate: true,
  administer: true,
  contact: true,
  permissions: ['EDIT_ENTRIES', 'MOVE_ENTRIES'],
};

describe('narrowCapabilities', () => {
  it('changes nothing in moderator view', () => {
    expect(narrowCapabilities(staff, 'moderator')).toEqual(staff);
  });

  it('drops the moderator powers in patron view', () => {
    expect(narrowCapabilities(staff, 'patron')).toEqual({
      view: true,
      upvote: true,
      submit: true,
      moderate: false,
      administer: false,
      contact: true,
      // Emptied with them. A staff permission left standing here would keep rendering the
      // controls the preview exists to hide — and "view as patron" would show a patron view
      // with publish buttons on it.
      permissions: [],
    });
  });

  it('never adds a capability the server withheld', () => {
    // The rule the whole feature rests on: this hides controls, it does not grant anything. If
    // narrowing could ever widen, a checkbox in the browser would be an authorization decision.
    const patron: Capabilities = {
      view: true,
      upvote: false,
      submit: false,
      moderate: false,
      administer: false,
      contact: true,
      permissions: [],
    };

    expect(narrowCapabilities(patron, 'patron')).toEqual(patron);
    expect(narrowCapabilities(patron, 'moderator')).toEqual(patron);
  });

  it('survives a capabilities payload with no permissions key', () => {
    // A cached response or an API mid-deploy can send the older shape. This line runs inside
    // render, so throwing here blanks the entire board — the failure is a white page, not a
    // missing button.
    const older = { view: true, upvote: true, submit: true, moderate: true, administer: false };

    expect(narrowCapabilities(older as Capabilities, 'patron')).toEqual({
      view: true,
      upvote: true,
      submit: true,
      moderate: false,
      administer: false,
      // No `contact` — an older payload predates the field, and absent reads as falsy, which
      // hides the contact form. That is the safe direction: a control that appears late is better
      // than one offered to somebody the server will refuse.
      permissions: [],
    });
  });

  it('leaves a reader who cannot moderate unchanged in either mode', () => {
    const viewer: Capabilities = {
      view: true,
      upvote: true,
      submit: true,
      moderate: false,
      administer: false,
      contact: true,
      permissions: [],
    };

    expect(narrowCapabilities(viewer, 'patron')).toEqual(viewer);
  });
});
