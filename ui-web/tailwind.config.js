/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        darkBg: "#1a1a1a",
        darkPanel: "#161616",
        darkHeader: "#141414",
        borderDark: "#2a2a2a",
        highlightBg: "#1e1b2e",
        highlightBorder: "#534ab7",
        highlightText: "#afa9ec",
        tagBg: "#252525",
        tagBorder: "#333333",
        tagText: "#aaaaaa",
      }
    },
  },
  plugins: [],
}
