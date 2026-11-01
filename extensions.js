// extensions.js — LinkWatch extension loader
//
// An "extension" is a folder containing a manifest.json and an index.js. LinkWatch
// discovers extensions from two places:
//   • bundled  — <app>/extensions/            (ships with LinkWatch, updates via git)
//   • user     — <userData>/extensions/        (yours + ones others share; survives updates)
// A user extension with the same id overrides a bundled one.
//
// Two types are recognized:
//   • "ranker"  — exports rank(links, ctx) -> links. Runs inside LinkWatch after each
//                 scrape to reorder / filter / annotate results. (Wired — see runRankers.)
//   • "adapter" — per-site scrape rules. Listed here for visibility, but adapters are
//                 applied inside the scraper process (site_adapters.js), not here.
//
// TRUST: an enabled extension's index.js runs as real Node code with full access to this
// machine. Code is only require()'d for extensions the user has turned ON. Treat a
// stranger's extension like any other program you install — only enable ones you trust.

const fs = require('fs');
const path = require('path');

let BUNDLED_DIR = null;
let USER_DIR = null;
let log = () => {};
let getEnabledMap = () => ({});     // () => { [id]: bool }
let setEnabledMap = () => {};       // (map) => void  (persist)

let registry = [];  // [{ id, name, type, version, description, author, order, source, dir, module, error, enabled }]

function readManifest(dir) {
  const mp = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mp)) return null;
  try { return JSON.parse(fs.readFileSync(mp, 'utf8')); }
  catch (e) { return { __error: `invalid manifest.json: ${e.message}` }; }
}

function loadOne(dir, source, enabledMap) {
  const man = readManifest(dir);
  if (!man) return null;
  const id = man.id || path.basename(dir);
  const rec = {
    id,
    name: man.name || id,
    type: man.type || 'ranker',
    version: man.version || '0.0.0',
    description: man.description || '',
    author: man.author || 'unknown',
    order: typeof man.order === 'number' ? man.order : 100,
    // Optional: a URL returning JSON like {"version":"1.2.0","downloadUrl":"…","notes":"…"}.
    // If set, LinkWatch checks it and shows an update dot when a newer version exists.
    updateUrl: man.updateUrl || null,
    source, dir,
    module: null,
    error: man.__error || null,
    // default-off unless the manifest opts in; a stored choice always wins
    enabled: (id in enabledMap) ? !!enabledMap[id] : (man.enabledByDefault === true),
  };
  if (rec.error) return rec;

  // Only execute code for extensions the user has enabled.
  if (rec.enabled) {
    try {
      const entry = path.join(dir, man.main || 'index.js');
      try { delete require.cache[require.resolve(entry)]; } catch (_) {}
      const mod = require(entry);
      rec.module = mod;
      if (mod && typeof mod.init === 'function') {
        mod.init({ dir, log: (lvl, msg) => log(lvl, `[${id}] ${msg}`) });
      }
    } catch (e) {
      rec.error = e.message;
      rec.module = null;
    }
  }
  return rec;
}

function scanDir(baseDir, source, enabledMap, out) {
  if (!baseDir || !fs.existsSync(baseDir)) return;
  let names = [];
  try { names = fs.readdirSync(baseDir); } catch (_) { return; }
  for (const name of names) {
    if (name.startsWith('.')) continue;          // skip .cache, dotfiles
    const dir = path.join(baseDir, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch (_) { continue; }
    const rec = loadOne(dir, source, enabledMap);
    if (!rec) continue;
    const i = out.findIndex(r => r.id === rec.id);
    if (i >= 0) out[i] = rec;                     // user overrides bundled
    else out.push(rec);
  }
}

function init(opts) {
  BUNDLED_DIR    = opts.bundledDir;
  USER_DIR       = opts.userDir;
  log            = opts.log || log;
  getEnabledMap  = opts.getEnabledMap || getEnabledMap;
  setEnabledMap  = opts.setEnabledMap || setEnabledMap;
  reload();
}

function reload() {
  const enabledMap = getEnabledMap() || {};
  const out = [];
  scanDir(BUNDLED_DIR, 'bundled', enabledMap, out);   // bundled first
  scanDir(USER_DIR,    'user',    enabledMap, out);    // user overrides
  registry = out;

  const rankers = registry.filter(r => r.type === 'ranker' && r.enabled && r.module);
  log('info', `Extensions: ${registry.length} found, ${rankers.length} ranker(s) active`);
  registry.filter(r => r.error).forEach(r => log('warn', `Extension "${r.id}" error: ${r.error}`));
  return registry;
}

function list() {
  return registry.map(r => ({
    id: r.id, name: r.name, type: r.type, version: r.version,
    description: r.description, author: r.author, source: r.source,
    enabled: r.enabled, error: r.error, dir: r.dir, updateUrl: r.updateUrl,
  }));
}

function setEnabled(id, on) {
  const m = getEnabledMap() || {};
  m[id] = !!on;
  setEnabledMap(m);
  reload();
  return list();
}

function activeRankers() {
  return registry
    .filter(r => r.type === 'ranker' && r.enabled && r.module &&
                 (typeof r.module.rank === 'function' || typeof r.module === 'function'))
    .sort((a, b) => a.order - b.order);
}

// Run every enabled ranker, in `order`, passing the output of one into the next.
// A ranker that throws is skipped (its output discarded) so one bad extension can
// never break scraping.
async function runRankers(links, ctx) {
  let cur = Array.isArray(links) ? links : [];
  for (const r of activeRankers()) {
    try {
      const fn = typeof r.module.rank === 'function' ? r.module.rank : r.module;
      const res = await fn(cur, {
        ...ctx,
        log: (lvl, msg) => log(lvl, `[${r.id}] ${msg}`),
        dir: r.dir,
      });
      if (Array.isArray(res)) cur = res;
    } catch (e) {
      log('warn', `Ranker "${r.id}" failed: ${e.message}`);
    }
  }
  return cur;
}

module.exports = {
  init, reload, list, setEnabled, runRankers, activeRankers,
  dirs: () => ({ bundled: BUNDLED_DIR, user: USER_DIR }),
};
