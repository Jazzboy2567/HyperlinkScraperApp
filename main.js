const { app, BrowserWindow, ipcMain, Notification, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

// ── Paths ──────────────────────────────────────────────────────────────────
const USER_DATA = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DATA, 'config.json');
const RESULTS_PATH = path.join(USER_DATA, 'results.json');
const SEEN_PATH = path.join(USER_DATA, 'seen_links.json');

const BUNDLED_SCRAPER = path.join(__dirname, 'scraper', 'scraper.js');

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
  config.scraperPath = BUNDLED_SCRAPER;
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
  const scraperDir = path.dirname(BUNDLED_SCRAPER);
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
  if (scraperProcess) return;

  if (!fs.existsSync(BUNDLED_SCRAPER)) {
    sendLog('error', `Scraper not found at: ${BUNDLED_SCRAPER}`);
    mainWindow?.webContents.send('server-status', 'error');
    return;
  }

  sendLog('info', 'Finding available port...');
  const port = await findFreePort(10);
  if (!port) {
    sendLog('error', 'Failed to find a free port after 10 attempts. Server not started.');
    mainWindow?.webContents.send('server-status', 'error');
    return;
  }

  liveScraperPort = port;
  sendLog('info', `Starting scraper server on port ${port}...`);

  scraperProcess = spawn('node', [BUNDLED_SCRAPER], {
    env: { ...process.env, PORT: port },
    cwd: path.dirname(BUNDLED_SCRAPER)
  });
  scraperProcess.stdout.on('data', d => {
    const msg = d.toString().trim();
    if (!msg) return;
    sendLog('info', msg);
    if (msg.includes('listening') || msg.includes('is listening')) {
      serverReady = true;
      mainWindow?.webContents.send('server-status', 'running');
      mainWindow?.webContents.send('port-changed', port);
      restartAllSchedulers();
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
  stopAllSchedulers();
  const proc = scraperProcess;
  if (proc) {
    proc.kill('SIGTERM');
    setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 3000);
  }
}

function sendLog(type, message) {
  mainWindow?.webContents.send('server-log', { type, message });
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
  const port = liveScraperPort;
  if (!port) {
    sendLog('error', `[${urlEntry.nickname || urlEntry.url}] Server not ready yet — no port assigned`);
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
    if (includeTerms.length > 0) {
      filtered = allLinks.filter(link => {
        const title = (link.text || '').toLowerCase();
        const href  = (link.url  || '').toLowerCase();
        return includeTerms.some(term => title.includes(term) || href.includes(term));
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

  return { links: newLinks, total: filtered.length, urlEntry };
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
      links: result.links.map(l => ({ title: l.text || 'Untitled', url: l.url })),
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

ipcMain.handle('server-start', () => { startScraperServer(); return true; });
ipcMain.handle('server-stop', () => { stopScraperServer(); return true; });
ipcMain.handle('server-status', () => ({ running: !!scraperProcess, ready: serverReady }));

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

ipcMain.handle('run-test', async (_, urlEntry, opts) => {
  const { affectMemory = false } = opts || {};
  sendLog('info', `[TEST] Scraping ${urlEntry.nickname || urlEntry.url}...`);
  const result = await scrapeUrl(urlEntry, { affectMemory, isTest: true });
  if (!result) return { ok: false, links: [] };

  const entry = {
    id: Date.now().toString(),
    urlId: urlEntry.id || 'test',
    urlNickname: (urlEntry.nickname || urlEntry.url) + ' [TEST]',
    timestamp: new Date().toISOString(),
    links: result.links.map(l => ({ title: l.text || 'Untitled', url: l.url })),
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
    startScraperServer();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => { loadAll(); initScraperFiles(); createWindow(); });
app.on('window-all-closed', () => { stopScraperServer(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });