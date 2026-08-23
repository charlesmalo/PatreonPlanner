import { render, screen } from '@testing-library/react';
import { ModeBanner } from './ModeBanner';

describe('ModeBanner', () => {
  it('says nothing in moderator view, which is the normal state for staff', () => {
    const { container } = render(<ModeBanner mode="moderator" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('names the mode in words, not only in colour', () => {
    // A colourblind moderator gets nothing from a tint, and this is the signal that stops a
    // mistaken edit.
    render(<ModeBanner mode="patron" />);

    expect(screen.getByRole('status')).toHaveTextContent(/patron/i);
  });

  it('says what is hidden, so a missing control is not a mystery', () => {
    render(<ModeBanner mode="patron" />);

    expect(screen.getByRole('status')).toHaveTextContent(/moderator controls are hidden/i);
  });
});
