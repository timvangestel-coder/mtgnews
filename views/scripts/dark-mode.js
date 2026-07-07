/**
 * Dark Mode Module
 * ================
 * Exposed as window.DarkMode so it is available before Alpine.js loads.
 *
 * Features:
 *  - Auto-detect prefers-color-scheme on first visit
 *  - Persist manual override in localStorage key "mtgnews-dark"
 *  - Toggle <html class="dark"> via sidebar sun/moon button (issue #200)
 *  - Listen for system preference changes when no manual override exists
 */

window.DarkMode = (() => {
  const STORAGE_KEY = 'mtgnews-dark';

  /**
   * Return true when dark mode should be active.
   * Priority: stored user choice > system preference > false (light)
   */
  function shouldBeDark() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) return stored === '1';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /** Apply the current mode to the <html> element */
  function apply(dark) {
    document.documentElement.classList.toggle('dark', !!dark);
  }

  // Initial apply (runs at load time, before Alpine)
  apply(shouldBeDark());

  // Listen for system preference changes — only when user hasn't overridden
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (localStorage.getItem(STORAGE_KEY) === null) {
      apply(e.matches);
    }
  });

  /**
   * Public toggle — called from the sidebar button.
   * Persists the choice so it survives page reloads.
   */
  function toggle() {
    const dark = !shouldBeDark();
    localStorage.setItem(STORAGE_KEY, dark ? '1' : '0');
    apply(dark);
  }

  /** Return current mode as a string for template binding */
  function isDark() {
    return shouldBeDark();
  }

  return { toggle, isDark };
})();