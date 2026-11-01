const { app, BrowserWindow, ipcMain, Notification, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const extensions = require('./extensions');

// ── Paths ──────────────────────────────────────────────────────────────────
const USER_DATA = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DATA, 'config.json');
const RESULTS_PATH = path.join(USER_DATA, 'results.json');
const SEEN_PATH = path.join(USER_DATA, 'seen_links.json');

// Extensions: bundled (ships with the app, updates via git) + user (yours and
// ones others share; lives in userData so app updates never clobber them).
const EXT_BUNDLED_DIR = path.join(__dirname, 'extensions');
const EXT_USER_DIR = path.join(USER_DATA, 'extensions');
const EXT_CACHE_DIR = path.join(USER_DATA, 'ext-cache');   // scratch for rankers

const BUNDLED_SCRAPER = path.join(__dirname, 'scraper', 'scraper.js');
// The main HyperlinkScraper project (sibling folder) is the single source of
// truth. We run it directly when present, so improvements there are live with
// no copying/drift; the bundled copy is a fallback for when it's absent.
const MAIN_SCRAPER = path.join(__dirname, '..', 'HyperlinkScraper', 'scraper.js');

function resolveScraper() {
  if (config.scraperPath && fs.existsSync(config.scraperPath)) return config.scraperPath; // user override
  if (fs.existsSync(MAIN_SCRAPER)) return MAIN_SCRAPER;                                    // single source
  return BUNDLED_SCRAPER;                                                                  // fallback
}

// ── State ──────────────────────────────────────────────────────────────────
let mainWindow = null;
let scraperProcess = null;
let serverReady = false;
let schedulerTimers = {};
let seenLinks = new Set();
let results = [];
let config = {};
let liveScraperPort = null;
let scrapeInProgress = {};
let keepServerWarm = false;   // true = user pinned the server on (no idle-sleep)
let idleTimer = null;         // stops the server after a stretch with no scrapes
let serverStarting = false;   // guards against double-starting on concurrent wakes

// ── Storage helpers ────────────────────────────────────────────────────────
function loadJSON(filePath, defaultVal) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return defaultVal;
  }
}

function saveJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    sendLog('error', `Failed to write ${path.basename(filePath)}: ${err.message}`);
  }
}

const MAX_RESULTS = 2000;

function loadAll() {
  config = loadJSON(CONFIG_PATH, { notifyOnFail: false, urls: [] });
  config.scraperPath = resolveScraper();   // main project if present, else bundled
  results = loadJSON(RESULTS_PATH, []);
  seenLinks = new Set(loadJSON(SEEN_PATH, []));
}

function saveConfig() {
  const toSave = { ...config };
  delete toSave.scraperPath;
  saveJSON(CONFIG_PATH, toSave);
}
function saveResults() { saveJSON(RESULTS_PATH, results); }
function saveSeenLinks() { saveJSON(SEEN_PATH, [...seenLinks]); }

// ── Extensions ───────────────────────────────────────────────────────────────
// Convert a scraped link into a stored result link, carrying through any fields
// a ranker added (score, badges, matched skills) so the UI can show them.
function toLinkEntry(l) {
  const e = { title: l.text || l.title || 'Untitled', url: l.url };
  if (typeof l.score === 'number') e.score = l.score;
  if (Array.isArray(l.badges) && l.badges.length) e.badges = l.badges;
  if (Array.isArray(l.matchedSkills) && l.matchedSkills.length) e.matchedSkills = l.matchedSkills;
  if (l.ats) e.ats = l.ats;
  if (l.noLogin) e.noLogin = true;
  return e;
}

function writeExtReadme() {
  const p = path.join(EXT_USER_DIR, 'README.txt');
  if (fs.existsSync(p)) return;
  const txt =
`LinkWatch extensions
====================

Drop an extension FOLDER in here. Each folder needs:
  manifest.json   { "id", "name", "type": "ranker", "version", "description", "main": "index.js" }
  index.js        module.exports = { rank(links, ctx) { ...return links... } }

A "ranker" runs after every scrape and can reorder / filter / annotate the
results (e.g. sort best job matches first). Enable it in Settings > Extensions.

WARNING: an enabled extension runs as a real program with full access to your
computer. Only enable extensions you wrote or trust. Code is never executed for
an extension that is turned off.

See the bundled "resume-match" extension for a working example.
`;
  try { fs.writeFileSync(p, txt); } catch (_) {}
}

function initExtensions() {
  config.extensions = config.extensions || { enabled: {} };
  try { fs.mkdirSync(EXT_USER_DIR, { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(EXT_CACHE_DIR, { recursive: true }); } catch (_) {}
  writeExtReadme();
  extensions.init({
    bundledDir: EXT_BUNDLED_DIR,
    userDir: EXT_USER_DIR,
    log: sendLog,
    getEnabledMap: () => (config.extensions && config.extensions.enabled) || {},
    setEnabledMap: (m) => {
      config.extensions = config.extensions || {};
      config.extensions.enabled = m;
      saveConfig();
    },
  });
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    ['trackingId','refId','trk','position','pageNum','sessionId','utm_source','utm_medium','utm_campaign']
      .forEach(p => u.searchParams.delete(p));
    return u.origin + u.pathname + (u.search || '');
  } catch { return url; }
}

// ── First-run file init ────────────────────────────────────────────────────
function initScraperFiles() {
  const scraperDir = path.dirname(config.scraperPath || BUNDLED_SCRAPER);
  const defaults = {
    'seen_links.json':       [],
    'cookie_store.json':     {},
    'browser_profiles.json': {}
  };

  for (const [filename, emptyVal] of Object.entries(defaults)) {
    const filePath = path.join(scraperDir, filename);
    if (!fs.existsSync(filePath)) {
      try {
        fs.writeFileSync(filePath, JSON.stringify(emptyVal, null, 2));
      } catch (err) {
        sendLog('error', `Failed to init ${filename}: ${err.message}`);
      }
    }
  }
}

// ── Chromium installer ─────────────────────────────────────────────────────
async function ensureChromium() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    sendLog('error', 'Puppeteer module not found');
    return;
  }

  let execPath;
  try { execPath = puppeteer.executablePath(); } catch { execPath = null; }

  if (execPath && fs.existsSync(execPath)) {
    sendLog('info', 'Chromium already installed.');
    return;
  }

  sendLog('info', 'First run: downloading Chromium (this may take a few minutes)...');
  mainWindow?.webContents.send('server-status', 'downloading-chromium');

  return new Promise((resolve) => {
    let installScript;
    try {
      // Resolves to the actual puppeteer package directory
      const puppeteerPkgDir = path.dirname(require.resolve('puppeteer/package.json'));
      installScript = path.join(puppeteerPkgDir, 'install.mjs');
    } catch (err) {
      sendLog('error', `Could not locate puppeteer install script: ${err.message}`);
      return resolve();
    }

    if (!fs.existsSync(installScript)) {
      sendLog('error', `Puppeteer install script not found at: ${installScript}`);
      return resolve();
    }

    sendLog('info', `Running: node ${installScript}`);

    const proc = spawn('node', [installScript], {
      env: { ...process.env, PUPPETEER_CACHE_DIR: path.join(os.homedir(), '.cache', 'puppeteer') },
      cwd: path.dirname(installScript)
    });

    proc.stdout.on('data', d => {
      const msg = d.toString().trim();
      if (msg) sendLog('info', `[Chromium] ${msg}`);
    });
    proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) sendLog('info', `[Chromium] ${msg}`);
    });
    proc.on('close', code => {
      if (code === 0) sendLog('info', 'Chromium installed successfully.');
      else sendLog('error', `Chromium install exited with code ${code}`);
      resolve();
    });
    proc.on('error', err => {
      sendLog('error', `Chromium install process error: ${err.message}`);
      resolve();
    });
  });
}

// ── Port finder ────────────────────────────────────────────────────────────
function isPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function findFreePort(maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152;
    if (await isPortFree(port)) return port;
    sendLog('warn', `Port ${port} in use, trying another...`);
  }
  return null;
}

// ── Scraper server ─────────────────────────────────────────────────────────
async function startScraperServer() {
  // Guard against double-starts when several scrapes wake the server at once.
  if (scraperProcess || serverStarting) return;
  serverStarting = true;

  const scraperPath = config.scraperPath || resolveScraper();
  if (!fs.existsSync(scraperPath)) {
    serverStarting = false;
    sendLog('error', `Scraper not found at: ${scraperPath}`);
    mainWindow?.webContents.send('server-status', 'error');
    return;
  }
  const usingMain = path.resolve(scraperPath) === path.resolve(MAIN_SCRAPER);
  sendLog('info', `Scraper source: ${usingMain ? 'main HyperlinkScraper project (live)' : 'bundled copy'} — ${scraperPath}`);

  sendLog('info', 'Finding available port...');
  const port = await findFreePort(10);
  if (!port) {
    serverStarting = false;
    sendLog('error', 'Failed to find a free port after 10 attempts. Server not started.');
    mainWindow?.webContents.send('server-status', 'error');
    return;
  }

  liveScraperPort = port;
  sendLog('info', `Starting scraper server on port ${port}...`);

  scraperProcess = spawn('node', [scraperPath], {
    env: { ...process.env, PORT: port },
    cwd: path.dirname(scraperPath)
  });
  serverStarting = false;   // process handle exists; further wakes will see it
  scraperProcess.stdout.on('data', d => {
    const msg = d.toString().trim();
    if (!msg) return;
    sendLog('info', msg);
    if (msg.includes('listening') || msg.includes('is listening')) {
      serverReady = true;
      mainWindow?.webContents.send('server-status', 'running');
      mainWindow?.webContents.send('port-changed', port);
      // Schedulers run independently of the server now (so the server can sleep
      // when idle without stopping scheduled scrapes), so we no longer (re)arm
      // them here — they're armed once on app start.
    }
  });
  scraperProcess.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) sendLog('error', msg);
  });
  scraperProcess.on('close', code => {
    scraperProcess = null;
    serverReady = false;
    liveScraperPort = null;
    mainWindow?.webContents.send('server-status', 'stopped');
    sendLog('warn', `Server exited (code ${code})`);
  });
  scraperProcess.on('error', err => {
    sendLog('error', `Failed to start server: ${err.message}`);
    mainWindow?.webContents.send('server-status', 'error');
  });
}

function stopScraperServer() {
  // NB: schedulers are intentionally NOT stopped here — the server sleeps when
  // idle but scheduled scrapes keep running and wake it on demand. Schedulers
  // are only torn down on app quit.
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const proc = scraperProcess;
  if (proc) {
    proc.kill('SIGTERM');
    setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 3000);
  }
}

// Start the server if it isn't up and resolve once it's ready to accept scrapes.
// Lets scrapes run on demand while the process stays asleep the rest of the time.
function ensureServerReady(timeoutMs = 25000) {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (serverReady && scraperProcess) return Promise.resolve(true);
  return new Promise((resolve) => {
    if (!scraperProcess && !serverStarting) startScraperServer();
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (serverReady && scraperProcess) { clearInterval(iv); resolve(true); }
      else if (!scraperProcess && !serverStarting && Date.now() - t0 > 1500) { clearInterval(iv); resolve(false); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(false); }
    }, 150);
  });
}

// After a scrape, let the server sleep if nothing else is running and the user
// hasn't pinned it on. Cookies live in cookie_store.json on disk, so sleeping
// the process loses nothing.
function scheduleIdleStop() {
  if (keepServerWarm) return;
  if (idleTimer) clearTimeout(idleTimer);
  const mins = Number.isFinite(config.idleStopMinutes) ? config.idleStopMinutes : 3;
  if (mins <= 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (keepServerWarm) return;
    if (Object.keys(scrapeInProgress).length > 0) { scheduleIdleStop(); return; }
    if (scraperProcess) {
      sendLog('info', `Idle for ${mins} min — sleeping the scraper to save memory (cookies stay saved on disk).`);
      stopScraperServer();
    }
  }, mins * 60000);
}

function sendLog(type, message) {
  mainWindow?.webContents.send('server-log', { type, message });
}

// ── RSS feed server ──────────────────────────────────────────────────────────
// Publishes ALL collected job links as an RSS 2.0 feed (plus a JSON variant) so
// the "RSS feed to jobs" matcher can poll them. Read-only; the feed contains
// only public job postings (titles + links), nothing sensitive.
//   http://127.0.0.1:<RSS_PORT>/rss        (RSS 2.0 XML)
//   http://127.0.0.1:<RSS_PORT>/feed.json  (simple JSON)
// Host/port overridable via env; default host is LAN-visible (0.0.0.0) to honor
// "consume from another machine" — set LINKWATCH_RSS_HOST=127.0.0.1 to restrict.
const RSS_PORT = Number(process.env.LINKWATCH_RSS_PORT) || 3777;
const RSS_HOST = process.env.LINKWATCH_RSS_HOST || '0.0.0.0';
let rssServer = null;

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Flatten results (already newest-first) into unique, non-test job items.
function collectFeedItems(limit = 500) {
  const seen = new Set();
  const items = [];
  for (const entry of results) {
    if (entry.isTest) continue;
    for (const link of (entry.links || [])) {
      if (!link || !link.url) continue;
      const key = normalizeUrl(link.url);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        title: link.title || 'Untitled',
        url: link.url,
        source: entry.urlNickname || '',
        date: entry.timestamp,
      });
      if (items.length >= limit) return items;
    }
  }
  return items;
}

function buildRssXml() {
  const items = collectFeedItems();
  const body = items.map(it => `    <item>
      <title>${xmlEscape(it.title)}</title>
      <link>${xmlEscape(it.url)}</link>
      <guid isPermaLink="false">${xmlEscape(normalizeUrl(it.url))}</guid>
      <category>${xmlEscape(it.source)}</category>
      <pubDate>${xmlEscape(new Date(it.date || Date.now()).toUTCString())}</pubDate>
      <description>${xmlEscape(it.source ? ('From ' + it.source) : '')}</description>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>LinkWatch Jobs</title>
    <link>http://127.0.0.1:${RSS_PORT}/rss</link>
    <description>All job links collected by LinkWatch</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${body}
  </channel>
</rss>`;
}

function buildFeedJson() {
  const items = collectFeedItems();
  return JSON.stringify({ title: 'LinkWatch Jobs', generated: new Date().toISOString(), count: items.length, items }, null, 2);
}

function startRssServer() {
  if (rssServer) return;
  rssServer = http.createServer((req, res) => {
    const p = (req.url || '').split('?')[0];
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (p === '/rss' || p === '/api/rss' || p === '/feed.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', ...cors });
      res.end(buildRssXml());
    } else if (p === '/feed.json' || p === '/api/rss.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
      res.end(buildFeedJson());
    } else if (p === '/' || p === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain', ...cors });
      res.end('LinkWatch RSS feed. Try /rss (XML) or /feed.json (JSON).');
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });
  rssServer.on('error', err => sendLog('error', `RSS feed server error: ${err.message} (port ${RSS_PORT})`));
  rssServer.listen(RSS_PORT, RSS_HOST, () => {
    sendLog('info', `RSS feed live at http://127.0.0.1:${RSS_PORT}/rss  (JSON: /feed.json)`);
  });
}

// ── HTTP helper ────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Scrape one URL ─────────────────────────────────────────────────────────
async function scrapeUrl(urlEntry, opts = {}) {
  const { affectMemory = true, isTest = false } = opts;
  // Wake the server on demand (it sleeps when idle to save memory).
  const up = await ensureServerReady();
  const port = liveScraperPort;
  if (!up || !port) {
    sendLog('error', `[${urlEntry.nickname || urlEntry.url}] Scraper didn't start in time`);
    return null;
  }
  const apiUrl = `http://127.0.0.1:${port}/api/scrape?url=${encodeURIComponent(urlEntry.url)}&nocache=true`;

  let data;
  try {
    data = await httpGet(apiUrl);
  } catch (err) {
    sendLog('error', `[${urlEntry.nickname || urlEntry.url}] Scrape failed: ${err.message}`);
    if (config.notifyOnFail && !isTest) {
      new Notification({ title: 'LinkWatch', body: `Failed: ${urlEntry.nickname || urlEntry.url}` }).show();
    }
    return null;
  }

  if (!data || data.error) {
    sendLog('error', `[${urlEntry.nickname || urlEntry.url}] Error: ${data?.error || 'unknown'}`);
    if (config.notifyOnFail && !isTest) {
      new Notification({ title: 'LinkWatch', body: `Error: ${urlEntry.nickname || urlEntry.url}` }).show();
    }
    return null;
  }

  const allLinks = data.externalLinks || [];
  const filters = urlEntry.filters || [];
  let filtered = allLinks;

  if (filters.length > 0) {
    const includeTerms = filters.filter(f => !f.exclude).map(f => f.text.toLowerCase());
    const excludeTerms = filters.filter(f =>  f.exclude).map(f => f.text.toLowerCase());
    // Include: keep a link if its title/url matches ANY include term.
    if (includeTerms.length > 0) {
      filtered = filtered.filter(link => {
        const title = (link.text || '').toLowerCase();
        const href  = (link.url  || '').toLowerCase();
        return includeTerms.some(term => title.includes(term) || href.includes(term));
      });
    }
    // Exclude: then drop any link whose title/url matches ANY exclude term.
    if (excludeTerms.length > 0) {
      filtered = filtered.filter(link => {
        const title = (link.text || '').toLowerCase();
        const href  = (link.url  || '').toLowerCase();
        return !excludeTerms.some(term => title.includes(term) || href.includes(term));
      });
    }
  }

  const newLinks = affectMemory
    ? filtered.filter(link => !seenLinks.has(normalizeUrl(link.url)))
    : filtered;

  if (affectMemory) {
    newLinks.forEach(link => seenLinks.add(normalizeUrl(link.url)));
    if (newLinks.length > 0) saveSeenLinks();
  }

  // Run enabled ranker extensions (sort / filter / annotate). A failure here must
  // never break scraping, so fall back to the raw links on any error.
  let ranked = newLinks;
  try {
    ranked = await extensions.runRankers(newLinks, {
      query: urlEntry.url, urlEntry, cacheDir: EXT_CACHE_DIR, log: sendLog,
    });
  } catch (err) {
    sendLog('warn', `Ranker pipeline error: ${err.message}`);
    ranked = newLinks;
  }

  return { links: ranked, total: filtered.length, urlEntry };
}

// ── Scheduler ──────────────────────────────────────────────────────────────
function getUserTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function getNextRunTime(schedule) {
  const now = new Date();
  const tz = getUserTimezone();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
  });
  const parts = formatter.formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour').value);
  const m = parseInt(parts.find(p => p.type === 'minute').value);
  const s = parseInt(parts.find(p => p.type === 'second').value);
  const currentMinutes = h * 60 + m;
  const interval = schedule.intervalMinutes;

  const startMinutes = schedule.startMinutes !== undefined ? schedule.startMinutes
    : (schedule.startHour !== undefined ? schedule.startHour * 60 : 540);
  const endMinutes = schedule.endMinutes !== undefined ? schedule.endMinutes
    : (schedule.endHour !== undefined ? schedule.endHour * 60 : 1020);

  if (interval >= 1440) {
    if (currentMinutes < startMinutes) return (startMinutes - currentMinutes) * 60 * 1000 - s * 1000;
    const msUntilMidnight = (24 * 60 - currentMinutes) * 60 * 1000;
    return msUntilMidnight + startMinutes * 60 * 1000;
  }

  if (currentMinutes < startMinutes || currentMinutes > endMinutes) return null;
  const minutesSinceStart = currentMinutes - startMinutes;
  const nextSlot = Math.ceil((minutesSinceStart + 1) / interval) * interval;
  if (startMinutes + nextSlot > endMinutes) return null;
  return (nextSlot - minutesSinceStart) * 60 * 1000 - s * 1000;
}

function scheduleUrl(urlEntry) {
  if (schedulerTimers[urlEntry.id]) {
    clearTimeout(schedulerTimers[urlEntry.id].timer);
    delete schedulerTimers[urlEntry.id];
  }
  if (!urlEntry.enabled || !urlEntry.schedule) return;

  const { intervalMinutes } = urlEntry.schedule;
  const isDaily = intervalMinutes >= 1440;
  const startMinutes = urlEntry.schedule.startMinutes !== undefined ? urlEntry.schedule.startMinutes
    : (urlEntry.schedule.startHour !== undefined ? urlEntry.schedule.startHour * 60 : 540);
  const endMinutes = urlEntry.schedule.endMinutes !== undefined ? urlEntry.schedule.endMinutes
    : (urlEntry.schedule.endHour !== undefined ? urlEntry.schedule.endHour * 60 : 1020);

  function tick() {
    const now = new Date();
    const tz = getUserTimezone();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false
    });
    const parts = formatter.formatToParts(now);
    const ch = parseInt(parts.find(p => p.type === 'hour').value);
    const cm = parseInt(parts.find(p => p.type === 'minute').value);
    const curMin = ch * 60 + cm;

    if (isDaily) {
      runScheduled(urlEntry);
      const msNext = getNextRunTime(urlEntry.schedule);
      schedulerTimers[urlEntry.id] = { timer: setTimeout(tick, msNext) };
    } else {
      if (curMin >= startMinutes && curMin <= endMinutes) runScheduled(urlEntry);
      schedulerTimers[urlEntry.id] = { timer: setTimeout(tick, intervalMinutes * 60 * 1000) };
    }
  }

  const msUntilFirst = getNextRunTime(urlEntry.schedule);
  if (msUntilFirst !== null) {
    schedulerTimers[urlEntry.id] = { timer: setTimeout(tick, msUntilFirst) };
    const mins = Math.round(msUntilFirst / 60000);
    const label = mins >= 60 ? `${Math.round(mins/60)}h` : `${mins}m`;
    sendLog('info', `[${urlEntry.nickname || urlEntry.url}] Next run in ${label}`);
  } else if (!isDaily) {
    function waitForWindow() {
      const ms = getNextRunTime(urlEntry.schedule);
      if (ms !== null) {
        schedulerTimers[urlEntry.id] = { timer: setTimeout(tick, ms) };
        sendLog('info', `[${urlEntry.nickname || urlEntry.url}] Window active, next run in ${Math.round(ms/60000)}m`);
      } else {
        schedulerTimers[urlEntry.id] = { timer: setTimeout(waitForWindow, 60000) };
      }
    }
    waitForWindow();
  }
}

async function runScheduled(urlEntry) {
  if (scrapeInProgress[urlEntry.id]) {
    sendLog('warn', `[${urlEntry.nickname || urlEntry.url}] Skipping — scrape already in progress`);
    return true;
  }
  scrapeInProgress[urlEntry.id] = true;
  try {
    sendLog('info', `[${urlEntry.nickname || urlEntry.url}] Running scheduled scrape...`);
    const result = await scrapeUrl(urlEntry, { affectMemory: true, isTest: false });
    if (!result) return false;
    if (result.links.length === 0) {
      sendLog('info', `[${urlEntry.nickname || urlEntry.url}] No new links found.`);
      return true;
    }
    const entry = {
      id: Date.now().toString(),
      urlId: urlEntry.id,
      urlNickname: urlEntry.nickname || urlEntry.url,
      timestamp: new Date().toISOString(),
      links: result.links.map(toLinkEntry),
      isTest: false
    };
    results.unshift(entry);
    if (results.length > MAX_RESULTS) results = results.slice(0, MAX_RESULTS);
    saveResults();
    sendLog('success', `[${urlEntry.nickname || urlEntry.url}] Found ${result.links.length} new links`);
    mainWindow?.webContents.send('new-results', entry);
    return true;
  } finally {
    delete scrapeInProgress[urlEntry.id];
    scheduleIdleStop();
  }
}

function restartAllSchedulers() {
  stopAllSchedulers();
  (config.urls || []).forEach(u => scheduleUrl(u));
}

function stopAllSchedulers() {
  Object.values(schedulerTimers).forEach(t => { if (t.timer) clearTimeout(t.timer); });
  schedulerTimers = {};
}

// ── IPC Handlers ───────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => config);
ipcMain.handle('get-results', () => results);
ipcMain.handle('get-seen-count', () => seenLinks.size);

ipcMain.handle('save-config', (_, newConfig) => {
  const oldUrlsJson = JSON.stringify((config.urls || []).map(u => ({ id: u.id, enabled: u.enabled, schedule: u.schedule })));
  const newUrlsJson = JSON.stringify((newConfig.urls || []).map(u => ({ id: u.id, enabled: u.enabled, schedule: u.schedule })));
  const schedulesChanged = oldUrlsJson !== newUrlsJson;
  config = { ...newConfig, scraperPath: BUNDLED_SCRAPER };
  saveConfig();
  if (schedulesChanged) restartAllSchedulers();
  return true;
});

// Manual pill: "start" pins the server on (no idle-sleep); "stop" lets it sleep.
// Either way, scheduled scrapes keep running and wake it on demand.
ipcMain.handle('server-start', () => { keepServerWarm = true; if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } startScraperServer(); return true; });
ipcMain.handle('server-stop', () => { keepServerWarm = false; stopScraperServer(); return true; });
ipcMain.handle('server-status', () => ({ running: !!scraperProcess, ready: serverReady, warm: keepServerWarm }));

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

ipcMain.handle('run-test', async (_, urlEntry, opts) => {
  const { affectMemory = false } = opts || {};
  sendLog('info', `[TEST] Scraping ${urlEntry.nickname || urlEntry.url}...`);
  const result = await scrapeUrl(urlEntry, { affectMemory, isTest: true });
  scheduleIdleStop();
  if (!result) return { ok: false, links: [] };

  const entry = {
    id: Date.now().toString(),
    urlId: urlEntry.id || 'test',
    urlNickname: (urlEntry.nickname || urlEntry.url) + ' [TEST]',
    timestamp: new Date().toISOString(),
    links: result.links.map(toLinkEntry),
    isTest: true,
    affectedMemory: affectMemory
  };

  if (affectMemory) {
    results.unshift(entry);
    saveResults();
    mainWindow?.webContents.send('new-results', entry);
  }

  return { ok: true, entry, totalFound: result.total, newFound: result.links.length };
});

ipcMain.handle('run-now', async (_, urlId) => {
  const urlEntry = (config.urls || []).find(u => u.id === urlId);
  if (!urlEntry) return { ok: false, error: 'URL not found' };
  const result = await runScheduled(urlEntry);
  return { ok: result !== false };
});

ipcMain.handle('clear-seen-links', () => {
  seenLinks = new Set();
  saveSeenLinks();
  return true;
});

ipcMain.handle('clear-all-results', () => {
  results = [];
  saveResults();
  return true;
});

ipcMain.handle('get-user-data-path', () => USER_DATA);

ipcMain.handle('get-rss-info', () => ({
  port: RSS_PORT,
  url: `http://127.0.0.1:${RSS_PORT}/rss`,
  jsonUrl: `http://127.0.0.1:${RSS_PORT}/feed.json`,
  count: collectFeedItems().length,
}));

// ── Extensions IPC ───────────────────────────────────────────────────────────
ipcMain.handle('list-extensions', () => extensions.list());
ipcMain.handle('set-extension-enabled', (_, id, on) => extensions.setEnabled(id, on));
ipcMain.handle('reload-extensions', () => { extensions.reload(); return extensions.list(); });
ipcMain.handle('get-extensions-dir', () => extensions.dirs());
ipcMain.handle('open-extensions-dir', () => { shell.openPath(EXT_USER_DIR); return EXT_USER_DIR; });

// Apply the enabled rankers to the results ALREADY on screen (e.g. right after
// the user turns a ranker on). Rankers run per result-group, so multiple searches
// each get sorted independently. No-op when no rankers are active.
let reranking = false;
ipcMain.handle('rerank-results', async () => {
  if (reranking) return { ok: false, busy: true };
  if (!extensions.activeRankers().length) return { ok: true, changed: 0 };
  reranking = true;
  let changed = 0;
  try {
    for (const entry of results) {
      if (!Array.isArray(entry.links) || !entry.links.length) continue;
      const input = entry.links.map(l => ({ ...l, text: l.title || l.text }));
      try {
        const ranked = await extensions.runRankers(input, {
          query: entry.urlNickname || '', cacheDir: EXT_CACHE_DIR, log: sendLog,
        });
        entry.links = ranked.map(toLinkEntry);
        changed++;
      } catch (e) { sendLog('warn', `Re-rank failed for one group: ${e.message}`); }
    }
    if (changed) saveResults();
  } finally { reranking = false; }
  sendLog('info', `Re-ranked ${changed} result group(s) with active extensions.`);
  return { ok: true, changed };
});

// ── Scraper update (B) ───────────────────────────────────────────────────────
ipcMain.handle('get-scraper-info', () => {
  const p = config.scraperPath || resolveScraper();
  return { path: p, dir: path.dirname(p),
           usingMain: path.resolve(p) === path.resolve(MAIN_SCRAPER) };
});

function runGit(dir, args) {
  return new Promise((resolve) => {
    const p = spawn('git', ['-C', dir, ...args]);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
    p.on('error', e => resolve({ code: -1, out: '', err: e.message }));
  });
}

async function restartScraper() {
  stopScraperServer();
  for (let i = 0; i < 25 && scraperProcess; i++) await new Promise(r => setTimeout(r, 200));
  startScraperServer();
}

// Pull the latest scraper from GitHub (fast-forward only, so local work is
// never clobbered), then restart the server so new code takes effect.
ipcMain.handle('update-scraper', async () => {
  const dir = path.dirname(config.scraperPath || resolveScraper());
  const check = await runGit(dir, ['rev-parse', '--is-inside-work-tree']);
  if (check.code !== 0) {
    return { ok: false, message: `The scraper folder isn't a git repo, so there's nothing to pull.\n${dir}` };
  }
  sendLog('info', 'Checking for scraper updates...');
  const pull = await runGit(dir, ['pull', '--ff-only']);
  const text = (pull.out + '\n' + pull.err).trim();
  if (pull.code !== 0) {
    return { ok: false, message:
      `Couldn't fast-forward:\n${text}\n\nYour local files were NOT changed. ` +
      `If you have local edits, commit or stash them first; if GitHub has diverged, resolve it in git.` };
  }
  const upToDate = /up to date/i.test(text);
  if (!upToDate) { await restartScraper(); }
  // Clear the scraper dot now that we're current (or re-check if it was a no-op).
  updateStatus.scraper = { available: false, repo: true, tracked: true, behind: 0 };
  sendUpdateStatus();
  sendLog('info', upToDate ? 'Scraper already up to date.' : 'Scraper updated and restarted.');
  return { ok: true, upToDate, message: upToDate ? 'Already up to date.' : `Updated & restarted:\n${text}` };
});

// ── Update checking (non-destructive — just lights the yellow dot) ───────────
// We never pull during a check; we only fetch and compare, so nothing on disk
// changes until the user clicks "Update". The renderer shows a dot on the
// Updates nav (scraper) and the Extensions nav (an extension with a newer
// version available via its manifest updateUrl).
let updateStatus = { scraper: { available: false }, extensions: { available: false, items: [] }, checkedAt: 0 };

function sendUpdateStatus() { mainWindow?.webContents.send('update-status', updateStatus); }

async function scraperUpdateCheck() {
  const dir = path.dirname(config.scraperPath || resolveScraper());
  const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) return { available: false, repo: false };
  await runGit(dir, ['fetch', '--quiet']);
  const rl = await runGit(dir, ['rev-list', '--count', 'HEAD..@{upstream}']);
  if (rl.code !== 0) return { available: false, repo: true, tracked: false };
  const behind = parseInt(rl.out, 10) || 0;
  return { available: behind > 0, repo: true, tracked: true, behind };
}

function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let mod;
    try { mod = new URL(url).protocol === 'http:' ? http : require('https'); }
    catch (e) { return reject(e); }
    const req = mod.get(url, { headers: { 'User-Agent': 'LinkWatch' } }, res => {
      if ((res.statusCode || 0) >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => { d += c; if (d.length > 200000) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

async function extensionsUpdateCheck() {
  const items = [];
  for (const e of extensions.list()) {
    if (!e.updateUrl) continue;   // only extensions that opt in get checked
    try {
      const meta = await fetchJson(e.updateUrl);
      const latest = meta && (meta.version || meta.latest);
      if (latest && cmpVersion(latest, e.version) > 0) {
        items.push({ id: e.id, name: e.name, installed: e.version, latest,
                     url: meta.downloadUrl || meta.url || e.updateUrl, notes: meta.notes || '' });
      }
    } catch (err) { sendLog('warn', `Update check failed for extension "${e.id}": ${err.message}`); }
  }
  return { available: items.length > 0, items };
}

async function checkAllUpdates(reason = 'auto') {
  const [scraper, ext] = await Promise.all([
    scraperUpdateCheck().catch(e => ({ available: false, error: e.message })),
    extensionsUpdateCheck().catch(e => ({ available: false, items: [], error: e.message })),
  ]);
  updateStatus = { scraper, extensions: ext, checkedAt: Date.now() };
  sendUpdateStatus();
  sendLog('info', `Update check (${reason}): scraper ${scraper.available ? 'behind ' + scraper.behind : 'current'}, ` +
                  `extensions ${ext.available ? ext.items.length + ' update(s)' : 'current'}.`);
  return updateStatus;
}

ipcMain.handle('check-updates', async () => { await checkAllUpdates('manual'); return updateStatus; });
ipcMain.handle('get-update-status', () => updateStatus);

// Automatic checks: shortly after launch, then every 3 hours.
function startUpdateChecks() {
  setTimeout(() => checkAllUpdates('startup').catch(() => {}), 8000);
  setInterval(() => checkAllUpdates('interval').catch(() => {}), 3 * 60 * 60 * 1000);
}

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1100, minHeight: 700,
    backgroundColor: '#060608',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', async () => {
    mainWindow.show();
    await ensureChromium();
    // Don't start the scraper at launch — it sleeps until a scrape needs it, to
    // keep idle memory down. Arm the schedulers so scheduled scrapes still fire
    // (they wake the server on demand).
    restartAllSchedulers();
    startUpdateChecks();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => { loadAll(); initExtensions(); initScraperFiles(); startRssServer(); createWindow(); });
app.on('window-all-closed', () => { stopAllSchedulers(); stopScraperServer(); try { rssServer?.close(); } catch {} if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });