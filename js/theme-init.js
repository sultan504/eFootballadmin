// Runs before first paint (loaded synchronously in <head>) so there is no
// flash of the wrong colours. Kept as a separate file (not inline) so the
// page can use a strict Content-Security-Policy with no unsafe-inline scripts.
(function () {
  try {
    var t = localStorage.getItem("ef_theme");
    if (t !== "dark" && t !== "light") {
      t = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* private mode: fall back to CSS default */ }
})();
