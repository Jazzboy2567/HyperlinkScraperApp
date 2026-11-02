// extensions.js — LinkWatch extension loader
//
// An "extension" is a folder containing a manifest.json and an index.js. LinkWatch
// discovers extensions from two places:
//   • bundled  — <app>/extensions/            (ships with LinkWatch, updates via git)
//   • user     — <userData>/extensions/        (yours + ones others share; survives updates)
// A user extension with the same id overrides a bundled one.
//
// Types recognized:
//   • "ranker"  — exports rank(links, ctx) -> links. Runs inside LinkWatch after each
//                 scrape to reorder / filter / annotate results. (Wired — see runRankers.)
//   • "panel"   — contributes its OWN sidebar item + UI panel to the app, backend IPC
//                 methods, private storage, and optional result-row actions. This lets an
//                 extension add whole features (e.g. the Applications tracker) that can be
//                 installed and deleted like any other extension. (Wired — see host API.)
//   • "adapter" — per-site scrape rules, applied in the scraper process (site_adapters.js).
//
// TRUST: an enabled extension's index.js runs as real Node code with full access to this
// machine, and a "panel" extension's UI code runs in the app window. Code is only loaded
// for extensions the user has turned ON. Treat a stranger's extension like any other
// program you install — only enable ones you trust.

const fs = require('fs');
const path = require('path');

let BUNDLED_DIR = null;
let USER_DIR = null;
let USER_DATA = null;                 // for per-extension storage (<userData>/ext-data/<id>.json)
let log = () => {};
let getEnabledMap = () => ({});       // () => { [id]: bool }
let setEnabledMap = () => {};         // (map) => void  (persist)
let emitEvent = () => {};             // (id, event, data) => void  (push to renderer)
let HELPERS = {};                     // core helpers exposed to extensions

let registry = [];   // [{ id, name, type, version, ..., source, dir, module, error, enabled }]
let handlers = {};   // { [id]: { [method]: fn } }  — backend methods a panel extension registers

function readManifest(dir) {
  const mp = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mp)) return null;
  try { return JSON.parse(fs.readFileSync(mp, 'utf8')); }
  catch (e) { return { __error: `invalid manifest.json: ${e.message}` }; }
}

// A tiny persisted JSON store handed to each extension. Lives in a per-extension file
// so uninstalling one never touches another's data.
function makeStore(id) {
  const dataDir = path.join(USER_DATA, 'ext-data');
  const file = path.join(dataDir, `${id}.json`);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { data = {}; }
  const save = () => {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
    catch (e) { log('warn', `[${id}] could not save store: ${e.message}`); }
  };
  return {
    file,
    all: () => data,
    get: (k) => (k == null ? data : data[k]),
    set: (k, v) => { if (v === undefined && typeof k === 'object') data = k; else data[k] = v; save(); },
    replace: (obj) => { data = obj; save(); },
    save,
  };
}

// The host object every extension's init(host) receives.
function makeHost(rec) {
  return {
    id: rec.id,
    dir: rec.dir,
    source: rec.source,
    version: rec.version,
    log: (lvl, msg) => log(lvl, `[${rec.id}] ${msg}`),
    paths: {
      userData: USER_DATA,
      dir: rec.dir,
      cache: path.join(USER_DATA, 'ext-cache'),
    },
    store: makeStore(rec.id),
    // Register a backend method the renderer can call via api.extInvoke(id, method, payload).
    ipc: {
      handle: (method, fn) => {
        handlers[rec.id] = handlers[rec.id] || {};
        handlers[rec.id][method] = fn;
      },
    },
    // Push an event to the app window: renderer receives ('ext-event', {id, event, data}).
    emit: (event, data) => emitEvent(rec.id, event, data),
    // Core helpers (URL title/company derivation, normalization) so extensions don't
    // have to re-implement them.
    helpers: HELPERS,
  };
}

function loadOne(dir, source, enabledMap) {
  const man = readManifest(dir);
  if (!man) return null;
  const id = man.id || path.basename(dir);
  const panel = man.panel || null;
  const rec = {
    id,
    name: man.name || id,
    type: man.type || 'ranker',
    version: man.version || '0.0.0',
    description: man.description || '',
    author: man.author || 'unknown',
    order: typeof man.order === 'number' ? man.order : 100,
    updateUrl: man.updateUrl || null,
    // UI contributions (panel extensions)
    panel: panel ? {
      title: panel.title || man.name || id,
      icon: panel.icon || '',          // inline SVG string
      entry: panel.entry || 'panel.js',
      css: panel.css || null,
    } : null,
    rowActions: Array.isArray(man.rowActions) ? man.rowActions : [],
    source, dir,
    module: null,
    error: man.__error || null,
    enabled: (id in enabledMap) ? !!enabledMap[id] : (man.enabledByDefault === true),
  };
  if (rec.error) return rec;

  // Only execute code for extensions the user has enabled.
  if (rec.enabled) {
    // clear any previously-registered backend methods for this id (reload safety)
    delete handlers[id];
    try {
      const entry = path.join(dir, man.main || 'index.js');
      try { delete require.cache[require.resolve(entry)]; } catch (_) {}
      const mod = require(entry);
      rec.module = mod;
      if (mod && typeof mod.init === 'function') mod.init(makeHost(rec));
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
    if (name.startsWith('.')) continue;          // skip .cache, dotfiles, .git
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
  BUNDLED_DIR   = opts.bundledDir;
  USER_DIR      = opts.userDir;
  USER_DATA     = opts.userData || USER_DATA;
  log           = opts.log || log;
  getEnabledMap = opts.getEnabledMap || getEnabledMap;
  setEnabledMap = opts.setEnabledMap || setEnabledMap;
  emitEvent     = opts.emit || emitEvent;
  HELPERS       = opts.helpers || {};
  reload();
}

function reload() {
  const enabledMap = getEnabledMap() || {};
  handlers = {};                                  // re-registered by each enabled extension below
  const out = [];
  scanDir(BUNDLED_DIR, 'bundled', enabledMap, out);
  scanDir(USER_DIR,    'user',    enabledMap, out);
  registry = out;

  const rankers = registry.filter(r => r.type === 'ranker' && r.enabled && r.module);
  const panels  = registry.filter(r => r.type === 'panel'  && r.enabled && r.module);
  log('info', `Extensions: ${registry.length} found, ${rankers.length} ranker(s), ${panels.length} panel(s) active`);
  registry.filter(r => r.error).forEach(r => log('warn', `Extension "${r.id}" error: ${r.error}`));
  return registry;
}

function list() {
  return registry.map(r => ({
    id: r.id, name: r.name, type: r.type, version: r.version,
    description: r.description, author: r.author, source: r.source,
    enabled: r.enabled, error: r.error, dir: r.dir, updateUrl: r.updateUrl,
    hasPanel: !!r.panel,
  }));
}

// Metadata the renderer needs to mount each enabled panel extension's UI.
function uiExtensions() {
  return registry
    .filter(r => r.enabled && !r.error && (r.panel || r.rowActions.length))
    .map(r => ({
      id: r.id,
      name: r.name,
      panel: r.panel,                 // {title, icon, entry, css} or null
      rowActions: r.rowActions,       // [{id, label, activeLabel, method, activeUrlsMethod}]
      source: r.source,
    }));
}

// Read a file from inside an extension's own folder (its panel code/CSS). Guarded so an
// extension id can only reach files within its own directory.
function readFile(id, rel) {
  const rec = registry.find(r => r.id === id);
  if (!rec) throw new Error('unknown extension');
  const base = path.resolve(rec.dir);
  const full = path.resolve(base, rel || '');
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('path outside extension');
  return fs.readFileSync(full, 'utf8');
}

// Call a backend method an enabled panel extension registered via host.ipc.handle.
async function invoke(id, method, payload) {
  const h = handlers[id] && handlers[id][method];
  if (typeof h !== 'function') throw new Error(`no handler ${id}.${method}`);
  return await h(payload);
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
// A ranker that throws is skipped so one bad extension can never break scraping.
async function runRankers(links, ctx) {
  let cur = Array.isArray(links) ? links : [];
  for (const r of activeRankers()) {
    try {
      const fn = typeof r.module.rank === 'function' ? r.module.rank : r.module;
      const res = await fn(cur, { ...ctx, log: (lvl, msg) => log(lvl, `[${r.id}] ${msg}`), dir: r.dir });
      if (Array.isArray(res)) cur = res;
    } catch (e) {
      log('warn', `Ranker "${r.id}" failed: ${e.message}`);
    }
  }
  return cur;
}

module.exports = {
  init, reload, list, uiExtensions, readFile, invoke,
  setEnabled, runRankers, activeRankers,
  dirs: () => ({ bundled: BUNDLED_DIR, user: USER_DIR }),
};
