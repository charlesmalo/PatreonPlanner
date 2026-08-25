/// <reference types="vite/client" />

/**
 * Build-time configuration. Declared explicitly rather than relying on the catch-all, so an
 * unset variable is `undefined` in the types as well as at runtime — which is what lets the
 * support page hide itself rather than render a dead link.
 */
interface ImportMetaEnv {
  readonly VITE_DONATION_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
