import { narrowCapabilities } from './view-mode';
import type { Capabilities } from './types';

const staff: Capabilities = {
  view: true,
  upvote: true,
  submit: true,
  moderate: true,
  administer: true,
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
    };

    expect(narrowCapabilities(patron, 'patron')).toEqual(patron);
    expect(narrowCapabilities(patron, 'moderator')).toEqual(patron);
  });

  it('leaves a reader who cannot moderate unchanged in either mode', () => {
    const viewer: Capabilities = {
      view: true,
      upvote: true,
      submit: true,
      moderate: false,
      administer: false,
    };

    expect(narrowCapabilities(viewer, 'patron')).toEqual(viewer);
  });
});
