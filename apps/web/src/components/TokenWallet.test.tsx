import { render, screen } from '@testing-library/react';
import { TokenWallet } from './TokenWallet';

const state = (over: object = {}) => ({ enabled: true, available: 2, ledger: [], ...over });

/**
 * The day, spelled the way the machine running the test spells it.
 *
 * Hard-coding "1 April" asserted the tester's locale rather than the component's logic — it
 * failed on en-CA, which writes "April 1", for a component that was right. Building the
 * expectation from the same date still fails when the component picks the wrong *date*, which is
 * the only thing here worth testing.
 */
const spelled = (utc: Date) =>
  new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    utc,
  );

const showsDate = (utc: Date) =>
  screen.getByText((_, element) => element?.textContent?.includes(spelled(utc)) === true, {
    selector: 'p',
  });

describe('TokenWallet', () => {
  const march = new Date('2026-03-14T00:00:00.000Z');

  it('renders nothing on a board that has not switched tokens on', () => {
    // Most boards. A panel explaining a feature nobody here has is noise on every one of them.
    const { container } = render(<TokenWallet tokens={state({ enabled: false, available: 0 })} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('says how many the reader has', () => {
    render(<TokenWallet tokens={state()} now={march} />);

    expect(screen.getByText(/2 redeem tokens/)).toBeInTheDocument();
  });

  it('counts one token in the singular', () => {
    render(<TokenWallet tokens={state({ available: 1 })} now={march} />);

    expect(screen.getByText(/1 redeem token$/)).toBeInTheDocument();
  });

  it('explains an empty balance rather than showing a bare nought', () => {
    // The reason this panel exists: with no tokens there is no redeem control on any card, and
    // an absent control is indistinguishable from a broken one.
    render(<TokenWallet tokens={state({ available: 0 })} now={march} />);

    expect(screen.getByText(/no redeem tokens right now/i)).toBeInTheDocument();
  });

  it('says when the next grant lands', () => {
    render(<TokenWallet tokens={state()} now={march} />);

    expect(showsDate(new Date(Date.UTC(2026, 3, 1)))).toBeInTheDocument();
  });

  it('rolls the next grant into the new year from December', () => {
    // Periods are YYYY-MM, so December's successor is January of the *next* year. Adding one to
    // the month is only correct because Date normalises month 12 — asserted, not assumed.
    render(<TokenWallet tokens={state()} now={new Date('2026-12-20T00:00:00.000Z')} />);

    expect(showsDate(new Date(Date.UTC(2027, 0, 1)))).toBeInTheDocument();
  });

  it('is findable as a region of its own', () => {
    render(<TokenWallet tokens={state()} now={march} />);

    expect(screen.getByRole('region', { name: /your redeem tokens/i })).toBeInTheDocument();
  });
});
