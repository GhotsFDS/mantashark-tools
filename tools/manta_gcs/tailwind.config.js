/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg:     { DEFAULT: '#0a0e14', 50: '#0a0e14', 100: '#0f141c', 200: '#161b24' },
        panel:  { DEFAULT: '#161b24', 2: '#1d232e', 3: '#242b38' },
        line:   '#2a3342',
        fg:     { DEFAULT: '#e8eef7', mute: '#8593a8', dim: '#5a6374' },
        accent: { DEFAULT: '#58b4ff', hover: '#3d9fff', dim: '#1e5d94' },
        ks:     '#58b4ff',
        kdf:    '#ffa657',
        kt:     '#7ee787',
        krd:    '#ff7b72',
        warn:   '#f5a524',
        err:    '#f25f5c',
        ok:     '#4ade80',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'SF Mono', 'Consolas', 'PingFang SC', 'monospace'],
      },
    },
  },
  plugins: [],
};
