import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardTabs } from './BoardTabs';

const TABS = [
  { status: 'PENDING', label: 'Suggestions' },
  { status: 'ACCEPTED', label: 'Accepted' },
  { status: 'ACTIVE', label: 'Now Playing' },
];

/** The transform on the track is what says which column is on screen. */
const offset = () =>
  (screen.getAllByRole('tabpanel', { hidden: true })[0].parentElement as HTMLElement).style
    .transform;

describe('BoardTabs', () => {
  const setup = (initialIndex?: number, onChange?: (index: number) => void) =>
    render(
      <BoardTabs tabs={TABS} initialIndex={initialIndex} onChange={onChange}>
        {(tab) => <div>{`panel for ${tab.label}`}</div>}
      </BoardTabs>,
    );

  it('opens on the first column by default', () => {
    setup();

    expect(screen.getByRole('tab', { name: 'Suggestions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(offset()).toBe('translate3d(-0%, 0, 0)');
  });

  it('opens where it is told to', () => {
    setup(2);

    expect(screen.getByRole('tab', { name: 'Now Playing' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('falls back to the first column when told to open at one that is not there', () => {
    // A remembered column can outlive the column itself.
    setup(9);

    expect(screen.getByRole('tab', { name: 'Suggestions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('moves the point of view rightwards when going next', async () => {
    // The track shifts left so the next panel arrives from the right — the view travels towards
    // it, rather than the content being swapped underneath.
    setup();

    await userEvent.click(screen.getByRole('button', { name: /go to accepted/i }));

    expect(offset()).toBe('translate3d(-100%, 0, 0)');
  });

  it('moves it leftwards when going back', async () => {
    setup(2);

    await userEvent.click(screen.getByRole('button', { name: /go to accepted/i }));

    expect(offset()).toBe('translate3d(-100%, 0, 0)');
  });

  it('will not step off either end', async () => {
    setup();
    expect(screen.getByRole('button', { name: /no column before this one/i })).toBeDisabled();

    setup(TABS.length - 1);
    expect(screen.getAllByRole('button', { name: /no column after this one/i })[0]).toBeDisabled();
  });

  it('jumps straight to a column from the strip', async () => {
    setup();

    await userEvent.click(screen.getByRole('tab', { name: 'Now Playing' }));

    expect(offset()).toBe('translate3d(-200%, 0, 0)');
  });

  it('says which column it moved to', async () => {
    const onChange = vi.fn();
    setup(0, onChange);

    await userEvent.click(screen.getByRole('tab', { name: 'Accepted' }));

    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('moves with the arrow keys', async () => {
    setup();
    screen.getByRole('tab', { name: 'Suggestions' }).focus();

    await userEvent.keyboard('{ArrowRight}');
    expect(offset()).toBe('translate3d(-100%, 0, 0)');

    await userEvent.keyboard('{ArrowLeft}');
    expect(offset()).toBe('translate3d(-0%, 0, 0)');
  });

  it('keeps every column mounted, so moving between them refetches nothing', () => {
    // Each column fetches its own page. Unmounting the others would turn the tab strip into a
    // loading-spinner generator.
    setup();

    expect(screen.getByText('panel for Suggestions')).toBeInTheDocument();
    expect(screen.getByText('panel for Now Playing')).toBeInTheDocument();
  });

  it('keeps the off-screen columns out of the tab order', () => {
    // Three invisible columns of focusable cards is a keyboard trap: tabbing off the last
    // visible card walks straight into them.
    setup();

    const panels = screen.getAllByRole('tabpanel', { hidden: true });
    expect(panels[0].hasAttribute('inert')).toBe(false);
    expect(panels[1].hasAttribute('inert')).toBe(true);
    expect(panels[2].hasAttribute('inert')).toBe(true);
  });

  /*
   * Swiping is tested in `e2e/tests/board-navigation.spec.ts`, not here.
   *
   * jsdom defines no `PointerEvent`: a dispatched pointer event arrives carrying neither
   * `pointerType` nor coordinates, so every gesture written against it has NaN deltas. A test
   * built on that measures how the implementation treats NaN, not how it treats a finger.
   *
   * It did find one thing worth keeping. The guards compared distances without checking the
   * numbers were real, and `Math.abs(NaN) < 48` is false — so they failed *open* and the board
   * changed column on an empty event. That check exists now.
   */

  it('puts only the selected tab in the tab order', () => {
    setup(1);

    expect(screen.getByRole('tab', { name: 'Accepted' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Suggestions' })).toHaveAttribute('tabindex', '-1');
  });
});
