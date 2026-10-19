export function clampPaneSize(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function readStoredPaneSize(key, fallback) {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

export function storePaneSize(key, value) {
  try {
    window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // Pane resizing still works when local storage is unavailable.
  }
}
