#!/usr/bin/env node
/* =============================================================================
   GTA Trackers: single update script
   =============================================================================

   WHAT THIS DOES
   --------------
   One command rebuilds everything from one source file:

       tracker-data.json   (the only file you edit)
              |
              v
       data.js             (generated: what the Glitch Tracker app loads)
       cars/data.js        (generated: what the Car Tracker app loads)
       ../gta6_glitch_tracker.csv          (generated: glitch matrix export)
       ../gta6_car_values.csv              (generated: car value list export)
       exports/*.csv                       (generated: copies of both CSVs kept in git)
       ../gta6_tracker_last_update.json    (generated: what changed in this run)

   After a successful rebuild the script commits the change and, when the
   folder has a GitHub remote called "origin", pushes it.

   HOW TO RUN
   ----------
       node update-tracker.js                 Full run: validate, rebuild, test, commit
       node update-tracker.js --dry-run       Validate and test only. Writes nothing.
       node update-tracker.js --check-links   Also test every source URL (slower)
       node update-tracker.js --refresh-cars  Also pull the newest car values from IGN's vehicle table
       node update-tracker.js --build 1.003.000   Record a new game build number
       node update-tracker.js --as-of "November 25, 2026"   Set the "Checked" date by hand
       node update-tracker.js --no-stamp      Keep the "Checked" date as it is
       node update-tracker.js --no-commit     Rebuild but do not make a git commit
       node update-tracker.js --no-push       Commit but do not push to GitHub
       node update-tracker.js --message "Mark M-05 as verified"   Custom commit subject
       node update-tracker.js --compact       Shorter progress output
       node update-tracker.js --auto          Unattended run (used by the four-hour GitHub workflow):
                                              refresh cars, rebuild, commit, push, watch public pages
       node update-tracker.js --watch         Also run the public-page watch (step 13) by hand
       node update-tracker.js --sync-sources  Copy shared source edits into both sibling apps,
                                              then rebuild, commit and push changed siblings.
                                              Add keys to also copy new ones: --sync-sources key1,key2
       node update-tracker.js --help          Show this help

   RUNNING WITHOUT ANYONE (every four hours)
   -------------------------------
   .github/workflows/refresh.yml runs "node update-tracker.js --auto" every four hours on GitHub's
   own servers, so nothing has to be open on any computer. The script refreshes the car values
   from IGN, stamps the date, rebuilds, commits and pushes only when something changed, and
   asks GitHub Pages to rebuild. What it cannot do alone is judge a new glitch write-up, so
   those still need a person (or the assistant) to edit tracker-data.json.

   Requirements: Node.js 18 or newer. No npm packages. Git is optional.

   STEPS (shown live while the script runs)
   ----------------------------------------
    1. Preflight checks            Node version, required files
    2. Load tracker data           Read and parse tracker-data.json
    3. Refresh car values          Only with --refresh-cars (a network failure is a warning)
    4. Validate tracker data       IDs, allowed values, source links, cross references
    5. Stamp date and build        Update "Checked" date and build number
    6. Generate data.js            Fill defaults and write one data file per app (data.js, cars/data.js)
    7. Generate CSV files          Write the glitch matrix and car value exports
    8. Self-test generated files   Load data.js like a browser would, re-read the CSVs
    9. Build change report         Compare against the last committed version
   10. Check source links          Only with --check-links
   11. Commit to git               Skipped with --no-commit or --dry-run
   12. Push to GitHub              Only when there is something new to push
   13. Watch public pages          Only with --auto or --watch: looks for a newer game build number
                                   and for a change in the CodeKingGTA car duplication row. It never
                                   edits the data. Findings are saved to a file for the workflow,
                                   which opens a GitHub issue so a person can review them.

   SAFETY
   ------
   - Every problem found in step 3 is listed at once, with the entry it belongs to.
   - If anything fails after files were written, the previous data.js, CSVs and
     tracker-data.json are restored, so the website never ends up half updated.
   - A failed IGN refresh or a failed push never undoes a good rebuild. Both are
     reported as warnings with the reason and what to do next.
   - Publishing the website is a separate step. This script prints a reminder.

   EXIT CODES
   ----------
       0  success
       1  the data has problems (fix tracker-data.json and run again)
       2  unexpected error (see the message and hint printed above the summary)
   ============================================================================= */
'use strict';

const fs = require('fs');
const { createHash } = require('crypto');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

/* ---------------------------------------------------------------------------
   Configuration
   --------------------------------------------------------------------------- */
const SITE_DIR = __dirname;
/* Where the CSV exports, the change report and the watch file go. Normally the folder above
   the site. The GitHub workflow sets TRACKER_OUT_DIR to a temporary folder. */
const OUT_DIR = process.env.TRACKER_OUT_DIR ? path.resolve(process.env.TRACKER_OUT_DIR) : path.resolve(SITE_DIR, '..');
/* All three repos use this identical script. The published repo in metadata
   identifies the app; the entries/cars fallback supports older data snapshots. */
const APPS = {
  glitch: { name: 'GTA Glitch Tracker', slug: 'gta-glitch-tracker', dir: 'gta6-glitch-tracker', csv: 'gta6_glitch_tracker.csv', report: 'gta6_tracker_last_update.json' },
  cars: { name: 'GTA Car Tracker', slug: 'gta-car-tracker', dir: 'gta-car-tracker', csv: 'gta6_car_values.csv', report: 'gta6_car_tracker_last_update.json' },
  money: { name: 'GTA Money Tracker', slug: 'gta-money-tracker', dir: 'gta-money-tracker', csv: 'gta6_money_tracker.csv', report: 'gta6_money_tracker_last_update.json' },
};
const appUrl = (cfg) => 'https://rolltidehero.github.io/' + cfg.slug + '/';
const APP = (() => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'tracker-data.json'), 'utf8'));
    return Object.keys(APPS).find((k) => data.meta?.repo === 'rolltidehero/' + APPS[k].slug) ||
      (Array.isArray(data.cars) ? 'cars' : 'glitch');
  } catch (e) { return 'glitch'; }
})();
const CONFIG = APPS[APP];
const APP_NAME = CONFIG.name;
const PEERS = Object.keys(APPS).filter((k) => k !== APP).map((k) => APPS[k]);
const MONEY_CATEGORIES = ['Money exploit', 'Built-in cheat', 'Duplication claim', 'Hoax or scam'];
const PATHS = {
  json: path.join(SITE_DIR, 'tracker-data.json'),
  dataJs: path.join(SITE_DIR, 'data.js'),
  feed: path.join(SITE_DIR, 'feed.xml'),
  appJs: path.join(SITE_DIR, 'app.js'),
  indexHtml: path.join(SITE_DIR, 'index.html'),
  csv: path.join(OUT_DIR, CONFIG.csv),
  /* Copies inside the repository so the CSVs are pushed to GitHub too. */
  exportsDir: path.join(SITE_DIR, 'exports'),
  csvCopy: path.join(SITE_DIR, 'exports', CONFIG.csv),
  report: path.join(OUT_DIR, CONFIG.report),
  watch: path.join(OUT_DIR, 'gta6_tracker_watch.json'),
};

/* Step 13 watches these public pages. It reads only; it never changes the data. */
const WATCH = {
  timeoutMs: 20000,
  /* A newer game build must be named on at least this many different pages to count. */
  minPages: 2,
  buildPages: [
    'https://stealthygaming.com/gta-6-patch-notes/',
    'https://timesaver.gg/blog/gta-6-update-patch-notes',
    'https://leonida-intel.com/gta-6-patch-notes/',
    'https://gta.tech4gamers.com/gta-6/gameplay/updates-and-patches/',
    'https://mygta.co/news/gta-6-launch-patches/',
  ],
  dupeUrl: 'https://raw.githubusercontent.com/CodeKingGTA/GTA-6-Cheats-Money-Glitches-v2/main/README.md',
};

/* The "Checked" date is written in this timezone. */
const TIMEZONE = 'America/Chicago';

/* Allowed values. Adding a new value here is all the script needs; the website
   shows unknown values with a neutral badge. */
const ALLOWED = {
  category: ['Money exploit', 'Built-in cheat', 'Duplication claim', 'Hoax or scam', 'Vehicle launch', 'Flying anomaly', 'Map clipping', 'Other physics'],
  repro: ['Repeatable', 'Recurring', 'Isolated', 'Unverified claim'],
  status: ['Unpatched', 'Partially patched', 'Patched', 'Disputed', 'Not a bug', 'Unverified', 'Not real'],
  platform: ['Reported', 'Unspecified', 'Not affected', 'Not released'],
  sp: ['Yes', 'No'],
  online: ['Yes', 'No', 'No online mode'],
  tracker: ['None', 'Standard', 'Advanced', 'Military', 'Disputed', 'Not published'],
  /* Evidence tier for a Wish List location card. It says how well the spot is
     reported, not that anyone here confirmed it in the game. */
  wishStatus: ['Guides agree', 'Reported sighting', 'Traffic search', 'No fixed spot'],
  /* Which count of Randy's list includes the car. */
  wishList: ['Starting 16', 'Added by a mission'],
};

/* The three places that buy stolen cars. "carBuyers" in the data file must use these ids. */
const BUYERS = ['Moses', "Pay 'n' Spray", 'Randy'];

/* Fields a car in the "cars" list may have. Only name, tracker and sources are required. */
const CAR_FIELDS = ['name', 'ignName', 'brand', 'type', 'era', 'tracker', 'sellValue', 'valueText', 'estValue', 'registerCost', 'condition', 'wishList', 'wish', 'buyers', 'note', 'sources'];

/* Fields of the "wish" location card on a Wish List car. status, list, spots,
   need and sources are required; how, tracker and caveat are optional. */
const WISH_FIELDS = ['status', 'list', 'spots', 'need', 'how', 'tracker', 'caveat', 'sources'];

/* Where --refresh-cars reads car values from (IGN's public vehicle table). */
const IGN = {
  endpoint: 'https://mollusk.apis.ign.com/graphql',
  slug: 'gta-6-vehicles',
  sourceKey: 'ignVehicles',
  sourceName: 'IGN vehicles guide',
  sourceUrl: 'https://www.ign.com/wikis/gta-6/Vehicles',
  timeoutMs: 20000,
  /* Fewer rows than this means the table changed shape; nothing is imported then. */
  minRows: 20,
};

/* Which ID prefix belongs to which categories (a mismatch is only a warning). */
const ID_PREFIX = {
  M: ['Money exploit', 'Built-in cheat', 'Duplication claim', 'Hoax or scam'],
  V: ['Vehicle launch'],
  F: ['Flying anomaly'],
  C: ['Map clipping'],
  P: ['Other physics'],
};

/* Field order of every entry in the generated data.js. */
const ENTRY_FIELDS = ['id', 'name', 'category', 'moneyRank', 'money', 'ps5', 'xbox', 'pc', 'repro', 'status', 'sp', 'online', 'summary', 'steps', 'payout', 'tips', 'caveats', 'reportedBy', 'sources', 'carDupe'];

/* Fields compared in the change report, with the label printed for each. */
const TRACKED_FIELDS = {
  name: 'Name', category: 'Category', money: 'Money potential', ps5: 'PS5', xbox: 'Xbox', pc: 'PC',
  repro: 'Reproducibility', status: 'Patch status', sp: 'Single-player', online: 'Online',
  summary: 'Summary', steps: 'Steps', payout: 'Payout', tips: 'Tips', caveats: 'Caveats',
  reportedBy: 'Reported by', sources: 'Sources', carDupe: 'Car duplication flag',
};

/* Required by the project owner for commits created by this tool. */
const COMMIT_TRAILER = 'Co-authored-by: Perplexity <noreply@perplexity.ai>';

const LINK_TIMEOUT_MS = 12000;
const LINK_CONCURRENCY = 8;

/* ---------------------------------------------------------------------------
   Command line options
   --------------------------------------------------------------------------- */
function parseArgs(argv) {
  const opts = { dryRun: false, stamp: true, asOf: null, build: null, checkLinks: false, refreshCars: false, commit: true, push: true, message: null, compact: false, help: false, auto: false, watch: false, syncSources: false, syncKeys: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new StepError('Option ' + a + ' needs a value.', 'Example: ' + a + ' "value". Run with --help to see all options.', 1);
      return v;
    };
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-stamp') opts.stamp = false;
    else if (a === '--as-of') opts.asOf = next();
    else if (a === '--build') opts.build = next();
    else if (a === '--check-links') opts.checkLinks = true;
    else if (a === '--refresh-cars') opts.refreshCars = true;
    else if (a === '--no-commit') opts.commit = false;
    else if (a === '--no-push') opts.push = false;
    else if (a === '--message') opts.message = next();
    else if (a === '--compact') opts.compact = true;
    else if (a === '--auto') { opts.auto = true; opts.refreshCars = true; opts.compact = true; opts.watch = true; }
    else if (a === '--watch') opts.watch = true;
    else if (a === '--sync-sources') {
      opts.syncSources = true;
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts.syncKeys = argv[++i].split(',').map((k) => k.trim()).filter(Boolean);
    }
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new StepError('Unknown option: ' + a, 'Run with --help to see all options.', 1);
  }
  return opts;
}

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const start = src.indexOf('HOW TO RUN');
  const end = src.indexOf('STEPS (shown live');
  console.log(APP_NAME + ' update script\n\n   ' + src.slice(start, end).trimEnd() + '\n');
}

/* ---------------------------------------------------------------------------
   Errors and progress display
   --------------------------------------------------------------------------- */
class StepError extends Error {
  /* message: what went wrong. hint: how to fix it. code: process exit code. */
  constructor(message, hint, code) {
    super(message);
    this.hint = hint || '';
    this.code = code || 2;
  }
}

const STEPS = [
  { name: 'Preflight checks' },
  { name: 'Load tracker data' },
  { name: 'Refresh car values' },
  { name: 'Validate tracker data' },
  { name: 'Stamp date and build' },
  { name: 'Generate data.js' },
  { name: 'Generate CSV files' },
  { name: 'Self-test generated files' },
  { name: 'Build change report' },
  { name: 'Check source links' },
  { name: 'Commit to git' },
  { name: 'Push to GitHub' },
  { name: 'Watch public pages' },
];
STEPS.forEach((s, i) => { s.n = i + 1; s.state = 'pending'; s.note = ''; s.ms = 0; });

const MARK = { pending: '[ ]', running: '[>]', done: '[x]', skipped: '[-]', failed: '[!]', warned: '[~]' };
const LABEL = { pending: 'remaining', running: 'IN PROGRESS', done: 'completed', skipped: 'skipped', failed: 'FAILED', warned: 'WARNING' };
const RULE = '-'.repeat(72);
let COMPACT = false;
const warnings = [];

function board() {
  STEPS.forEach((s) => {
    const time = s.state === 'done' ? ' (' + (s.ms / 1000).toFixed(2) + 's)' : '';
    const note = s.note ? '  ' + s.note : '';
    console.log('  ' + MARK[s.state] + ' ' + String(s.n).padStart(2) + '. ' + s.name.padEnd(28) + LABEL[s.state] + time + note);
  });
}

function counts() {
  const c = { done: 0, skipped: 0, pending: 0, failed: 0, running: 0, warned: 0 };
  STEPS.forEach((s) => { c[s.state]++; });
  return c;
}

function info(msg) { console.log('      ' + msg); }
function warn(msg) { warnings.push(msg); console.log('      WARNING: ' + msg); }

/* Runs one step: prints progress, times it, records the outcome. */
async function runStep(index, fn) {
  const step = STEPS[index];
  step.state = 'running';
  const c = counts();
  console.log('\n' + RULE);
  console.log('STEP ' + step.n + ' of ' + STEPS.length + ': ' + step.name);
  console.log('Completed: ' + (c.done + c.skipped + c.warned) + '   In progress: step ' + step.n + '   Remaining after this: ' + c.pending);
  if (!COMPACT) { console.log(RULE); board(); }
  console.log(RULE);
  const t0 = Date.now();
  try {
    const result = await fn(step);
    step.ms = Date.now() - t0;
    if (step.state === 'running') step.state = 'done';
    console.log('   -> Step ' + step.n + ' ' + LABEL[step.state] + (step.note ? ': ' + step.note : '') + '.');
    return result;
  } catch (err) {
    step.ms = Date.now() - t0;
    step.state = 'failed';
    throw err;
  }
}

function skip(step, reason) {
  step.state = 'skipped';
  step.note = reason;
}

/* Marks a step as finished with a problem that must not stop the run. */
function soft(step, note, message) {
  step.state = 'warned';
  step.note = note;
  warn(message);
}

/* ---------------------------------------------------------------------------
   Small helpers
   --------------------------------------------------------------------------- */
function isString(v) { return typeof v === 'string'; }
function filled(v) { return isString(v) && v.trim().length > 0; }

function readText(file, what) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new StepError('Cannot read ' + what + ' at ' + file + ' (' + err.code + ').', 'Check that the file exists and is readable. Run the script from the tracker folder.', 2);
  }
}

/* Writes a file through a temporary file so a crash never leaves it half written. */
function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) { /* nothing to clean up */ }
    throw new StepError('Cannot write ' + file + ' (' + err.code + ').', 'Check free disk space and folder permissions.', 2);
  }
}

function todayLabel() {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
}

/* Replaces {build} and {asOf} in every string of a value (deep). */
function fillPlaceholders(value, meta) {
  if (isString(value)) return value.replace(/\{build\}/g, meta.build).replace(/\{asOf\}/g, meta.asOf);
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, meta));
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((k) => { out[k] = fillPlaceholders(value[k], meta); });
    return out;
  }
  return value;
}

/* Finds [[sourceKey|label]] links inside a text. */
function linkTokens(text) {
  const keys = [];
  const re = /\[\[([^\]|]+)\|([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(text))) keys.push(m[1]);
  const leftover = text.replace(re, '');
  return { keys, malformed: leftover.indexOf('[[') !== -1 || leftover.indexOf(']]') !== -1 };
}

/* Loads a data.js text the way a browser would and returns window.TRACKER. */
function loadDataJs(code, label) {
  const sandbox = { window: {} };
  try {
    vm.runInNewContext(code, sandbox, { filename: label, timeout: 5000 });
  } catch (err) {
    throw new StepError(label + ' does not run: ' + err.message, 'This is a generator problem, not a data problem. Re-run with --dry-run and report the message.', 2);
  }
  if (!sandbox.window.TRACKER) throw new StepError(label + ' did not define window.TRACKER.', 'The generated file is incomplete. Re-run the script.', 2);
  return sandbox.window.TRACKER;
}

/* Minimal CSV reader used only to double check the export. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r') { /* handled with the following \n */ }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* "17,160" or "$17,160" -> 17160. Empty or zero -> null. */
function moneyNumber(text) {
  const n = Number(String(text === undefined || text === null ? '' : text).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function dollars(n) { return '$' + Number(n).toLocaleString('en-US'); }

/* IGN writes model years without the apostrophe ("96 Infernus"). */
function carDisplayName(ignName) { return /^\d\d(s)? /.test(ignName) ? "'" + ignName : ignName; }

/* ---------------------------------------------------------------------------
   Step 3: car value refresh from IGN (only with --refresh-cars)
   --------------------------------------------------------------------------- */
async function fetchIgnVehicles() {
  const query = 'query DataTable($slug: String) {\n  dataTable(slug: $slug) {\n    content {\n      id\n      title\n      description\n    }\n    dataTable {\n      columns {\n        header\n        field\n        width\n        columnColor\n        rowColor\n        type\n        composite\n      }\n      data\n    }\n  }\n}\n';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IGN.timeoutMs);
  let res;
  try {
    res = await fetch(IGN.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
        'x-apollo-operation-name': 'DataTable',
        'apollographql-client-name': 'kraken',
        origin: 'https://www.ign.com',
        referer: 'https://www.ign.com/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      },
      body: JSON.stringify({ operationName: 'DataTable', variables: { slug: IGN.slug }, query }),
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'no answer within ' + IGN.timeoutMs / 1000 + ' seconds' : 'network error: ' + ((err.cause && err.cause.code) || err.message));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error('IGN answered HTTP ' + res.status);
  let body;
  try { body = await res.json(); } catch (err) { throw new Error('IGN did not return JSON'); }
  const table = body && body.data && body.data.dataTable && body.data.dataTable.dataTable;
  if (!table) throw new Error('the answer has no vehicle table' + (body && body.errors ? ' (' + JSON.stringify(body.errors).slice(0, 160) + ')' : ''));
  let rows = table.data;
  if (isString(rows)) { try { rows = JSON.parse(rows); } catch (err) { throw new Error('the vehicle table could not be parsed'); } }
  if (!Array.isArray(rows) || rows.length < IGN.minRows) throw new Error('the vehicle table has only ' + (Array.isArray(rows) ? rows.length : 0) + ' rows, expected ' + IGN.minRows + ' or more');
  if (!rows.some((r) => r && filled(r.Vehicle) && moneyNumber(r['Sell Value']) !== null)) throw new Error('the table no longer has "Vehicle" and "Sell Value" columns');
  return rows;
}

/* Copies IGN's values into data.cars. Hand-written fields (note, wishList, wish, buyers,
   display name, extra sources) are never overwritten. Returns what changed. */
function mergeIgnCars(data, rows) {
  if (!Array.isArray(data.cars)) data.cars = [];
  if (!data.sources || typeof data.sources !== 'object') data.sources = {};
  const byIgnName = {};
  data.cars.forEach((c) => { if (c && filled(c.ignName)) byIgnName[c.ignName] = c; });
  const result = { tableRows: rows.length, priced: 0, added: [], updated: [], noLongerListed: [] };
  const seen = {};
  rows.forEach((r) => {
    if (!r || !filled(r.Vehicle)) return;
    const sell = moneyNumber(r['Sell Value']);
    if (sell === null) return; /* IGN has not priced this vehicle yet */
    result.priced++;
    seen[r.Vehicle] = true;
    const fresh = {
      brand: filled(r.Brand) ? r.Brand.trim() : null,
      type: filled(r.Type) ? r.Type.trim() : null,
      era: filled(r.Era) ? r.Era.trim() : null,
      tracker: filled(r.Tracker) && ALLOWED.tracker.indexOf(r.Tracker.trim()) !== -1 ? r.Tracker.trim() : null,
      sellValue: sell,
      registerCost: moneyNumber(r['Cost to Register']),
      condition: filled(r['Body Condition']) ? r['Body Condition'].trim() : null,
    };
    if (filled(r.Tracker) && fresh.tracker === null) warn('IGN lists an unknown tracker type "' + r.Tracker + '" for ' + r.Vehicle + '. Add it to ALLOWED.tracker in the script if it is real.');
    const car = byIgnName[r.Vehicle];
    if (!car) {
      data.cars.push({
        name: carDisplayName(r.Vehicle), ignName: r.Vehicle, brand: fresh.brand || '', type: fresh.type || '', era: fresh.era || '',
        tracker: fresh.tracker || 'Not published', sellValue: sell, registerCost: fresh.registerCost, condition: fresh.condition || '',
        note: '', sources: [IGN.sourceKey],
      });
      result.added.push({ name: carDisplayName(r.Vehicle), sellValue: sell });
      return;
    }
    const fields = [];
    Object.keys(fresh).forEach((k) => {
      /* An empty IGN cell never erases a value we already have. */
      if (fresh[k] === null || fresh[k] === car[k]) return;
      fields.push({ field: k, from: car[k] === undefined ? null : car[k], to: fresh[k] });
      car[k] = fresh[k];
    });
    if (fields.length) result.updated.push({ name: car.name, fields });
  });
  data.cars.forEach((c) => { if (c && filled(c.ignName) && !seen[c.ignName]) result.noLongerListed.push(c.name); });
  if (!data.sources[IGN.sourceKey]) data.sources[IGN.sourceKey] = { name: IGN.sourceName, url: IGN.sourceUrl };
  return result;
}

function git(args, options) {
  return execFileSync('git', args, Object.assign({ cwd: SITE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, options || {})).trim();
}

function gitAvailable() {
  try { return git(['rev-parse', '--is-inside-work-tree']) === 'true'; } catch (err) { return false; }
}

/* The git version of the app: latest commit and how many commits the history has. */
function gitVersion() {
  try {
    const hash = git(['rev-parse', '--short', 'HEAD']);
    const count = git(['rev-list', '--count', 'HEAD']);
    const when = git(['log', '-1', '--format=%cI']);
    let dirty = '';
    try { dirty = git(['status', '--porcelain']) ? ' + uncommitted changes' : ''; } catch (e) { /* ignore */ }
    return 'commit ' + hash + ' (#' + count + ', ' + when + ')' + dirty;
  } catch (err) {
    return 'unknown (no git history)';
  }
}

/* "01.002.001" or "1.002.001" -> [1, 2, 1] so builds can be compared as numbers. */
function parseBuild(text) {
  const m = /^0*(\d+)\.(\d{3})\.(\d{3})$/.exec(String(text).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compareBuild(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}

async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), WATCH.timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'GTA-Glitch-Tracker-watch (+https://github.com/rolltidehero/gta-glitch-tracker)' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* Reads the public pages and returns findings. It never edits the data. */
async function watchPages(data) {
  const out = { checkedAt: new Date().toISOString(), currentBuild: data.meta.build, newBuilds: [], dupeRow: null, alerts: [], failures: [] };
  const current = parseBuild(data.meta.build);

  /* 1. A newer game build number named on several different pages. */
  const seen = {};
  const results = await Promise.all((APP === 'glitch' ? WATCH.buildPages : []).map(async (url) => {
    try { return { url, text: await fetchText(url) }; } catch (err) { return { url, error: err.message }; }
  }));
  results.forEach((r) => {
    if (r.error) { out.failures.push(r.url + ' (' + r.error + ')'); return; }
    const found = {};
    (r.text.match(/\b0?1\.\d{3}\.\d{3}\b/g) || []).forEach((v) => { found[v.replace(/^0+/, '')] = true; });
    Object.keys(found).forEach((v) => {
      const parsed = parseBuild(v);
      if (current && parsed && compareBuild(parsed, current) > 0) { (seen[v] = seen[v] || []).push(r.url); }
    });
  });
  Object.keys(seen).forEach((v) => {
    const pages = seen[v];
    out.newBuilds.push({ version: v, pages });
    if (pages.length >= WATCH.minPages) {
      out.alerts.push({
        key: 'build-' + v,
        title: 'Watch: possible new GTA VI build ' + v,
        body: 'The automatic page watch found build ' + v + ' named on ' + pages.length + ' pages. The tracker is on build ' + data.meta.build + '.\n\n' + pages.map((p) => '- ' + p).join('\n') + '\n\nThis is an automatic hint, not a confirmation. Check Rockstar Support for patch notes, then update tracker-data.json (entry statuses, meta.patchNote and --build ' + v + ').',
      });
    }
  });

  /* 2. The car duplication row belongs to the Money Tracker. */
  if (APP !== 'money') return out;
  try {
    const md = await fetchText(WATCH.dupeUrl);
    const m = /Vehicle duplication\s*\|\s*([^|\n]+)\|/i.exec(md);
    if (!m) {
      out.dupeRow = { found: false };
      out.failures.push(WATCH.dupeUrl + ' (the Vehicle duplication row was not found, the page layout may have changed)');
    } else {
      const status = m[1].replace(/\*+/g, '').trim();
      const m5 = (data.entries || []).find((e) => e.id === 'M-05');
      const alreadyVerified = !!(m5 && m5.carDupe === true && m5.repro === 'Repeatable');
      out.dupeRow = { found: true, status, trackerHasVerified: alreadyVerified };
      if (!/unverified/i.test(status) && !alreadyVerified) {
        out.alerts.push({
          key: 'dupe-row-' + status.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
          title: 'Watch: CodeKingGTA now lists vehicle duplication as "' + status + '"',
          body: 'The research repo ' + WATCH.dupeUrl + ' no longer lists vehicle duplication as unverified (status now: "' + status + '").\n\nThe tracker counts a car duplication as verified only with written steps and footage of the duplicate existing or being sold. Review entry M-05 before changing anything.',
        });
      }
    }
  } catch (err) {
    out.failures.push(WATCH.dupeUrl + ' (' + err.message + ')');
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Step 3: validation
   --------------------------------------------------------------------------- */
function validate(data) {
  const errors = [];
  const err = (where, msg) => errors.push(where + ': ' + msg);

  const hasEntries = APP !== 'cars';
  (hasEntries ? ['meta', 'defaults', 'sources', 'entries'] : ['meta', 'sources', 'cars']).forEach((k) => {
    if (data[k] === undefined || data[k] === null) err('top level', 'missing "' + k + '"');
  });
  if (APP === 'money' && (!Array.isArray(data.plan) || !data.plan.length || !Array.isArray(data.ladder) || !data.ladder.length)) {
    err('top level', 'the Money Tracker requires a non-empty chapter plan and earners table');
  }
  if (errors.length) return errors;

  /* meta */
  (hasEntries ? ['asOf', 'build', 'platformsLive'] : ['asOf', 'platformsLive']).forEach((k) => { if (!filled(data.meta[k])) err('meta.' + k, 'must be a non-empty text'); });

  /* sources */
  const sourceKeys = Object.keys(data.sources);
  const seenUrl = {};
  sourceKeys.forEach((key) => {
    const s = data.sources[key];
    const where = 'sources.' + key;
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) err(where, 'key may only contain letters and digits and must start with a letter');
    if (!s || !filled(s.name)) err(where, 'needs a "name"');
    if (!s || !filled(s.url)) { err(where, 'needs a "url"'); return; }
    try {
      const u = new URL(s.url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') err(where, 'url must start with https:// (got ' + u.protocol + ')');
    } catch (e) {
      err(where, 'url is not a valid address: ' + s.url);
    }
    if (seenUrl[s.url]) warn('sources.' + key + ' and sources.' + seenUrl[s.url] + ' point to the same URL.');
    seenUrl[s.url] = key;
  });
  const hasSource = (k) => Object.prototype.hasOwnProperty.call(data.sources, k);
  const used = {};
  const checkSources = (where, list) => {
    if (!Array.isArray(list)) { err(where, '"sources" must be a list of source keys'); return; }
    list.forEach((k) => { if (!hasSource(k)) err(where, 'unknown source key "' + k + '". Add it under "sources" first.'); else used[k] = true; });
  };
  const checkRichText = (where, text) => {
    if (!filled(text)) { err(where, 'must be a non-empty text'); return; }
    const t = linkTokens(text);
    if (t.malformed) err(where, 'has a broken link. Links look like [[sourceKey|visible text]].');
    t.keys.forEach((k) => { if (!hasSource(k)) err(where, 'links to unknown source key "' + k + '"'); else used[k] = true; });
  };

  /* entries */
  if (hasEntries && (!Array.isArray(data.entries) || data.entries.length === 0)) {
    err('entries', 'must be a non-empty list');
    return errors;
  }
  const d = data.defaults || {};
  const ids = {};
  (hasEntries ? data.entries : []).forEach((e, i) => {
    const where = 'entries[' + i + ']' + (e && e.id ? ' (' + e.id + ')' : '');
    if (!e || typeof e !== 'object') { err(where, 'must be an object'); return; }
    if (!filled(e.id) || !/^[A-Z]-\d{2,3}$/.test(e.id)) err(where, '"id" must look like M-01');
    else if (ids[e.id]) err(where, 'duplicate id, already used by entries[' + ids[e.id].index + ']');
    else ids[e.id] = { index: i };
    if (!filled(e.name)) err(where, 'needs a "name"');
    if (!filled(e.summary)) err(where, 'needs a "summary"');

    const pick = (k) => (e[k] !== undefined ? e[k] : d[k]);
    const oneOf = (field, list, value) => {
      if (list.indexOf(value) === -1) err(where, '"' + field + '" is "' + value + '" but must be one of: ' + list.join(', '));
    };
    oneOf('category', ALLOWED.category, e.category);
    if (MONEY_CATEGORIES.includes(e.category) !== (APP === 'money')) {
      err(where, 'money-related reports belong only in the Money Tracker and physics reports only in the Glitch Tracker');
    }
    oneOf('repro', ALLOWED.repro, e.repro);
    oneOf('status', ALLOWED.status, pick('status'));
    oneOf('ps5', ALLOWED.platform, pick('ps5'));
    oneOf('xbox', ALLOWED.platform, pick('xbox'));
    oneOf('pc', ALLOWED.platform, pick('pc'));
    oneOf('sp', ALLOWED.sp, pick('sp'));
    oneOf('online', ALLOWED.online, pick('online'));

    const rank = pick('moneyRank');
    if (!Number.isInteger(rank) || rank < 1) err(where, '"moneyRank" must be a whole number of 1 or more');
    if (e.steps !== undefined && (!Array.isArray(e.steps) || e.steps.some((s) => !filled(s)))) err(where, '"steps" must be a list of non-empty texts');
    ['money', 'payout', 'tips', 'caveats', 'reportedBy'].forEach((k) => {
      if (e[k] !== undefined && !isString(e[k])) err(where, '"' + k + '" must be text');
    });
    if (e.carDupe !== undefined && typeof e.carDupe !== 'boolean') err(where, '"carDupe" must be true or false');
    if (!Array.isArray(e.sources) || e.sources.length === 0) err(where, 'needs at least one source key in "sources"');
    else checkSources(where, e.sources);

    Object.keys(e).forEach((k) => { if (ENTRY_FIELDS.indexOf(k) === -1) err(where, 'unknown field "' + k + '"'); });

    if (filled(e.id) && ID_PREFIX[e.id[0]] && ALLOWED.category.indexOf(e.category) !== -1 && ID_PREFIX[e.id[0]].indexOf(e.category) === -1) {
      warn(e.id + ' has category "' + e.category + '", which does not match its ID prefix.');
    }
  });

  /* ladder (legitimate earners table) */
  if (APP !== 'money' && data.ladder === undefined) { /* Only the Money Tracker needs this table. */ }
  else if (!Array.isArray(data.ladder)) err('ladder', 'must be a list');
  else data.ladder.forEach((r, i) => {
    const where = 'ladder[' + i + ']';
    ['stage', 'method', 'payout', 'note'].forEach((k) => { if (!filled(r[k])) err(where, 'needs "' + k + '"'); });
    checkSources(where, r.sources);
  });

  /* plan (money plan by chapter), optional */
  if (data.plan !== undefined) {
    if (!Array.isArray(data.plan)) err('plan', 'must be a list');
    else data.plan.forEach((p, i) => {
      const where = 'plan[' + i + ']';
      ['stage', 'title', 'expect', 'watch'].forEach((k) => { if (!filled(p[k])) err(where, 'needs "' + k + '"'); });
      if (!Array.isArray(p.do) || p.do.length === 0 || p.do.some((s) => !filled(s))) err(where, '"do" must be a non-empty list of texts');
      if (!Array.isArray(p.exploits)) err(where, '"exploits" must be a list of entry ids (it may be empty)');
      else p.exploits.forEach((id) => { if (!ids[id]) err(where, 'refers to entry "' + id + '", which does not exist'); });
      checkSources(where, p.sources);
    });
  }

  /* car buyers (the three cards above the car value list), optional */
  if (data.carBuyers !== undefined) {
    if (!Array.isArray(data.carBuyers)) err('carBuyers', 'must be a list');
    else data.carBuyers.forEach((b, i) => {
      const where = 'carBuyers[' + i + ']' + (b && b.id ? ' (' + b.id + ')' : '');
      if (!b || typeof b !== 'object') { err(where, 'must be an object'); return; }
      if (BUYERS.indexOf(b.id) === -1) err(where, '"id" must be one of: ' + BUYERS.join(', '));
      ['name', 'place'].forEach((k) => { if (!filled(b[k])) err(where, 'needs "' + k + '"'); });
      if (!Array.isArray(b.rows) || b.rows.length === 0) err(where, 'needs "rows", a list of [label, text] pairs');
      else b.rows.forEach((r, j) => {
        if (!Array.isArray(r) || r.length !== 2 || !filled(r[0])) { err(where + '.rows[' + j + ']', 'must be a [label, text] pair'); return; }
        checkRichText(where + '.rows[' + j + ']', r[1]);
      });
      if (b.topNote !== undefined && !isString(b.topNote)) err(where, '"topNote" must be text');
      checkSources(where, b.sources);
    });
  }

  /* car list notes (the paragraphs above the car value list), optional */
  if (data.carNotes !== undefined) {
    if (!Array.isArray(data.carNotes)) err('carNotes', 'must be a list');
    else data.carNotes.forEach((p, j) => checkRichText('carNotes[' + j + ']', p));
  }

  /* Wish List notes (the paragraphs above the location cards), optional */
  if (data.wishNotes !== undefined) {
    if (!Array.isArray(data.wishNotes)) err('wishNotes', 'must be a list');
    else data.wishNotes.forEach((p, j) => checkRichText('wishNotes[' + j + ']', p));
  }

  /* cars (the car value list), optional */
  if (data.cars !== undefined) {
    if (!Array.isArray(data.cars)) err('cars', 'must be a list');
    else {
      const seenIgn = {};
      const seenName = {};
      const amount = (where, c, k) => {
        if (c[k] !== undefined && c[k] !== null && !(typeof c[k] === 'number' && Number.isFinite(c[k]) && c[k] > 0)) err(where, '"' + k + '" must be a positive number or null (write 17160, not "$17,160")');
      };
      data.cars.forEach((c, i) => {
        const where = 'cars[' + i + ']' + (c && c.name ? ' (' + c.name + ')' : '');
        if (!c || typeof c !== 'object') { err(where, 'must be an object'); return; }
        if (!filled(c.name)) err(where, 'needs a "name"');
        if (ALLOWED.tracker.indexOf(c.tracker) === -1) err(where, '"tracker" is "' + c.tracker + '" but must be one of: ' + ALLOWED.tracker.join(', '));
        ['ignName', 'brand', 'type', 'era', 'condition', 'note', 'valueText'].forEach((k) => {
          if (c[k] !== undefined && !isString(c[k])) err(where, '"' + k + '" must be text');
        });
        ['sellValue', 'estValue', 'registerCost'].forEach((k) => amount(where, c, k));
        if ((c.sellValue === undefined || c.sellValue === null) && !filled(c.valueText)) err(where, 'needs a "sellValue" number or a "valueText" such as "Not published"');
        if (c.wishList !== undefined && typeof c.wishList !== 'boolean') err(where, '"wishList" must be true or false');
        /* Location card: every Wish List car has one, and no other car may. */
        if (c.wishList === true && c.wish === undefined) err(where, 'is on the Wish List, so it needs a "wish" location card. For a car nobody has located use {"status": "No fixed spot", "list": "Starting 16", "spots": [], "need": "...", "sources": [...]}');
        if (c.wish !== undefined) {
          const w = c.wish;
          const ww = where + '.wish';
          if (c.wishList !== true) err(ww, 'only a car with "wishList": true may have a location card');
          if (!w || typeof w !== 'object' || Array.isArray(w)) err(ww, 'must be an object');
          else {
            if (ALLOWED.wishStatus.indexOf(w.status) === -1) err(ww, '"status" is "' + w.status + '" but must be one of: ' + ALLOWED.wishStatus.join(', '));
            if (ALLOWED.wishList.indexOf(w.list) === -1) err(ww, '"list" is "' + w.list + '" but must be one of: ' + ALLOWED.wishList.join(', '));
            if (!Array.isArray(w.spots)) err(ww, 'needs "spots", a list of {"where": "...", "when": "..."} (use [] when no spot is known)');
            else {
              w.spots.forEach((sp, j) => {
                const sw = ww + '.spots[' + j + ']';
                if (!sp || typeof sp !== 'object' || !filled(sp.where)) { err(sw, 'needs a "where" text'); return; }
                if (sp.when !== undefined && !isString(sp.when)) err(sw, '"when" must be text');
                Object.keys(sp).forEach((k) => { if (k !== 'where' && k !== 'when') err(sw, 'unknown field "' + k + '"'); });
              });
              if (w.status === 'No fixed spot' && w.spots.length > 0) err(ww, 'has spots, so "status" cannot be "No fixed spot"');
              if (w.status !== 'No fixed spot' && w.spots.length === 0) err(ww, 'has no spots, so "status" must be "No fixed spot"');
            }
            if (!filled(w.need)) err(ww, 'needs a "need" text (the tool or action, for example "Clone Key")');
            ['how', 'tracker'].forEach((k) => { if (w[k] !== undefined && !isString(w[k])) err(ww, '"' + k + '" must be text'); });
            if (w.caveat !== undefined) checkRichText(ww + '.caveat', w.caveat);
            if (!Array.isArray(w.sources) || w.sources.length === 0) err(ww, 'needs at least one source key in "sources"');
            else {
              checkSources(ww, w.sources);
              if (w.status === 'Guides agree' && w.sources.length < 2) err(ww, '"Guides agree" needs at least two sources. Use "Reported sighting" for a single guide.');
            }
            Object.keys(w).forEach((k) => { if (WISH_FIELDS.indexOf(k) === -1) err(ww, 'unknown field "' + k + '"'); });
          }
        }
        if (c.buyers !== undefined) {
          if (!Array.isArray(c.buyers)) err(where, '"buyers" must be a list');
          else c.buyers.forEach((b) => { if (BUYERS.indexOf(b) === -1) err(where, 'unknown buyer "' + b + '". Use: ' + BUYERS.join(', ')); });
        }
        if (!Array.isArray(c.sources) || c.sources.length === 0) err(where, 'needs at least one source key in "sources"');
        else checkSources(where, c.sources);
        Object.keys(c).forEach((k) => { if (CAR_FIELDS.indexOf(k) === -1) err(where, 'unknown field "' + k + '"'); });
        if (filled(c.ignName)) {
          if (seenIgn[c.ignName] !== undefined) err(where, 'duplicate "ignName", already used by cars[' + seenIgn[c.ignName] + ']');
          else seenIgn[c.ignName] = i;
        }
        if (filled(c.name)) {
          const key = ((c.brand || '') + ' ' + c.name).trim().toLowerCase();
          if (seenName[key] !== undefined) warn(where + ' has the same brand and name as cars[' + seenName[key] + ']. Merge them if they are the same car.');
          else seenName[key] = i;
        }
      });
    }
  }

  /* findings (the three cards at the top), optional */
  if (data.findings !== undefined) {
    if (!Array.isArray(data.findings)) err('findings', 'must be a list');
    else data.findings.forEach((f, i) => {
      const where = 'findings[' + i + ']';
      if (!filled(f.title)) err(where, 'needs a "title"');
      if (!Array.isArray(f.paragraphs) || f.paragraphs.length === 0) err(where, 'needs "paragraphs"');
      else f.paragraphs.forEach((p, j) => checkRichText(where + '.paragraphs[' + j + ']', p));
    });
  }

  /* footnotes, optional */
  if (data.footnotes !== undefined) {
    if (!Array.isArray(data.footnotes)) err('footnotes', 'must be a list');
    else data.footnotes.forEach((p, j) => checkRichText('footnotes[' + j + ']', p));
  }

  /* Car Tracker footnotes, optional */
  if (data.carFootnotes !== undefined) {
    if (!Array.isArray(data.carFootnotes)) err('carFootnotes', 'must be a list');
    else data.carFootnotes.forEach((p, j) => checkRichText('carFootnotes[' + j + ']', p));
  }

  sourceKeys.forEach((k) => { if (!used[k]) warn('sources.' + k + ' is not used by any entry, table or note.'); });
  return errors;
}

/* ---------------------------------------------------------------------------
   Step 5: build the object the website loads and wrap it in data.js
   --------------------------------------------------------------------------- */
function resolveData(data) {
  const d = data.defaults || {};
  const entries = (data.entries || []).map((e) => {
    const pick = (k, fallback) => (e[k] !== undefined ? e[k] : (d[k] !== undefined ? d[k] : fallback));
    return {
      id: e.id,
      name: e.name,
      category: e.category,
      moneyRank: pick('moneyRank', 99),
      money: pick('money', 'None'),
      ps5: pick('ps5', 'Unspecified'),
      xbox: pick('xbox', 'Unspecified'),
      pc: pick('pc', 'Not released'),
      repro: e.repro,
      status: pick('status', 'Unpatched'),
      sp: pick('sp', 'Yes'),
      online: pick('online', 'No online mode'),
      summary: e.summary,
      steps: e.steps || [],
      payout: pick('payout', ''),
      tips: pick('tips', ''),
      caveats: pick('caveats', ''),
      reportedBy: pick('reportedBy', ''),
      sources: e.sources,
      carDupe: e.carDupe === true,
    };
  });
  const resolved = {
    meta: data.meta,
    sources: data.sources,
    entries,
    ladder: data.ladder || [],
    plan: data.plan || [],
    carBuyers: data.carBuyers || [],
    carNotes: data.carNotes || [],
    wishNotes: data.wishNotes || [],
    cars: (data.cars || []).map(resolveCar),
    findings: data.findings || [],
    footnotes: data.footnotes || [],
    carFootnotes: data.carFootnotes || [],
  };
  return fillPlaceholders(resolved, data.meta);
}

/* Fills in what can be worked out for one car: who buys it, from which chapter,
   the value text the page shows and the number used for sorting. */
function resolveCar(c) {
  let buyers;
  if (Array.isArray(c.buyers)) buyers = c.buyers.slice();
  else if (c.wishList === true) buyers = ['Randy'];
  else if (c.tracker === 'None') buyers = ['Moses', "Pay 'n' Spray"];
  else if (c.tracker === 'Standard') buyers = ["Pay 'n' Spray"];
  else buyers = [];
  const noBuyer = c.tracker === 'Advanced' ? 'No confirmed buyer' : (c.tracker === 'Military' ? 'No buyer known' : 'Not published');
  const sellValue = typeof c.sellValue === 'number' ? c.sellValue : null;
  const estValue = typeof c.estValue === 'number' ? c.estValue : null;
  return {
    name: c.name,
    brand: c.brand || '',
    type: c.type || '',
    era: c.era || '',
    tracker: c.tracker,
    wishList: c.wishList === true,
    buyers,
    buyerLabel: buyers.length ? buyers.join(', ') : noBuyer,
    chapter: buyers.indexOf('Moses') !== -1 ? 'Chapter 2' : (buyers.length ? 'Chapter 3' : ''),
    sellValue,
    valueText: filled(c.valueText) ? c.valueText : (sellValue !== null ? dollars(sellValue) : 'Not published'),
    sortValue: sellValue !== null ? sellValue : estValue,
    registerCost: typeof c.registerCost === 'number' ? c.registerCost : null,
    condition: c.condition || '',
    note: c.note || '',
    sources: c.sources,
    wish: resolveWish(c),
  };
}

/* The location card of a Wish List car, with every optional field filled in
   so the page never has to guess. Cars that are not on the list get null. */
function resolveWish(c) {
  const w = c.wish;
  if (c.wishList !== true || !w || typeof w !== 'object') return null;
  const spots = (w.spots || []).map((sp) => ({ where: sp.where, when: sp.when || '' }));
  return {
    status: w.status,
    list: w.list,
    spots,
    /* One line for the CSV: "Main spot (when) | Alternate spot". */
    whereText: spots.length ? spots.map((sp) => sp.where + (sp.when ? ' (' + sp.when + ')' : '')).join(' | ') : 'No fixed spot reported',
    need: w.need,
    how: w.how || '',
    tracker: w.tracker || '',
    caveat: w.caveat || '',
    sources: w.sources,
  };
}

/* The CSV code is written into data.js so the website's "Export CSV" button and
   the CSV file on disk always come from exactly the same code. */
const CSV_CODE = `
  var CSV_COLUMNS = [
    ['ID', function (e) { return e.id; }],
    ['Glitch', function (e) { return e.name; }],
    ['Category', function (e) { return e.category; }],
    ['Money potential', function (e) { return e.money; }],
    ['PS5', function (e) { return e.ps5; }],
    ['Xbox Series X|S', function (e) { return e.xbox; }],
    ['PC', function (e) { return e.pc; }],
    ['Reproducibility', function (e) { return e.repro; }],
    ['Patch status', function (e) { return e.status; }],
    ['Single-player', function (e) { return e.sp; }],
    ['Online', function (e) { return e.online; }],
    ['Summary', function (e) { return e.summary; }],
    ['Steps or trigger', function (e) { return e.steps.map(function (s, i) { return (i + 1) + '. ' + s; }).join(' '); }],
    ['Payout', function (e) { return e.payout; }],
    ['Tips', function (e) { return e.tips; }],
    ['Caveats', function (e) { return e.caveats; }],
    ['Reported by', function (e) { return e.reportedBy; }],
    ['Source URLs', function (e) { return e.sources.map(function (k) { return DATA.sources[k].url; }).join(' | '); }],
  ];

  var CAR_CSV_COLUMNS = [
    ['Vehicle', function (c) { return c.name; }],
    ['Brand', function (c) { return c.brand; }],
    ['Class', function (c) { return c.type; }],
    ['Era', function (c) { return c.era; }],
    ['Tracker', function (c) { return c.tracker; }],
    ['Sells to', function (c) { return c.buyerLabel; }],
    ['Earliest chapter', function (c) { return c.chapter; }],
    ['Value as shown', function (c) { return c.valueText; }],
    ['Scan sell value (USD)', function (c) { return c.sellValue == null ? '' : c.sellValue; }],
    ['Cost to register (USD)', function (c) { return c.registerCost == null ? '' : c.registerCost; }],
    ['Condition when scanned', function (c) { return c.condition; }],
    ['On Randy Wish List', function (c) { return c.wishList ? 'Yes' : 'No'; }],
    ['Wish List evidence', function (c) { return c.wish ? c.wish.status : ''; }],
    ['Wish List location', function (c) { return c.wish ? c.wish.whereText : ''; }],
    ['Wish List needs', function (c) { return c.wish ? c.wish.need : ''; }],
    ['Notes', function (c) { return c.note; }],
    ['Source URLs', function (c) { return c.sources.map(function (k) { return DATA.sources[k].url; }).join(' | '); }],
  ];

  function csvFrom(columns, rows) {
    function cell(v) {
      var s = String(v == null ? '' : v);
      return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var lines = [columns.map(function (c) { return cell(c[0]); }).join(',')];
    rows.forEach(function (e) {
      lines.push(columns.map(function (c) { return cell(c[1](e)); }).join(','));
    });
    return lines.join('\\r\\n') + '\\r\\n';
  }

  function toCsv(rows) { return csvFrom(CSV_COLUMNS, rows); }
  function toCarsCsv(rows) { return csvFrom(CAR_CSV_COLUMNS, rows); }
`;
const CSV_COLUMN_COUNT = 18;
const CAR_CSV_COLUMN_COUNT = 17;

/* Each app gets only its own part of the data. */
function appView(resolved, app) {
  const pick = (keys) => { const o = {}; keys.forEach((k) => { o[k] = resolved[k]; }); return o; };
  return app === 'cars'
    ? pick(['meta', 'sources', 'carBuyers', 'carNotes', 'wishNotes', 'cars', 'carFootnotes'])
    : pick(['meta', 'sources', 'entries', 'ladder', 'plan', 'findings', 'footnotes']);
}

function renderDataJs(resolved, app) {
  const view = appView(resolved, app);
  /* Split the CSV helper code so each app only carries its own columns. */
  const iCar = CSV_CODE.indexOf('  var CAR_CSV_COLUMNS');
  const iHelp = CSV_CODE.indexOf('  function csvFrom');
  const csvCode = app === 'cars' ? CSV_CODE.slice(iCar) : CSV_CODE.slice(0, iCar) + CSV_CODE.slice(iHelp);
  const exportsCode = app === 'cars' ? '  DATA.toCarsCsv = toCarsCsv;' : '  DATA.toCsv = toCsv;';
  const json = JSON.stringify(view, null, 2).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return [
    '/* GENERATED FILE. Do not edit by hand.',
    '   Edit tracker-data.json, then run: node update-tracker.js',
    '   Loaded by index.html in the browser (window) and by the update script in Node. */',
    '(function (root) {',
    "  'use strict';",
    '',
    '  var DATA = ' + json.replace(/\n/g, '\n  ') + ';',
    csvCode,
    exportsCode,
    '  root.TRACKER = DATA;',
    "})(typeof window !== 'undefined' ? window : globalThis);",
    '',
  ].join('\n');
}

/* ---------------------------------------------------------------------------
   Step 8: change report
   --------------------------------------------------------------------------- */
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function buildReport(previous, current, options) {
  const report = {
    generatedAt: new Date().toISOString(),
    asOf: current.meta.asOf,
    build: current.meta.build,
    comparedWith: previous ? 'last git commit' : 'nothing (first run or no git history)',
    dryRun: options.dryRun,
    totals: { entries: current.entries.length, cars: (current.cars || []).length },
    hasChanges: false,
    added: [], removed: [], changed: [],
    metaChanges: [],
    alerts: { carDuplicationVerified: [], newlyPatched: [], buildChanged: false },
    carChanges: { added: [], removed: [], valueChanged: [], wishChanged: [] },
    otherSectionsChanged: [],
    warnings: warnings.slice(),
  };

  const isVerifiedDupe = (e) => e.carDupe === true && e.repro === 'Repeatable' && ['Unverified', 'Not real'].indexOf(e.status) === -1;
  const isPatched = (e) => e.status === 'Patched' || e.status === 'Partially patched';
  report.totals.verifiedCarDuplication = current.entries.filter(isVerifiedDupe).length;
  report.totals.patched = current.entries.filter(isPatched).length;

  if (!previous) {
    report.hasChanges = true;
    return report;
  }

  const before = {};
  (previous.entries || []).forEach((e) => { before[e.id] = e; });
  const after = {};
  current.entries.forEach((e) => { after[e.id] = e; });

  current.entries.forEach((e) => {
    const old = before[e.id];
    if (!old) {
      report.added.push({ id: e.id, name: e.name, category: e.category, status: e.status, repro: e.repro });
      if (isVerifiedDupe(e)) report.alerts.carDuplicationVerified.push({ id: e.id, name: e.name });
      if (isPatched(e)) report.alerts.newlyPatched.push({ id: e.id, name: e.name, status: e.status });
      return;
    }
    const fields = [];
    Object.keys(TRACKED_FIELDS).forEach((k) => {
      const was = old[k] === undefined && k === 'carDupe' ? false : old[k];
      if (!same(was, e[k])) {
        const short = ['summary', 'steps', 'payout', 'tips', 'caveats', 'sources', 'reportedBy'].indexOf(k) !== -1;
        fields.push(short ? { field: TRACKED_FIELDS[k] } : { field: TRACKED_FIELDS[k], from: was, to: e[k] });
      }
    });
    if (fields.length) report.changed.push({ id: e.id, name: e.name, fields });
    if (isVerifiedDupe(e) && !isVerifiedDupe(old)) report.alerts.carDuplicationVerified.push({ id: e.id, name: e.name });
    if (isPatched(e) && !isPatched(old)) report.alerts.newlyPatched.push({ id: e.id, name: e.name, status: e.status });
  });
  (previous.entries || []).forEach((e) => { if (!after[e.id]) report.removed.push({ id: e.id, name: e.name }); });

  Object.keys(current.meta).forEach((k) => {
    const was = (previous.meta || {})[k];
    if (was !== current.meta[k]) report.metaChanges.push({ field: k, from: was === undefined ? null : was, to: current.meta[k] });
  });
  report.alerts.buildChanged = (previous.meta || {}).build !== current.meta.build;

  /* Car value list: which cars are new, gone or repriced. */
  const carKey = (c) => ((c.brand || '') + ' ' + c.name).trim();
  const oldCars = {};
  (previous.cars || []).forEach((c) => { oldCars[carKey(c)] = c; });
  const newCars = {};
  (current.cars || []).forEach((c) => {
    const key = carKey(c);
    newCars[key] = true;
    const was = oldCars[key];
    if (!was) report.carChanges.added.push(key);
    else if (was.valueText !== c.valueText) report.carChanges.valueChanged.push({ car: key, from: was.valueText, to: c.valueText });
    /* Wish List location card added, removed or edited. */
    if (!same((was && was.wish) || null, c.wish || null)) {
      report.carChanges.wishChanged.push({ car: key, from: was && was.wish ? was.wish.status : null, to: c.wish ? c.wish.status : null });
    }
  });
  Object.keys(oldCars).forEach((key) => { if (!newCars[key]) report.carChanges.removed.push(key); });

  [['ladder', 'Legitimate earners table'], ['plan', 'Money plan'], ['cars', 'Car value list'], ['carBuyers', 'Car buyer cards'], ['carNotes', 'Car list notes'], ['wishNotes', 'Wish List notes'], ['findings', 'Key findings'], ['footnotes', 'Footnotes'], ['carFootnotes', 'Car Tracker footnotes'], ['sources', 'Source list']].forEach((pair) => {
    if (!same(previous[pair[0]] === undefined ? (pair[0] === 'sources' ? {} : []) : previous[pair[0]], current[pair[0]])) report.otherSectionsChanged.push(pair[1]);
  });

  const onlyDate = report.metaChanges.length === 1 && report.metaChanges[0].field === 'asOf';
  report.hasContentChanges = report.added.length + report.removed.length + report.changed.length + report.otherSectionsChanged.length > 0 || (report.metaChanges.length > 0 && !onlyDate);
  report.hasChanges = report.hasContentChanges || report.metaChanges.length > 0;
  return report;
}

/* RSS history lives in the generated feed itself, so clean Actions checkouts
   retain recent alerts without a database. Quiet runs leave it byte-identical. */
function renderFeed(previousXml, report, baseRevision) {
  const siteUrl = appUrl(CONFIG);
  const feedUrl = siteUrl + 'feed.xml';
  const escapeXml = (value) => String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  // Only recover complete item blocks from this script's own output.
  const items = previousXml.match(/^    <item>\n[\s\S]*?^    <\/item>$/gm) || [];
  if (items.length && !report.hasContentChanges) return previousXml;

  const topic = APP === 'cars'
    ? 'Car values, buyer information and Wish List locations'
    : APP === 'money' ? 'Money reports, chapter plans and legitimate earners'
      : 'Physics glitch reports, evidence tiers and game patch status';
  const changes = [];
  const sample = (names) => names.slice(0, 5).join(', ') + (names.length > 5 ? ' and ' + (names.length - 5) + ' more' : '');
  const note = (label, names) => { if (names.length) changes.push(label + ': ' + sample(names)); };
  if (APP === 'cars') {
    const cc = report.carChanges;
    note('Cars added', cc.added);
    note('Cars removed', cc.removed);
    note('Values changed', cc.valueChanged.map((v) => v.car + ' (' + v.from + ' to ' + v.to + ')'));
    note('Wish List cards updated', cc.wishChanged.map((v) => v.car));
  } else {
    if (report.alerts.buildChanged && report.build) changes.push('Tracked game build: ' + report.build);
    note('Patch status changed', report.alerts.newlyPatched.map((e) => e.name + ' (' + e.status + ')'));
    note('Reports added', report.added.map((e) => e.name + ' (' + e.status + ')'));
    note('Reports updated', report.changed.map((e) => e.name));
    note('Reports removed', report.removed.map((e) => e.name));
  }
  note('Other sections updated', report.otherSectionsChanged);
  if (!changes.length && report.hasContentChanges) {
    note('Tracker information updated', report.metaChanges.filter((m) => m.field !== 'asOf').map((m) => m.field));
  }
  const title = changes.length ? APP_NAME + ' update' : APP_NAME + ' RSS feed is live';
  const description = changes.length
    ? changes.join('. ') + '. See the tracker for details and sources.'
    : 'Subscribe for updates when tracker content changes. ' + topic + '.';
  // Stable across retries of the same edit before a commit, without pinning
  // separate updates with similar summaries to the same feed ID.
  const details = [report.added, report.removed, report.changed, report.carChanges,
    report.otherSectionsChanged, report.metaChanges.filter((m) => m.field !== 'asOf')];
  const id = siteUrl + '#rss-' + createHash('sha256').update(JSON.stringify([baseRevision, title, details])).digest('hex').slice(0, 24);
  if (items.some((item) => item.includes('<guid isPermaLink="false">' + escapeXml(id) + '</guid>'))) return previousXml;

  const date = new Date().toUTCString();
  items.unshift([
    '    <item>',
    '      <title>' + escapeXml(title) + '</title>',
    '      <link>' + siteUrl + '</link>',
    '      <guid isPermaLink="false">' + escapeXml(id) + '</guid>',
    '      <pubDate>' + date + '</pubDate>',
    // Readers may treat the decoded description as HTML; keep it plain text.
    '      <description>' + escapeXml(escapeXml(description)) + '</description>',
    '    </item>',
  ].join('\n'));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>' + escapeXml(APP_NAME) + '</title>',
    '    <link>' + siteUrl + '</link>',
    '    <description>' + escapeXml(topic) + '.</description>',
    '    <language>en</language>',
    '    <lastBuildDate>' + date + '</lastBuildDate>',
    '    <atom:link href="' + feedUrl + '" rel="self" type="application/rss+xml" />',
    ...items.slice(0, 25),
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

function printReport(report) {
  info('Compared with: ' + report.comparedWith);
  info('Entries: ' + report.totals.entries + '   Cars: ' + report.totals.cars + '   Patched: ' + report.totals.patched + '   Verified car duplication methods: ' + report.totals.verifiedCarDuplication);
  if (report.comparedWith.indexOf('nothing') === 0) return;
  info('Added: ' + report.added.length + '   Removed: ' + report.removed.length + '   Changed: ' + report.changed.length);
  report.added.forEach((e) => info('  + ' + e.id + ' ' + e.name + ' [' + e.category + ', ' + e.repro + ', ' + e.status + ']'));
  report.removed.forEach((e) => info('  - ' + e.id + ' ' + e.name));
  report.changed.forEach((e) => {
    const parts = e.fields.map((f) => (f.from !== undefined ? f.field + ': ' + JSON.stringify(f.from) + ' -> ' + JSON.stringify(f.to) : f.field + ' edited'));
    info('  ~ ' + e.id + ' ' + e.name + ': ' + parts.join('; '));
  });
  report.metaChanges.forEach((m) => info('  meta.' + m.field + ': ' + JSON.stringify(m.from) + ' -> ' + JSON.stringify(m.to)));
  const cc = report.carChanges;
  if (cc.added.length + cc.removed.length + cc.valueChanged.length) {
    info('Car value list: ' + cc.added.length + ' added, ' + cc.removed.length + ' removed, ' + cc.valueChanged.length + ' repriced');
    cc.valueChanged.slice(0, 20).forEach((v) => info('  $ ' + v.car + ': ' + v.from + ' -> ' + v.to));
    if (cc.added.length && cc.added.length <= 20) info('  + ' + cc.added.join(', '));
    if (cc.removed.length) info('  - ' + cc.removed.join(', '));
  }
  if (cc.wishChanged.length) {
    info('Wish List location cards: ' + cc.wishChanged.length + ' added or edited');
    cc.wishChanged.slice(0, 25).forEach((v) => info('  @ ' + v.car + ': ' + (v.from === v.to ? v.to + ' (details edited)' : (v.from || 'no card') + ' -> ' + (v.to || 'no card'))));
  }
  if (report.otherSectionsChanged.length) info('Other sections edited: ' + report.otherSectionsChanged.join(', '));
  if (report.alerts.carDuplicationVerified.length) info('ALERT: car duplication verified: ' + report.alerts.carDuplicationVerified.map((e) => e.id).join(', '));
  if (report.alerts.newlyPatched.length) info('ALERT: newly patched: ' + report.alerts.newlyPatched.map((e) => e.id + ' (' + e.status + ')').join(', '));
  if (report.alerts.buildChanged) info('ALERT: game build changed to ' + report.build);
  if (!report.hasChanges) info('No differences from the last commit.');
}

/* ---------------------------------------------------------------------------
   Step 9: link check
   --------------------------------------------------------------------------- */
async function checkOne(key, source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      method: 'GET', redirect: 'follow', signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; gta6-tracker-link-check/1.0)', accept: 'text/html,*/*' },
    });
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (e) { /* body already closed */ }
    if (res.status < 400) return { key, url: source.url, result: 'ok', status: res.status };
    if ([401, 403, 429, 999].indexOf(res.status) !== -1) return { key, url: source.url, result: 'blocked', status: res.status };
    return { key, url: source.url, result: 'broken', status: res.status };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timed out after ' + LINK_TIMEOUT_MS / 1000 + 's' : ((err.cause && err.cause.code) || err.message);
    return { key, url: source.url, result: 'error', status: null, reason };
  } finally {
    clearTimeout(timer);
  }
}

async function checkLinks(sources) {
  const keys = Object.keys(sources);
  const results = [];
  let next = 0;
  let finished = 0;
  async function worker() {
    while (next < keys.length) {
      const key = keys[next++];
      const r = await checkOne(key, sources[key]);
      results.push(r);
      finished++;
      if (finished % 10 === 0 || finished === keys.length) info('Checked ' + finished + ' of ' + keys.length + ' links...');
    }
  }
  await Promise.all(Array.from({ length: Math.min(LINK_CONCURRENCY, keys.length) }, worker));
  return results;
}

/* ---------------------------------------------------------------------------
   Main
   --------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------
   --sync-sources: keep shared sources identical in all three apps.
   Copy common keys (plus explicitly named extras) from this app into each
   sibling, then rebuild, test, commit and push only siblings with edits.
   Run it from the folder where you made the edit. --dry-run only lists what would change.
   --------------------------------------------------------------------------- */
function syncSources(opts) {
  console.log(APP_NAME + ': sync shared sources' + (opts.dryRun ? ' (DRY RUN)' : ''));
  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
      throw new StepError('Could not read ' + file + ': ' + err.message, 'Check that the sibling folder exists and that its JSON is valid.', 1);
    }
  };
  info('Step 1 of 3: read all three trackers and compare shared keys');
  const mine = read(PATHS.json).sources || {};
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const missing = opts.syncKeys.filter((k) => !has(mine, k));
  if (missing.length) throw new StepError('Source key(s) not found in this app: ' + missing.join(', ') + '.', 'Add them under "sources" here first.', 1);
  const targets = PEERS.map((peer) => {
    const dir = path.join(SITE_DIR, '..', peer.dir);
    const file = path.join(dir, 'tracker-data.json');
    const data = read(file);
    const sources = data.sources || {};
    const keys = Object.keys(mine).filter((k) => has(sources, k) || opts.syncKeys.includes(k));
    const changes = keys.filter((k) => !same(mine[k], sources[k]));
    info(peer.name + ': ' + changes.length + ' to copy' + (changes.length ? ' (' + changes.join(', ') + ')' : ''));
    return { peer, dir, file, data, changes };
  }).filter((t) => t.changes.length);
  if (!targets.length || opts.dryRun) { info('No files written. Steps 2 and 3 skipped.'); return; }
  info('Step 2 of 3: check sibling folders are ready');
  if (opts.commit) {
    for (const target of targets) {
      if (execFileSync('git', ['status', '--porcelain'], { cwd: target.dir, encoding: 'utf8' }).trim()) {
        throw new StepError(target.peer.name + ' has other uncommitted changes.', 'Commit them first or rerun with --no-commit --no-push.', 1);
      }
    }
  }
  info('Step 3 of 3: copy edits and rebuild changed siblings');
  for (const target of targets) {
    const { peer, dir, file, data, changes } = target;
    data.sources = data.sources || {};
    for (const k of changes) Object.defineProperty(data.sources, k, { value: mine[k], enumerable: true, writable: true, configurable: true });
    writeAtomic(file, JSON.stringify(data, null, 2) + '\n');
    const args = ['update-tracker.js', '--no-stamp', '--compact', '--message', 'Sync shared sources from ' + APP_NAME];
    if (!opts.commit) args.push('--no-commit');
    if (!opts.push || !opts.commit) args.push('--no-push');
    try { execFileSync(process.execPath, args, { cwd: dir, stdio: 'inherit' }); } catch (err) {
      throw new StepError(peer.name + ' rebuild failed (exit ' + err.status + ').', 'Review the output and the edited data file before retrying.', 2);
    }
    info('Completed rebuild for ' + peer.name);
  }
  info('Done. Run the regular update here to commit the original edit.');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return 0; }
  COMPACT = opts.compact;
  if (opts.syncSources) { syncSources(opts); return 0; }

  console.log(RULE);
  console.log(APP_NAME + ' update' + (opts.dryRun ? '  (DRY RUN: nothing will be written)' : ''));
  console.log('Folder: ' + SITE_DIR);
  console.log('Git version: ' + gitVersion());
  console.log('App: ' + APP_NAME + ' (' + APP + ')');
  console.log('Mode: ' + (opts.auto ? 'AUTO (unattended)' : 'manual'));
  console.log('Started: ' + new Date().toISOString());
  console.log(RULE);

  /* Previous file contents, kept in memory so a late failure can be undone. */
  const backup = {};
  let wroteFiles = false;
  const restore = () => {
    if (!wroteFiles) return false;
    Object.keys(backup).forEach((file) => {
      try {
        if (backup[file] === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
        else fs.writeFileSync(file, backup[file]);
      } catch (e) {
        console.log('      Could not restore ' + file + ': ' + e.message);
      }
    });
    return true;
  };
  const remember = (file) => { if (!(file in backup)) backup[file] = fs.existsSync(file) ? fs.readFileSync(file) : null; };

  let rawJson;
  let data;
  let resolved;
  let dataJsText;
  let csvText;
  let carRefresh = null;
  let pushResult = null;
  let report;
  let hasGit = false;

  try {
    /* ---- Step 1 ---- */
    await runStep(0, (step) => {
      const major = parseInt(process.versions.node.split('.')[0], 10);
      if (major < 18) throw new StepError('Node.js ' + process.versions.node + ' is too old.', 'Install Node.js 18 or newer from https://nodejs.org and run again.', 2);
      info('Node.js ' + process.versions.node + ' OK');
      [['json', 'tracker-data.json'], ['appJs', 'app.js'], ['indexHtml', 'index.html']].forEach((p) => {
        if (!fs.existsSync(PATHS[p[0]])) throw new StepError('Missing file: ' + PATHS[p[0]], 'The script must sit in the tracker folder next to ' + p[1] + '.', 2);
        info('Found ' + p[1]);
      });
      hasGit = gitAvailable();
      info(hasGit ? 'Git repository found' : 'No git repository here (change report and commit will be limited)');
      /* Pick up remote workflow commits when nothing here is edited. */
      if (hasGit && !opts.dryRun && opts.commit && opts.push) {
        try {
          git(['remote', 'get-url', 'origin']);
          const branchNow = git(['rev-parse', '--abbrev-ref', 'HEAD']);
          if (branchNow && branchNow !== 'HEAD') {
            git(['fetch', '-q', 'origin', branchNow], { timeout: 60000 });
            const behind = Number(git(['rev-list', '--count', 'HEAD..origin/' + branchNow]));
            const clean = git(['status', '--porcelain']) === '';
            if (behind > 0 && clean) {
              git(['merge', '--ff-only', '-q', 'origin/' + branchNow]);
              info('Fast-forwarded ' + behind + ' commit' + (behind === 1 ? '' : 's') + ' from GitHub.');
            } else if (behind > 0) {
              info('GitHub has ' + behind + ' newer commit' + (behind === 1 ? '' : 's') + '. This folder has edits, so they are merged at push time.');
            }
          }
        } catch (err) {
          info('Could not sync with GitHub first (' + String(err.message).split('\n')[0] + '). Continuing.');
        }
      }
      step.note = 'environment ready';
    });

    /* ---- Step 2 ---- */
    await runStep(1, (step) => {
      rawJson = readText(PATHS.json, 'tracker-data.json');
      try {
        data = JSON.parse(rawJson);
      } catch (err) {
        const m = /position (\d+)/.exec(err.message);
        let whereText = '';
        if (m) {
          const upTo = rawJson.slice(0, Number(m[1]));
          whereText = ' Near line ' + upTo.split('\n').length + ', column ' + (upTo.length - upTo.lastIndexOf('\n')) + '.';
        }
        throw new StepError('tracker-data.json is not valid JSON: ' + err.message + '.' + whereText, 'Common causes: a missing or extra comma, a missing quote, or an unescaped " inside a text (write \\" instead).', 1);
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new StepError('tracker-data.json must contain one object.', 'Restore the file from git: git checkout tracker-data.json', 1);
      const n = Array.isArray(data.entries) ? data.entries.length : 0;
      info('App: ' + APP_NAME);
      info('Read ' + (rawJson.length / 1024).toFixed(1) + ' KB, ' + n + ' entries, ' + (Array.isArray(data.cars) ? data.cars.length : 0) + ' cars, ' + Object.keys(data.sources || {}).length + ' sources');
      step.note = APP === 'cars' ? (Array.isArray(data.cars) ? data.cars.length : 0) + ' cars loaded' : n + ' entries loaded';
    });

    /* ---- Step 3 ---- */
    await runStep(2, async (step) => {
      if (APP !== 'cars') { skip(step, 'car values belong to the Car Tracker repository'); return; }
      if (!opts.refreshCars) { skip(step, 'run with --refresh-cars to enable'); return; }
      if (typeof fetch !== 'function') { skip(step, 'this Node.js version has no fetch'); return; }
      info('Asking IGN for its vehicle table (' + IGN.sourceUrl + ')...');
      let rows;
      try {
        rows = await fetchIgnVehicles();
      } catch (err) {
        /* Never fatal: the tracker is rebuilt from the values it already has. */
        carRefresh = { result: 'failed', reason: err.message };
        soft(step, 'IGN not reachable, kept the current values', 'Car values were NOT refreshed: ' + err.message + '. The existing car list was kept. Try again later, or check that ' + IGN.sourceUrl + ' still shows a vehicle table.');
        return;
      }
      const merged = mergeIgnCars(data, rows);
      carRefresh = Object.assign({ result: 'ok' }, merged);
      info('IGN table: ' + merged.tableRows + ' vehicles, ' + merged.priced + ' with a sell value');
      info('New cars: ' + merged.added.length + '   Updated cars: ' + merged.updated.length + '   No longer in the IGN table: ' + merged.noLongerListed.length);
      merged.added.slice(0, 25).forEach((c) => info('  + ' + c.name + ' ' + dollars(c.sellValue)));
      if (merged.added.length > 25) info('  ... and ' + (merged.added.length - 25) + ' more');
      merged.updated.slice(0, 25).forEach((c) => info('  ~ ' + c.name + ': ' + c.fields.map((f) => f.field + ' ' + JSON.stringify(f.from) + ' -> ' + JSON.stringify(f.to)).join('; ')));
      if (merged.noLongerListed.length) info('  Kept anyway (remove by hand if wrong): ' + merged.noLongerListed.join(', '));
      const changed = merged.added.length + merged.updated.length > 0;
      if (changed && !opts.dryRun) {
        remember(PATHS.json);
        wroteFiles = true;
        writeAtomic(PATHS.json, JSON.stringify(data, null, 2) + '\n');
        info('Saved the new car values to tracker-data.json');
      }
      step.note = changed ? (merged.added.length + ' new, ' + merged.updated.length + ' updated' + (opts.dryRun ? ' (not saved: dry run)' : '')) : 'already up to date';
    });

    /* ---- Step 4 ---- */
    await runStep(3, (step) => {
      const errors = validate(data);
      if (errors.length) {
        console.log('      Found ' + errors.length + ' problem' + (errors.length === 1 ? '' : 's') + ':');
        errors.forEach((e, i) => console.log('        ' + (i + 1) + '. ' + e));
        throw new StepError(errors.length + ' data problem' + (errors.length === 1 ? '' : 's') + ' in tracker-data.json.', 'Fix the lines listed above in tracker-data.json and run the script again. Nothing was changed.', 1);
      }
      const byCategory = {};
      (data.entries || []).forEach((e) => { byCategory[e.category] = (byCategory[e.category] || 0) + 1; });
      Object.keys(byCategory).forEach((c) => info(String(byCategory[c]).padStart(3) + '  ' + c));
      info(String((data.cars || []).length).padStart(3) + '  cars in the car value list');
      step.note = 'no errors' + (warnings.length ? ', ' + warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') : '');
    });

    /* ---- Step 5 ---- */
    await runStep(4, (step) => {
      const before = { asOf: data.meta.asOf, build: data.meta.build };
      if (opts.asOf) data.meta.asOf = opts.asOf;
      else if (opts.stamp) data.meta.asOf = todayLabel();
      if (opts.build && APP !== 'cars') data.meta.build = opts.build;
      else if (opts.build) info('--build is ignored here: the Car Tracker does not record a game build.');
      info('Checked date: ' + before.asOf + (before.asOf === data.meta.asOf ? ' (unchanged)' : ' -> ' + data.meta.asOf));
      if (APP !== 'cars') info('Game build:   ' + before.build + (before.build === data.meta.build ? ' (unchanged)' : ' -> ' + data.meta.build));
      const changed = before.asOf !== data.meta.asOf || before.build !== data.meta.build;
      if (changed && !opts.dryRun) {
        remember(PATHS.json);
        wroteFiles = true;
        writeAtomic(PATHS.json, JSON.stringify(data, null, 2) + '\n');
        info('Saved the new values to tracker-data.json');
      }
      step.note = changed ? (opts.dryRun ? 'would update' : 'updated') : 'no change needed';
    });

    /* ---- Step 6 ---- */
    await runStep(5, (step) => {
      resolved = resolveData(data);
      dataJsText = renderDataJs(resolved, APP);
      info('Filled defaults for ' + resolved.entries.length + ' entries and worked out buyers for ' + resolved.cars.length + ' cars');
      info('data.js size: ' + (dataJsText.length / 1024).toFixed(1) + ' KB');
      if (opts.dryRun) { step.note = 'built in memory only'; return; }
      remember(PATHS.dataJs);
      wroteFiles = true;
      writeAtomic(PATHS.dataJs, dataJsText);
      step.note = 'wrote data.js';
    });

    /* ---- Step 7 ---- */
    await runStep(6, (step) => {
      const tracker = loadDataJs(dataJsText, 'data.js');
      csvText = '\ufeff' + (APP === 'cars' ? tracker.toCarsCsv(tracker.cars) : tracker.toCsv(tracker.entries));
      const rowsCount = APP === 'cars' ? tracker.cars.length : tracker.entries.length;
      info(CONFIG.csv + ': ' + rowsCount + ' rows plus header, ' + (csvText.length / 1024).toFixed(1) + ' KB');
      if (opts.dryRun) { step.note = 'built in memory only'; return; }
      try {
        fs.mkdirSync(PATHS.exportsDir, { recursive: true });
      } catch (err) {
        throw new StepError('Cannot create the folder ' + PATHS.exportsDir + ' (' + err.code + ').', 'Check folder permissions.', 2);
      }
      [[PATHS.csv, csvText], [PATHS.csvCopy, csvText]].forEach((pair) => {
        remember(pair[0]);
        wroteFiles = true;
        writeAtomic(pair[0], pair[1]);
        info('Wrote ' + pair[0]);
      });
      step.note = 'wrote the CSV and its copy in exports/';
    });

    /* ---- Step 8 ---- */
    await runStep(7, async (step) => {
      const checks = [];
      const check = (label, ok, detail) => {
        checks.push(ok);
        info((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' (' + detail + ')' : ''));
      };
      const onDisk = opts.dryRun ? dataJsText : readText(PATHS.dataJs, 'data.js');
      const tracker = loadDataJs(onDisk, 'data.js');
      check('data.js loads and defines TRACKER', true);
      const leftover = JSON.stringify(tracker).match(/\{(build|asOf)\}/);
      check('no unfilled {build} or {asOf} placeholders', !leftover);
      const csvOnDisk = opts.dryRun ? csvText : readText(PATHS.csv, 'the CSV');
      check('CSV starts with a byte order mark for Excel', csvOnDisk.charCodeAt(0) === 0xfeff);
      const rows = parseCsv(csvOnDisk.slice(1));
      if (APP !== 'cars') {
        check('this app has no car data', tracker.cars === undefined);
        check('entry count matches the source', tracker.entries.length === data.entries.length, tracker.entries.length + ' entries');
        const incomplete = tracker.entries.filter((e) => ENTRY_FIELDS.some((k) => e[k] === undefined));
        check('every entry has every field', incomplete.length === 0, incomplete.length ? incomplete.map((e) => e.id).join(', ') : ENTRY_FIELDS.length + ' fields each');
        check('CSV has one row per entry plus a header', rows.length === data.entries.length + 1, rows.length + ' rows');
        const badWidth = rows.filter((r) => r.length !== CSV_COLUMN_COUNT).length;
        check('every CSV row has ' + CSV_COLUMN_COUNT + ' columns', badWidth === 0, badWidth ? badWidth + ' rows differ' : '');
        check('CSV IDs match the data', rows.slice(1).every((r, i) => r[0] === data.entries[i].id));
      } else {
        const carCount = (data.cars || []).length;
        check('this app has no glitch entries', tracker.entries === undefined);
        check('car count matches the source', tracker.cars.length === carCount, tracker.cars.length + ' cars');
        const badCars = tracker.cars.filter((c) => !Array.isArray(c.buyers) || !filled(c.valueText) || !filled(c.buyerLabel));
        check('every car has buyers and a value text', badCars.length === 0, badCars.length ? badCars.map((c) => c.name).join(', ') : '');
        const wishCars = tracker.cars.filter((c) => c.wishList);
        const noCard = wishCars.filter((c) => !c.wish || ALLOWED.wishStatus.indexOf(c.wish.status) === -1 || !filled(c.wish.whereText) || !filled(c.wish.need));
        check('every Wish List car has a location card', noCard.length === 0, noCard.length ? noCard.map((c) => c.name).join(', ') : wishCars.length + ' cards');
        const strayCard = tracker.cars.filter((c) => !c.wishList && c.wish);
        check('no location card on a car that is not on the Wish List', strayCard.length === 0, strayCard.length ? strayCard.map((c) => c.name).join(', ') : '');
        check('car CSV has one row per car plus a header', rows.length === carCount + 1, rows.length + ' rows');
        const badCarWidth = rows.filter((r) => r.length !== CAR_CSV_COLUMN_COUNT).length;
        check('every car CSV row has ' + CAR_CSV_COLUMN_COUNT + ' columns', badCarWidth === 0, badCarWidth ? badCarWidth + ' rows differ' : '');
      }
      if (!opts.dryRun) {
        check('CSV copy in exports/ matches', readText(PATHS.csvCopy, 'exports copy') === csvOnDisk);
      }
      try {
        new vm.Script(readText(PATHS.appJs, 'app.js'), { filename: 'app.js' });
        check('app.js has no syntax errors', true);
      } catch (err) {
        check('app.js has no syntax errors', false, err.message);
      }
      const html = readText(PATHS.indexHtml, 'index.html');
      check('index.html loads data.js and app.js', html.indexOf('src="data.js"') !== -1 && html.indexOf('src="app.js"') !== -1);
      PEERS.forEach((peer) => check('index.html links to ' + peer.name, html.includes('href="' + appUrl(peer) + '"')));
      check('index.html advertises and links its RSS feed',
        html.includes('<link rel="alternate" type="application/rss+xml"') &&
        html.includes('class="rss-link" href="feed.xml"') && html.includes('Get RSS alerts!'));
      /* Lag and network failures are expected occasionally, so drift only warns. */
      await Promise.all(PEERS.map(async (peer) => {
        const base = 'https://raw.githubusercontent.com/rolltidehero/' + peer.slug + '/master/';
        try {
          const [remote, text] = await Promise.all([fetchText(base + 'update-tracker.js'), fetchText(base + 'tracker-data.json')]);
          const norm = (t) => t.replace(/\r\n/g, '\n');
          if (norm(remote) === norm(fs.readFileSync(__filename, 'utf8'))) info('Script matches ' + peer.slug);
          else warn('update-tracker.js differs from ' + peer.slug + '. Synchronize the script across all repositories.');
          const otherData = JSON.parse(text);
          const mine = data.sources || {};
          const theirs = otherData.sources || {};
          const shared = Object.keys(mine).filter((k) => Object.prototype.hasOwnProperty.call(theirs, k));
          const diff = shared.filter((k) => !same(mine[k], theirs[k]));
          if (diff.length) warn('Shared source(s) differ from ' + peer.slug + ': ' + diff.join(', '));
          else info(shared.length + ' shared sources match ' + peer.slug + '.');
        } catch (err) {
          info('Skipped cross-repo checks for ' + peer.slug + ': ' + String(err.message).split('\n')[0]);
        }
      }));
      const failed = checks.filter((ok) => !ok).length;
      if (failed) throw new StepError(failed + ' self-test check' + (failed === 1 ? '' : 's') + ' failed.', 'See the FAIL lines above. The previous files are restored automatically.', 2);
      step.note = checks.length + ' checks passed';
    });

    /* ---- Step 9 ---- */
    await runStep(8, (step) => {
      let previous = null;
      let baseRevision = '';
      if (hasGit) {
        try {
          previous = loadDataJs(git(['show', 'HEAD:data.js'], { maxBuffer: 64 * 1024 * 1024 }), 'data.js from the last commit');
          baseRevision = git(['log', '-1', '--format=%H', '--', 'data.js']);
        } catch (err) {
          info('No earlier data.js in git to compare with (' + String(err.message).split('\n')[0] + ')');
        }
      }
      report = buildReport(previous, resolved, opts);
      report.carRefresh = carRefresh || { result: 'not requested' };
      report.commit = null; /* filled in by step 11 when a commit is made */
      printReport(report);
      const previousXml = fs.existsSync(PATHS.feed) ? readText(PATHS.feed, 'RSS feed') : '';
      const feed = renderFeed(previousXml, report, baseRevision);
      if (feed !== previousXml) {
        if (opts.dryRun) info('RSS: would publish a feed item');
        else {
          remember(PATHS.feed);
          wroteFiles = true;
          writeAtomic(PATHS.feed, feed);
          info('RSS: wrote a new item to feed.xml');
        }
      } else info('RSS: no new item');
      if (!opts.dryRun) {
        writeAtomic(PATHS.report, JSON.stringify(report, null, 2) + '\n');
        info('Saved the report to ' + PATHS.report);
      }
      step.note = report.hasChanges ? (report.added.length + ' added, ' + report.removed.length + ' removed, ' + report.changed.length + ' changed') : 'no differences';
    });

    /* ---- Step 10 ---- */
    await runStep(9, async (step) => {
      if (!opts.checkLinks) { skip(step, 'run with --check-links to enable'); return; }
      if (typeof fetch !== 'function') { skip(step, 'this Node.js version has no fetch'); return; }
      const results = await checkLinks(data.sources);
      const group = (name) => results.filter((r) => r.result === name);
      info('OK: ' + group('ok').length + '   Blocked by the site: ' + group('blocked').length + '   Broken: ' + group('broken').length + '   No response: ' + group('error').length);
      group('broken').forEach((r) => warn('Broken link (HTTP ' + r.status + '): ' + r.key + ' ' + r.url));
      group('error').forEach((r) => warn('No response (' + r.reason + '): ' + r.key + ' ' + r.url));
      group('blocked').forEach((r) => info('Blocked (HTTP ' + r.status + ', usually bot protection, the link is probably fine): ' + r.key));
      if (report) {
        report.linkCheck = { ok: group('ok').length, blocked: group('blocked').map((r) => r.key), broken: group('broken').map((r) => r.key), noResponse: group('error').map((r) => r.key) };
        report.warnings = warnings.slice();
        if (!opts.dryRun) writeAtomic(PATHS.report, JSON.stringify(report, null, 2) + '\n');
      }
      step.note = group('ok').length + ' ok, ' + (group('broken').length + group('error').length) + ' need a look';
    });

    /* ---- Step 11 ---- */
    await runStep(10, (step) => {
      if (opts.dryRun) { skip(step, 'dry run'); return; }
      if (!opts.commit) { skip(step, '--no-commit was given'); return; }
      if (!hasGit) { skip(step, 'no git repository in this folder'); return; }
      try {
        git(['add', '-A']);
        let staged = '';
        try { git(['diff', '--cached', '--quiet']); } catch (e) { staged = git(['diff', '--cached', '--name-only']); }
        if (!staged) { skip(step, 'nothing changed since the last commit'); return; }
        info('Files in this commit: ' + staged.split('\n').join(', '));
        const subject = opts.message || (opts.auto ? 'Automatic refresh (' + data.meta.asOf + ')' : 'Update tracker data (' + data.meta.asOf + ')');
        const body = [];
        if (report) {
          body.push('Entries: ' + report.totals.entries + '. Added ' + report.added.length + ', removed ' + report.removed.length + ', changed ' + report.changed.length + '.');
          report.added.forEach((e) => body.push('+ ' + e.id + ' ' + e.name));
          report.removed.forEach((e) => body.push('- ' + e.id + ' ' + e.name));
          report.changed.slice(0, 30).forEach((e) => body.push('~ ' + e.id + ': ' + e.fields.map((f) => f.field).join(', ')));
          const cc = report.carChanges;
          if (cc.added.length + cc.removed.length + cc.valueChanged.length) body.push('Car value list (' + report.totals.cars + ' cars): ' + cc.added.length + ' added, ' + cc.removed.length + ' removed, ' + cc.valueChanged.length + ' repriced.');
          if (cc.wishChanged.length) body.push('Wish List location cards: ' + cc.wishChanged.length + ' added or edited.');
          if (report.otherSectionsChanged.length) body.push('Sections edited: ' + report.otherSectionsChanged.join(', ') + '.');
        }
        git(['commit', '-q', '-m', subject, '-m', body.join('\n') || 'Rebuilt generated files.', '-m', COMMIT_TRAILER]);
        const hash = git(['rev-parse', '--short', 'HEAD']);
        info('Created commit ' + hash + ': ' + subject);
        step.note = 'commit ' + hash;
        /* Record the commit in the change report so other tools can tell "new commit" from "nothing changed". */
        if (report) {
          report.commit = hash;
          try { writeAtomic(PATHS.report, JSON.stringify(report, null, 2) + '\n'); } catch (e) { /* the report is optional */ }
        }
      } catch (err) {
        const detail = String((err.stderr && err.stderr.toString()) || err.message).trim().split('\n').slice(-3).join(' | ');
        throw new StepError('Git commit failed: ' + detail, 'The rebuilt files are fine and stay in place. If git asks who you are, run: git config user.name "Your Name" and git config user.email "you@example.com". Or run again with --no-commit.', 2);
      }
    });

    /* ---- Step 12 ---- */
    await runStep(11, (step) => {
      const record = (result, detail) => {
        pushResult = { result, detail: detail || '' };
        if (report) {
          report.push = pushResult;
          report.warnings = warnings.slice();
          try { writeAtomic(PATHS.report, JSON.stringify(report, null, 2) + '\n'); } catch (e) { /* the report is optional */ }
        }
      };
      if (opts.dryRun) { skip(step, 'dry run'); return; }
      if (!opts.push) { skip(step, '--no-push was given'); record('skipped', '--no-push'); return; }
      if (!hasGit) { skip(step, 'no git repository in this folder'); record('skipped', 'no git repository'); return; }
      let remoteUrl = '';
      try { remoteUrl = git(['remote', 'get-url', 'origin']); } catch (err) { /* no remote configured */ }
      if (!remoteUrl) {
        skip(step, 'no remote called "origin"');
        record('skipped', 'no remote');
        info('To publish this folder: gh repo create <name> --private --source . --remote origin --push');
        return;
      }
      let branch = '';
      try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD']); } catch (err) { /* handled below */ }
      if (!branch || branch === 'HEAD') {
        soft(step, 'not on a branch', 'Nothing was pushed because git is not on a branch. Run: git checkout master (or your main branch) and run the script again.');
        record('failed', 'detached HEAD');
        return;
      }
      const local = git(['rev-parse', 'HEAD']);
      info('Remote: ' + remoteUrl + '   Branch: ' + branch);
      /* Ask the remote what it has, so "push when changed" is decided on facts. */
      let remoteHead = null;
      try {
        const out = git(['ls-remote', 'origin', 'refs/heads/' + branch], { timeout: 30000 });
        remoteHead = out ? out.split(/\s+/)[0] : '';
      } catch (err) {
        const detail = String((err.stderr && err.stderr.toString()) || err.message).trim().split('\n').slice(-2).join(' | ');
        soft(step, 'could not reach the remote', 'Push skipped, the remote did not answer: ' + detail + '. Your commit is safe locally. Check the network and your GitHub login (gh auth login), then run: git push origin ' + branch);
        record('failed', detail);
        return;
      }
      if (remoteHead === local) {
        skip(step, 'GitHub already has the latest commit');
        record('up to date', local.slice(0, 7));
        return;
      }
      info(remoteHead ? 'GitHub is at ' + remoteHead.slice(0, 7) + ', local is at ' + local.slice(0, 7) + '. Pushing...' : 'The branch does not exist on GitHub yet. Pushing...');
      try {
        try {
          git(['push', '-u', 'origin', branch], { timeout: 120000 });
        } catch (firstErr) {
          const firstText = String((firstErr.stderr && firstErr.stderr.toString()) || firstErr.message);
          if (!/rejected|non-fast-forward|fetch first/.test(firstText)) throw firstErr;
          /* Someone else pushed first. Put this commit on top of theirs and try once more. */
          info('GitHub has newer commits. Rebasing this commit on top of them and retrying...');
          try {
            git(['pull', '--rebase', 'origin', branch], { timeout: 120000 });
          } catch (rebaseErr) {
            try { git(['rebase', '--abort']); } catch (e) { /* nothing to abort */ }
            throw firstErr;
          }
          git(['push', '-u', 'origin', branch], { timeout: 120000 });
        }
        const pushed = git(['rev-parse', 'HEAD']);
        info('Pushed ' + pushed.slice(0, 7) + ' to origin/' + branch);
        step.note = 'pushed ' + pushed.slice(0, 7);
        record('pushed', pushed.slice(0, 7));
      } catch (err) {
        const text = String((err.stderr && err.stderr.toString()) || err.message).trim();
        const detail = text.split('\n').slice(-3).join(' | ');
        const hint = /rejected|non-fast-forward|fetch first/.test(text)
          ? 'GitHub has commits this folder does not have. Run: git pull --rebase origin ' + branch + ' and then run the script again.'
          : 'Check your GitHub login (gh auth login) and that you may write to the repository, then run: git push origin ' + branch;
        soft(step, 'push failed, commit kept locally', 'Git push failed: ' + detail + '. ' + hint);
        record('failed', detail);
      }
    });

    /* ---- Step 13 ---- */
    await runStep(12, async (step) => {
      if (APP === 'cars') { skip(step, 'the page watch belongs to the Glitch and Money Trackers'); return; }
      if (!opts.watch) { skip(step, 'run with --auto or --watch to enable'); return; }
      if (typeof fetch !== 'function') { skip(step, 'this Node.js version has no fetch'); return; }
      let found;
      try {
        found = await watchPages(data);
      } catch (err) {
        soft(step, 'watch failed', 'The page watch stopped: ' + err.message + '. The rebuild itself is fine.');
        return;
      }
      info('Current build in the tracker: ' + found.currentBuild);
      if (APP === 'glitch') info('Newer build numbers seen: ' + (found.newBuilds.length ? found.newBuilds.map((b) => b.version + ' on ' + b.pages.length + ' page(s)').join(', ') : 'none'));
      if (APP === 'money') info('CodeKingGTA vehicle duplication row: ' + (found.dupeRow && found.dupeRow.found ? '"' + found.dupeRow.status + '"' : 'not read'));
      found.failures.forEach((f) => warn('Watch could not read ' + f));
      found.alerts.forEach((a) => info('ALERT FOR REVIEW: ' + a.title));
      if (report) { report.watch = found; try { writeAtomic(PATHS.report, JSON.stringify(report, null, 2) + '\n'); } catch (e) { /* optional */ } }
      if (!opts.dryRun) {
        writeAtomic(PATHS.watch, JSON.stringify(found, null, 2) + '\n');
        info('Saved the watch result to ' + PATHS.watch);
      }
      step.note = found.alerts.length ? found.alerts.length + ' item(s) for review' : 'nothing new';
    });
  } catch (err) {
    const failed = STEPS.find((s) => s.state === 'failed');
    /* A failed commit must not undo a good rebuild. Everything else is rolled back. */
    const keepFiles = failed && failed.n >= 11;
    const restored = keepFiles ? false : restore();
    console.log('\n' + RULE);
    console.log('STOPPED' + (failed ? ' at step ' + failed.n + ' (' + failed.name + ')' : ''));
    console.log(RULE);
    console.log('Problem: ' + (err && err.message ? err.message : String(err)));
    if (err instanceof StepError && err.hint) console.log('How to fix: ' + err.hint);
    if (!(err instanceof StepError)) {
      console.log('How to fix: this was not expected. The details below help with troubleshooting.');
      console.log(err && err.stack ? err.stack : err);
    }
    console.log(restored ? 'Rollback: the previous data.js, CSV files and tracker-data.json were restored.' : (keepFiles ? 'Rollback: not needed. The rebuilt files were kept.' : 'Rollback: not needed. No files had been changed.'));
    console.log('\nStep summary:');
    board();
    const c = counts();
    console.log('\nCompleted: ' + c.done + '   With warning: ' + c.warned + '   Skipped: ' + c.skipped + '   Failed: ' + c.failed + '   Not reached: ' + c.pending);
    return err instanceof StepError ? err.code : 2;
  }

  /* ---- Final summary ---- */
  console.log('\n' + RULE);
  console.log(opts.dryRun ? 'DRY RUN FINISHED: the data is valid, nothing was written' : 'FINISHED');
  console.log(RULE);
  board();
  const c = counts();
  console.log('\nCompleted: ' + c.done + '   With warning: ' + c.warned + '   Skipped: ' + c.skipped + '   Failed: 0   Remaining: 0');
  if (warnings.length) {
    console.log('\nWarnings (' + warnings.length + '):');
    warnings.forEach((w, i) => console.log('  ' + (i + 1) + '. ' + w));
  }
  if (!opts.dryRun) {
    console.log('\nFiles:');
    console.log('  Website data : ' + PATHS.dataJs);
    console.log('  CSV          : ' + PATHS.csv);
    console.log('  Change report: ' + PATHS.report);
    console.log('  GitHub push  : ' + (pushResult ? pushResult.result + (pushResult.detail ? ' (' + pushResult.detail + ')' : '') : 'not attempted'));
    console.log('\nNext step: the GitHub Pages site rebuilds itself after a push (about a minute).');
    console.log('           Any other hosted copy has to be published again to show the new data.');
  }
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error('\nUnexpected failure before the steps started: ' + (err && err.message ? err.message : err));
    if (err instanceof StepError && err.hint) console.error('How to fix: ' + err.hint);
    process.exitCode = err instanceof StepError ? err.code : 2;
  }
);
