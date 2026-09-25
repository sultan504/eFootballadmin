(function () {
  const KEY = 'ef_theme';
  const LIGHT_COLOR = '#e6e9ef';
  const DARK_COLOR = '#171b23';

  function applyMetaColor(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? DARK_COLOR : LIGHT_COLOR);
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    applyMetaColor(theme);
    try { localStorage.setItem(KEY, theme); } catch (e) { /* private mode etc. — ignore */ }
  }

  window.toggleTheme = function () {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  };
  applyMetaColor(currentTheme());

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.addEventListener('click', window.toggleTheme);
    });
  });
})();
