/** @type {import('tailwindcss').Config} */
// Colours resolve through the CSS variables defined in global.css, which is where light and dark
// are declared. Nothing here should be a literal colour — a hardcoded value is a colour that
// cannot follow the theme, and that is how the app ended up dark-only the first time.
//
// Names deliberately match the web client's shadcn utilities (`bg-primary`,
// `text-muted-foreground`), so markup ports between the two clients unchanged.
const c = (v) => `rgb(var(${v}) / <alpha-value>)`;

module.exports = {
  content: ["./App.tsx", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: c("--background"),
        foreground: c("--foreground"),
        card: c("--card"),
        popover: c("--popover"),
        primary: c("--primary"),
        "primary-foreground": c("--primary-foreground"),
        secondary: c("--secondary"),
        "secondary-foreground": c("--secondary-foreground"),
        muted: c("--muted"),
        "muted-foreground": c("--muted-foreground"),
        accent: c("--accent"),
        destructive: c("--destructive"),
        border: c("--border"),
        input: c("--input"),
        bubble: c("--bubble"),
        "sheet-grabber": c("--sheet-grabber"),
        code: c("--code"),
        "code-fg": c("--code-fg"),
        success: c("--success"),
        warning: c("--warning"),
        danger: c("--danger"),
        // The reading highlight carries its own alpha, so it is not a <alpha-value> colour.
        "read-line": "rgb(var(--read-line) / var(--read-line-alpha))",
        "read-word": "rgb(var(--read-word) / var(--read-word-alpha))",
      },
    },
  },
  plugins: [],
};
