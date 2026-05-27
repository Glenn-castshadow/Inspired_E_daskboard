// Theme system using CSS custom properties so inline styles can reference them
// via `var(--name)` and a single toggle flips the entire UI.

const LIGHT = {
  "--bg-canvas":    "#f7f7f5",   // app background
  "--bg-surface":   "#ffffff",   // cards, rows
  "--bg-muted":     "#fafaf8",   // shipped/dimmed rows, subtle panels
  "--border":       "#e4e4e0",
  "--border-muted": "#ebebea",
  "--text":         "#1a1a1a",
  "--text-muted":   "#666",
  "--text-faint":   "#aaa",
  "--text-fainter": "#ccc",
  "--accent":       "#2D6A4F",   // primary green
  "--accent-bg":    "#f0faf4",
};

const DARK = {
  "--bg-canvas":    "#1a1a1a",
  "--bg-surface":   "#252523",
  "--bg-muted":     "#1f1f1d",
  "--border":       "#3a3a37",
  "--border-muted": "#2e2e2c",
  "--text":         "#f0ede5",
  "--text-muted":   "#a0a0a0",
  "--text-faint":   "#777",
  "--text-fainter": "#555",
  "--accent":       "#4ECDC4",
  "--accent-bg":    "#1e2e2b",
};

export function applyTheme(mode) {
  const palette = mode === "dark" ? DARK : LIGHT;
  const root = document.documentElement;
  Object.entries(palette).forEach(([k, v]) => root.style.setProperty(k, v));
  root.style.colorScheme = mode;
}

export function getInitialTheme() {
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function persistTheme(mode) {
  localStorage.setItem("theme", mode);
}
