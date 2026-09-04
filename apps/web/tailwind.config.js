/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
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
