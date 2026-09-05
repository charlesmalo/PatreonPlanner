import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface BoardTab {
  status: string;
  label: string;
}

interface BoardTabsProps {
  tabs: BoardTab[];
  /** Which tab opens first. Out of range falls back to the first. */
  initialIndex?: number;
  onChange?: (index: number) => void;
  /** Rendered once per tab, all mounted, only one on screen. */
  children: (tab: BoardTab, index: number) => ReactNode;
}

/**
 * One column at a time, with the next one dragged in from the side it lives on.
 *
 * Four columns side by side truncate every one of them at laptop width; a single column gets the
 * whole screen and nothing is cut off. The cost is that moving between them has to feel like
 * moving, which is what the slide is for — the point of view travels, rather than the content
 * being swapped underneath it.
 *
 * **Direction is the whole design.** Going to the *previous* tab pulls it in from the **left**,
 * because that is where it sits; the current one leaves to the right. Going *next* is the mirror.
 * Scrolling left does what the left button does. Getting this backwards is the difference between
 * a board that moves and one that feels like it is fighting you.
 *
 * Every tab stays mounted. Each column fetches its own page, and unmounting would re-fetch on
 * every swipe — the tab strip would become a loading spinner generator.
 */
export function BoardTabs({ tabs, initialIndex = 0, onChange, children }: BoardTabsProps) {
  const [index, setIndex] = useState(() =>
    initialIndex >= 0 && initialIndex < tabs.length ? initialIndex : 0,
  );
  const strip = useRef<HTMLDivElement>(null);
  // Wheel gestures arrive as a stream of small deltas, not one event. Without a cooldown a single
  // flick crosses every tab at once.
  const cooling = useRef(false);

  const go = (next: number) => {
    const clamped = Math.max(0, Math.min(tabs.length - 1, next));
    if (clamped === index) return;
    setIndex(clamped);
    onChange?.(clamped);
  };

  useEffect(() => {
    const node = strip.current;
    if (!node) return;

    const onWheel = (event: WheelEvent) => {
      // Horizontal intent only. A vertical wheel belongs to the column, which scrolls its own
      // cards — stealing it would trap the reader at the top of a long list.
      const horizontal = event.shiftKey ? event.deltaY : event.deltaX;
      if (Math.abs(horizontal) < Math.abs(event.deltaY) && !event.shiftKey) return;
      if (Math.abs(horizontal) < 8 || cooling.current) return;

      event.preventDefault();
      cooling.current = true;
      window.setTimeout(() => {
        cooling.current = false;
      }, 350);
      // Scrolling left is negative, and left is where the previous tab is.
      go(index + (horizontal < 0 ? -1 : 1));
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [index, tabs.length]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(index - 1);
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(index + 1);
    }
    if (event.key === 'Home') {
      event.preventDefault();
      go(0);
    }
    if (event.key === 'End') {
      event.preventDefault();
      go(tabs.length - 1);
    }
  };

  const arrow = (direction: -1 | 1) => {
    const target = index + direction;
    const disabled = target < 0 || target > tabs.length - 1;
    return (
      <button
        type="button"
        onClick={() => go(target)}
        disabled={disabled}
        aria-label={
          disabled
            ? direction < 0
              ? 'No column before this one'
              : 'No column after this one'
            : `Go to ${tabs[target].label}`
        }
        className="hidden shrink-0 self-stretch rounded-lg border border-slate-200 px-2 text-2xl text-slate-500 disabled:opacity-30 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 sm:block dark:border-slate-800 dark:hover:bg-slate-800"
      >
        <span aria-hidden="true">{direction < 0 ? '‹' : '›'}</span>
      </button>
    );
  };

  return (
    <div className="mt-6">
      {/* Jumping straight to a column, rather than stepping through the ones between. */}
      <div role="tablist" aria-label="Board columns" className="flex flex-wrap gap-1">
        {tabs.map((tab, tabIndex) => (
          <button
            key={tab.status}
            type="button"
            role="tab"
            id={`board-tab-${tab.status}`}
            aria-selected={tabIndex === index}
            aria-controls={`board-panel-${tab.status}`}
            // Only the selected tab is in the tab order; the arrow keys move between them. That
            // is what the pattern expects, and it stops four columns costing four tab stops.
            tabIndex={tabIndex === index ? 0 : -1}
            onKeyDown={onKeyDown}
            onClick={() => go(tabIndex)}
            className={`rounded-t px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
              tabIndex === index
                ? 'border-b-2 border-brand text-slate-900 dark:text-slate-100'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-stretch gap-2">
        {arrow(-1)}

        {/* The window. Overflow hidden is what makes the neighbours off-screen rather than
            merely far away, so nothing can be scrolled into view by accident. */}
        {/* A ceiling on the reading width even at full screen: a card list stretched across a
            wide monitor is a long sideways scan for every title. Centred, so the dead space is
            symmetrical rather than all on one side. */}
        <div ref={strip} className="mx-auto min-w-0 max-w-5xl flex-1 overflow-hidden">
          <div
            className="flex motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out"
            style={{ transform: `translate3d(-${index * 100}%, 0, 0)` }}
          >
            {tabs.map((tab, tabIndex) => (
              <div
                key={tab.status}
                role="tabpanel"
                id={`board-panel-${tab.status}`}
                aria-labelledby={`board-tab-${tab.status}`}
                // Hidden from assistive technology and from the tab order when off-screen: three
                // invisible columns of focusable cards is a keyboard trap.
                aria-hidden={tabIndex !== index}
                // `inert` set through a ref rather than as a prop: React's types here
                // predate it, and a cast to smuggle it past the compiler would be hiding the
                // same gap. It is what keeps three off-screen columns of focusable cards out
                // of the tab order — without it, tabbing off the last visible card walks
                // straight into invisible ones.
                ref={(node) => {
                  if (!node) return;
                  if (tabIndex === index) node.removeAttribute('inert');
                  else node.setAttribute('inert', '');
                }}
                className="w-full shrink-0 px-0.5"
              >
                {children(tab, tabIndex)}
              </div>
            ))}
          </div>
        </div>

        {arrow(1)}
      </div>
    </div>
  );
}
