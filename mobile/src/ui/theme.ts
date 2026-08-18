// The same tokens as global.css, in JS.
//
// Two copies is not ideal, but some values genuinely cannot come from a className: lucide draws
// SVG strokes coloured by a `color` prop, TextInput needs `placeholderTextColor`, and StatusBar
// needs a light/dark string. Those all need real values at render time. Keep this in step with
// global.css — if a colour exists in only one of the two, something will fail to follow the theme.
import { useColorScheme } from "react-native";

const light = {
  background: "#ffffff",
  foreground: "#09090b",
  card: "#ffffff",
  popover: "#ffffff",
  primary: "#18181b",
  primaryForeground: "#fafafa",
  secondary: "#f4f4f5",
  secondaryForeground: "#18181b",
  mutedForeground: "#71717a",
  faint: "#a1a1aa",
  border: "#e4e4e7",
  bubble: "#f4f4f5",
  success: "#16a34a",
  warning: "#f59e0b",
  danger: "#dc2626",
  onColor: "#ffffff", // text/icons on a saturated fill
  onWarning: "#1c1917",
  // Reading highlight + inline code, as concrete values: these are animated and interpolated,
  // which a className cannot do.
  readWord: "rgba(96,165,250,0.38)",
  readWordOff: "rgba(96,165,250,0)",
  codeBg: "#f1f1f3",
  codeBgOff: "rgba(241,241,243,0)",
  codeFg: "#27272a",
};

const dark: typeof light = {
  background: "#09090b",
  foreground: "#fafafa",
  card: "#09090b",
  popover: "#18181b",
  primary: "#fafafa",
  primaryForeground: "#18181b",
  secondary: "#27272a",
  secondaryForeground: "#fafafa",
  mutedForeground: "#a1a1aa",
  faint: "#52525b",
  border: "#27272a",
  bubble: "#1f1f23",
  success: "#16a34a",
  warning: "#f59e0b",
  danger: "#dc2626",
  onColor: "#ffffff",
  onWarning: "#1c1917",
  readWord: "rgba(125,211,252,0.42)",
  readWordOff: "rgba(125,211,252,0)",
  codeBg: "#27272a",
  codeBgOff: "rgba(39,39,42,0)",
  codeFg: "#e4e4e7",
};

export type Palette = typeof light;

export function usePalette(): Palette & { isDark: boolean } {
  const scheme = useColorScheme();
  const isDark = scheme === "dark";
  return { ...(isDark ? dark : light), isDark };
}
