/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Class rather than the default media query, so the reader can override the operating system
  // from the header. `System` remains an explicit option and the default — see src/theme.ts.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Sampled from the logo artwork itself, not picked by eye — the coral in
        // public/brand/logo.png is #FD5D46, and the wordmark has to agree with it exactly.
        brand: '#FD5D46',
      },
    },
  },
  plugins: [],
};
