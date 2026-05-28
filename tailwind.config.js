/** @type {import('tailwindcss').Config} */
// Scoped to the Map tab only — the rest of the dashboard uses inline styles
// driven by CSS custom properties (see src/theme.js) and isn't expected to
// reference Tailwind utility classes. Tailwind here exists primarily so the
// ported zipmap components (src/map-tab/*) keep their utility-class layout
// without per-component refactoring.
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
