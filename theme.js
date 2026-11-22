/* Apply the saved theme before rendering. The public trackers share one origin,
   so switching theme on one also switches it on the other two. */
(function () {
  'use strict';
  var key = 'gta-vi-tracker-theme';
  var root = document.documentElement;
  var chrome = document.querySelector('meta[name="theme-color"]');
  var button;
  var label;

  function apply(value) {
    var isLight = value === 'light';
    root.dataset.theme = isLight ? 'light' : 'dark';
    if (chrome) chrome.content = isLight ? '#fff4f5' : '#120e1b';
    if (label) label.textContent = isLight ? 'Dark mode' : 'Light mode';
  }

  var saved;
  try { saved = window.localStorage.getItem(key); } catch (err) { /* Storage may be blocked. */ }
  apply(saved);

  document.addEventListener('DOMContentLoaded', function () {
    button = document.getElementById('theme-toggle');
    if (!button) return;
    label = button.querySelector('.theme-label');
    apply(root.dataset.theme);
    button.hidden = false;
    button.addEventListener('click', function () {
      var value = root.dataset.theme === 'light' ? 'dark' : 'light';
      apply(value);
      try { window.localStorage.setItem(key, value); } catch (err) { /* Still applies on this page. */ }
    });
  });

  window.addEventListener('storage', function (event) {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
})();
