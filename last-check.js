/* Shared across all three trackers. It reads GitHub's workflow history so a
   successful check with no content changes still shows its completion time. */
(function () {
  'use strict';

  var anchor = document.getElementById('last-check');
  var repo = window.TRACKER && window.TRACKER.meta && window.TRACKER.meta.repo;
  if (!anchor || !/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(repo || '')) return;

  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, 6000);
  fetch('https://api.github.com/repos/' + repo +
    '/actions/workflows/refresh.yml/runs?branch=master&status=success&per_page=1',
  { signal: controller.signal, cache: 'no-cache' })
    .then(function (response) {
      if (!response.ok) throw new Error('Workflow history is unavailable');
      return response.json();
    })
    .then(function (data) {
      var run = data.workflow_runs && data.workflow_runs[0];
      if (!run || run.status !== 'completed' || run.conclusion !== 'success' ||
          !Number.isSafeInteger(run.id) || !run.updated_at) return;
      var when = new Date(run.updated_at);
      if (!Number.isFinite(when.getTime())) return;
      var time = document.createElement('time');
      time.dateTime = when.toISOString();
      time.textContent = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      }).format(when);
      anchor.href = 'https://github.com/' + repo + '/actions/runs/' + run.id;
      anchor.replaceChildren(time);
    })
    .catch(function () { /* Keep the workflow-history link when live data is unavailable. */ })
    .finally(function () { clearTimeout(timeout); });
})();
