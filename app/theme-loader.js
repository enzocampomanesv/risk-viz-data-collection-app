/*
 * theme-loader.js
 * Reads config/theme.json and applies it as CSS custom properties on :root,
 * injects the web-font stylesheet, and exposes the parsed theme (incl. logos)
 * to the app. Editing theme.json is the only thing needed to recolour/retype
 * the whole app — no code or CSS changes.
 */
const ThemeLoader = (function () {

  const FALLBACK = {
    fonts:  { body: "system-ui, sans-serif", display: "system-ui, sans-serif", base_size_px: 18 },
    colors: { bg: "#FAFAF8", surface: "#FFFFFF", text: "#1A1D21", muted: "#5B6470",
              accent: "#0E7C86", accent_contrast: "#FFFFFF", selected_fill: "#E6F4F5",
              border: "#E2E5E9", success: "#137333", error: "#C5221F" },
    sizing: { radius_px: 12, max_width_px: 560, tap_min_px: 54 },
    logos:  []
  };

  function apply(theme) {
    const root = document.documentElement.style;
    const c = theme.colors, f = theme.fonts, s = theme.sizing;

    // Colours
    Object.entries(c).forEach(([k, v]) => root.setProperty(`--color-${k.replace(/_/g, "-")}`, v));
    // Fonts
    root.setProperty("--font-body", f.body);
    root.setProperty("--font-display", f.display);
    root.setProperty("--font-base", (f.base_size_px || 18) + "px");
    // Sizing
    root.setProperty("--radius", (s.radius_px ?? 12) + "px");
    root.setProperty("--max-width", (s.max_width_px ?? 560) + "px");
    root.setProperty("--tap-min", (s.tap_min_px ?? 54) + "px");

    // Web font
    if (f.import_url) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = f.import_url;
      document.head.appendChild(link);
    }
  }

  async function load(url = "config/theme.json") {
    let theme = FALLBACK;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const parsed = await res.json();
        // Shallow-merge over fallback so a partial theme.json still works.
        theme = {
          fonts:  { ...FALLBACK.fonts,  ...(parsed.fonts  || {}) },
          colors: { ...FALLBACK.colors, ...(parsed.colors || {}) },
          sizing: { ...FALLBACK.sizing, ...(parsed.sizing || {}) },
          logos:  Array.isArray(parsed.logos) ? parsed.logos : []
        };
      } else {
        console.warn(`theme.json HTTP ${res.status} — using fallback theme`);
      }
    } catch (e) {
      console.warn("theme.json load failed — using fallback theme:", e.message);
    }
    apply(theme);
    return theme;
  }

  return { load };
})();
