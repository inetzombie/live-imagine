/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { ink: '#08080a', panel: '#111114', line: '#24242a', amber: { DEFAULT: '#ffb347', dim: '#a8712a' }, phos: '#7dffb0' },
      fontFamily: { mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'] },
    },
  },
  plugins: [],
};
