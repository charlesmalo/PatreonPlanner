/**
 * Which theme the reader has chosen, and how that reaches the page.
 *
 * Three options rather than two. Tailwind's default follows `prefers-color-scheme`, so before this
 * existed the app already tracked the operating system — switching to a class-based toggle without
 * a **System** option would have taken that away from everybody who never opens the menu. System is
 * therefore the default, and it keeps listening: change the theme in macOS or Windows and the page
 * follows, exactly as it did.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'pp.theme';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * What was chosen last, or `system`.
 *
 * Reads defensively: `localStorage` throws rather than returning null in a few real situations —
 * Safari's private browsing historically, and any embedding that blocks storage — and a theme
 * preference is not worth taking the page down for.
 */
export function readStoredChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function storeChoice(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // The page still works; only the memory of the choice is lost.
  }
}

/** Whether the operating system is currently asking for a dark interface. */
export function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** The theme actually shown, once `system` has been resolved against the operating system. */
export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return choice;
}

/**
 * Puts the resolved theme on the document.
 *
 * The class on `<html>` is what every `dark:` utility in the app keys off, so this is the single
 * place the choice becomes visible. `color-scheme` is set alongside it so the browser's own
 * furniture — form controls, scrollbars, the space past the end of the page — matches rather than
 * staying stubbornly light behind a dark page.
 */
export function applyTheme(choice: ThemeChoice): 'light' | 'dark' {
  const resolved = resolveTheme(choice);
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  return resolved;
}
