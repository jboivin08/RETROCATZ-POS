(function () {
  const THEME_KEY = "vaultcore_visual_theme";

  const THEMES = [
    { id: "classic", label: "VaultCore Classic", note: "The current dark professional look." },
    { id: "arcade-cabinet", label: "Arcade Cabinet", note: "Bright game-store energy with cabinet-style contrast." },
    { id: "crt-neon", label: "CRT Neon", note: "Green and cyan terminal glow." },
    { id: "clean-light", label: "Clean Light", note: "Bright daytime mode for office work." },
    { id: "event-expo", label: "Event / Expo", note: "High-contrast mode for fast checkout." },
    { id: "retro-console", label: "Retro Console", note: "Classic console colors and chunky contrast." },
    { id: "playstation-midnight", label: "PlayStation Midnight", note: "Deep blue premium register mood." },
    { id: "game-boy", label: "Game Boy", note: "Soft green handheld-screen style." },
    { id: "trading-card-shop", label: "Trading Card Shop", note: "Felt-table green with gold accents." },
    { id: "cyberpunk-market", label: "Cyberpunk Market", note: "Cyan, magenta, and yellow night-market energy." },
    { id: "repair-bench", label: "Repair Bench", note: "Graphite and amber workshop style." },
    { id: "tournament-night", label: "Tournament Night", note: "Bold event-night contrast." },
    { id: "minimal-pro", label: "Minimal Pro", note: "Quiet, dense, low-distraction mode." }
  ];

  const ids = new Set(THEMES.map((theme) => theme.id));

  function normalizeTheme(value) {
    const id = String(value || "").trim();
    return ids.has(id) ? id : "classic";
  }

  function readTheme() {
    try {
      return normalizeTheme(localStorage.getItem(THEME_KEY));
    } catch {
      return "classic";
    }
  }

  function applyTheme(value) {
    const theme = normalizeTheme(value);
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme === "clean-light" ? "light" : "dark";
    if (document.body) document.body.setAttribute("data-theme", theme);
    window.dispatchEvent(new CustomEvent("vaultcore-theme-change", { detail: { theme } }));
    return theme;
  }

  function setTheme(value) {
    const theme = normalizeTheme(value);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
    return applyTheme(theme);
  }

  window.VaultCoreTheme = {
    key: THEME_KEY,
    themes: THEMES.slice(),
    normalize: normalizeTheme,
    get: readTheme,
    apply: applyTheme,
    set: setTheme
  };

  applyTheme(readTheme());

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      if (document.body) document.body.setAttribute("data-theme", readTheme());
    }, { once: true });
  }

  window.addEventListener("storage", (event) => {
    if (event.key === THEME_KEY) applyTheme(event.newValue);
  });
})();
