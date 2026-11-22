/* Apply the saved theme before rendering. The public trackers share one origin,
   so switching theme on one also switches it on the other two. */
(function () {
  'use strict';
  var key = 'gta-vi-tracker-theme';
  var root = document.documentElement;
  var chrome = document.querySelector('meta[name="theme-color"]');
  var button;

  function apply(value) {
    var isLight = value === 'light';
    root.dataset.theme = isLight ? 'light' : 'dark';
    if (chrome) chrome.content = isLight ? '#fff4f5' : '#120e1b';
    if (button) {
      var action = isLight ? 'Dark mode' : 'Light mode';
      button.setAttribute('aria-label', action);
      button.title = action;
    }
  }

  /* A first-party preference cookie works across the three GitHub Pages paths.
     Sandboxed previews may block cookies, so the switch also works in memory. */
  var saved;
  try {
    var match = document.cookie.match(/(?:^|;\s*)gta-vi-tracker-theme=(light|dark)(?:;|$)/);
    if (match) saved = match[1];
  } catch (err) { /* Preference cookies may be blocked. */ }
  apply(saved);

  document.addEventListener('DOMContentLoaded', function () {
    button = document.getElementById('theme-toggle');
    if (!button) return;
    apply(root.dataset.theme);
    button.hidden = false;
    button.addEventListener('click', function () {
      var value = root.dataset.theme === 'light' ? 'dark' : 'light';
      apply(value);
      try {
        document.cookie = key + '=' + value + '; Path=/; Max-Age=31536000; SameSite=Lax; Secure';
      } catch (err) { /* Still applies on this page. */ }
    });
  });
})();
