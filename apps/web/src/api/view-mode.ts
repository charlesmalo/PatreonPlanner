import type { Capabilities } from './types';

export type ViewMode = 'moderator' | 'patron';

/**
 * What a reader has chosen to see, applied to what the server actually granted.
 *
 * **Narrowing only.** This hides controls; it never grants anything, and the server is never told
 * which mode the tab is in. If the mode were ever an authorization input, a toggle in the browser
 * would be a security boundary — so the worst a broken switch can do here is hide a button.
 */
export function narrowCapabilities(capabilities: Capabilities, mode: ViewMode): Capabilities {
  if (mode === 'moderator') return capabilities;
  return {
    ...capabilities,
    // `&& false` rather than `false`, so the intent reads as "at most what they had".
    moderate: capabilities.moderate && false,
    administer: capabilities.administer && false,
    // Emptied with them. A staff permission left standing would keep rendering the controls
    // this preview exists to hide, and "view as patron" would show a patron view with publish
    // buttons on it. `filter(() => false)` for the same reason as `&& false` above: narrowing
    // can only ever remove.
    // `?? []` for the reason `themes` and `notes` carry one: a capabilities payload that
    // predates this field — a cached response, an API mid-deploy — must cost a control, not
    // the whole board. Without it this line throws inside render and the page goes blank.
    permissions: (capabilities.permissions ?? []).filter(() => false),
  };
}

/** Per reader and per board: a moderator on one board is a patron on another. */
export const viewModeKey = (slug: string) => `pp.board.${slug}.viewMode`;

/** How long a tab may sit idle before switching into moderator view asks for confirmation. */
export const ACK_AFTER_MS = 2 * 60 * 60 * 1000;

/** How long "don't ask again" lasts. */
export const ACK_SUPPRESS_MS = 24 * 60 * 60 * 1000;
