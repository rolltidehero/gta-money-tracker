/* Read the update step's completion time, not the workflow end or commit
   time. Quiet runs and failed attempts can both advance this timestamp. */
(function () {
  'use strict';

  var anchor = document.getElementById('last-check');
  var repo = window.TRACKER && window.TRACKER.meta && window.TRACKER.meta.repo;
  if (!anchor || !/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(repo || '')) return;

  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, 8000);
  var api = 'https://api.github.com/repos/' + repo + '/actions/';
  function get(path) {
    return fetch(api + path, { signal: controller.signal, cache: 'no-cache' }).then(function (response) {
      if (!response.ok) throw new Error('Workflow history is unavailable');
      return response.json();
    });
  }

  async function render() {
    var data = await get('workflows/refresh.yml/runs?branch=master&status=completed&per_page=3');
    for (const run of data.workflow_runs || []) {
      if (!Number.isSafeInteger(run.id)) continue;
      const results = await get('runs/' + run.id + '/jobs?filter=latest');
      for (const job of results.jobs || []) {
        const step = (job.steps || []).find(function (s) {
          return s.name === 'Run the tracker script (--auto)' && s.status === 'completed' &&
            s.started_at && s.completed_at && ['success', 'failure', 'cancelled', 'timed_out'].includes(s.conclusion);
        });
        if (!step) continue;
        const when = new Date(step.completed_at);
        if (!Number.isFinite(when.getTime())) continue;
        const time = document.createElement('time');
        time.dateTime = when.toISOString();
        time.textContent = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
          hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
        }).format(when);
        anchor.href = 'https://github.com/' + repo + '/actions/runs/' + run.id +
          (Number.isSafeInteger(job.id) ? '/job/' + job.id + '#step:' + step.number + ':1' : '');
        anchor.replaceChildren(time);
        if (step.conclusion !== 'success') {
          const status = { failure: 'failed', cancelled: 'cancelled', timed_out: 'timed out' };
          anchor.append(' (' + status[step.conclusion] + ')');
        }
        return;
      }
    }
  }

  render()
    .catch(function () { /* Keep the workflow-history link when live data is unavailable. */ })
    .finally(function () { clearTimeout(timeout); });
})();
