/**
 * Light / dark, remembered across reloads.
 *
 * The default is dark: the booth screen sits in an exhibition hall under bright
 * overhead light, where a dark surface makes the avatar's video the brightest thing
 * on the panel and pulls the eye to the face. Light mode exists for the admin page
 * and for stands lit differently than we expect.
 */
const KEY = "devoteam-theme";

export function currentTheme() {
  return localStorage.getItem(KEY) || "dark";
}

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(KEY, theme);
  // Full-colour wordmark on both surfaces. The poppy mark carries across, but the
  // word itself is near-black in the brand asset and would vanish on the dark
  // surface, so the on-dark copy keeps the mark and lightens only the lettering.
  for (const img of document.querySelectorAll("[data-logo]")) {
    img.src =
      theme === "light" ? "/brand/devoteam-color.svg" : "/brand/devoteam-color-on-dark.svg";
  }
}

export function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}

/** Call before first paint to avoid a flash of the wrong surface. */
export function initTheme() {
  applyTheme(currentTheme());
  return currentTheme();
}
