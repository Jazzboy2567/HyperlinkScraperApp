// ============================================================
// ANTI-DETECTION MODULE — antidetect.js
// npm install puppeteer-extra puppeteer-extra-plugin-stealth tough-cookie
// ============================================================

const fs = require('fs');

// ── Safe require: tough-cookie ────────────────────────────────────────────────
let CookieJar;
try {
    ({ CookieJar } = require('tough-cookie'));
    console.log('[INIT] tough-cookie loaded');
} catch {
    console.warn('[WARN] tough-cookie not installed — run: npm install tough-cookie');
    CookieJar = class {
        getCookiesSync() { return []; }
        setCookieSync() {}
        serializeSync() { return { cookies: [] }; }
        static deserializeSync() { return new CookieJar(); }
    };
}

// ── Safe require: puppeteer-extra + stealth ───────────────────────────────────
let puppeteer;
try {
    puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
    console.log('[INIT] puppeteer-extra + stealth loaded');
} catch {
    try {
        puppeteer = require('puppeteer');
        console.log('[INIT] Standard puppeteer loaded (run: npm install puppeteer-extra puppeteer-extra-plugin-stealth for better stealth)');
    } catch {
        console.warn('[WARN] No puppeteer found — run: npm install puppeteer-extra puppeteer-extra-plugin-stealth');
        puppeteer = null;
    }
}

// ── Proxy support ───────────────────────────────────────────────────────────
// The single biggest lever for sites that block by IP reputation (Costco,
// Amazon, eBay, most grocery chains). When USE_PROXY=true, every browser we
// launch routes through a residential/rotating proxy, so the target sees a
// clean residential IP instead of a datacenter one. Config via env:
//   USE_PROXY=true
//   PROXY_URL=http://user:pass@host:port      (single proxy)
//   PROXY_POOL=http://a:1,http://b:2,...       (rotated at random)
// Returns { server, username, password } for the chosen proxy, or null when
// disabled/unset. `server` is credential-free (scheme://host:port) because
// Chrome's --proxy-server ignores inline user:pass — those go through
// page.authenticate() instead. username/password are null when not supplied.
function getProxy() {
    if (process.env.USE_PROXY !== 'true') return null;
    let raw = process.env.PROXY_URL;
    if (!raw) {
        const pool = (process.env.PROXY_POOL || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        if (!pool.length) return null;
        raw = pool[Math.floor(Math.random() * pool.length)];
    }
    try {
        // Ensure a scheme so URL() can parse host:port-only values.
        const u = new URL(/^\w+:\/\//.test(raw) ? raw : `http://${raw}`);
        return {
            server: `${u.protocol}//${u.host}`,
            username: u.username ? decodeURIComponent(u.username) : null,
            password: u.password ? decodeURIComponent(u.password) : null,
        };
    } catch {
        return { server: raw, username: null, password: null };
    }
}

// Base Chrome launch flags shared by both scrapers. A proxy flag is appended
// per-launch (it may rotate), so it is NOT baked in here.
const BASE_LAUNCH_ARGS = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--lang=en-US', '--disable-extensions', '--mute-audio',
    '--disable-gpu', '--disable-software-rasterizer',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
];

// ── Cookie Jar ────────────────────────────────────────────────────────────────
const COOKIE_FILE = './cookie_store.json';
let cookieJars = {};

function getDomainKey(url) {
    try {
        const parts = new URL(url).hostname.split('.');
        return parts.slice(-2).join('.');
    } catch {
        return url;
    }
}

function loadCookies() {
    try {
        const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
        for (const domain in raw) {
            cookieJars[domain] = CookieJar.deserializeSync(raw[domain]);
        }
        const total = Object.values(cookieJars).reduce((n, jar) => n + jar.serializeSync().cookies.length, 0);
        console.log(`[COOKIES] Loaded ${total} cookies across ${Object.keys(cookieJars).length} domains`);
    } catch {
        console.log('[COOKIES] No cookie store found, starting fresh');
    }
}

function saveCookies() {
    try {
        const serialized = {};
        for (const domain in cookieJars) {
            serialized[domain] = cookieJars[domain].serializeSync();
        }
        fs.writeFileSync(COOKIE_FILE, JSON.stringify(serialized, null, 2));
    } catch (e) {
        console.warn('[COOKIES] Failed to save:', e.message);
    }
}

function getJar(url) {
    const domain = getDomainKey(url);
    if (!cookieJars[domain]) cookieJars[domain] = new CookieJar();
    return { jar: cookieJars[domain], domain };
}

loadCookies();

// ── Browser Profiles ──────────────────────────────────────────────────────────
const PROFILE_FILE = './browser_profiles.json';
let browserProfiles = {};

function loadProfiles() {
    try {
        browserProfiles = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
        console.log(`[PROFILES] Loaded ${Object.keys(browserProfiles).length} browser profiles`);
    } catch {
        console.log('[PROFILES] No profiles found, will generate on first visit');
    }
}

function saveProfiles() {
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(browserProfiles, null, 2));
}

function getOrCreateProfile(domain) {
    if (browserProfiles[domain]) return browserProfiles[domain];

    const resolutions = [[1920, 1080], [1366, 768], [1440, 900], [1536, 864], [2560, 1440]];
    const res = resolutions[Math.floor(Math.random() * resolutions.length)];
    const timezones = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Denver', 'Europe/London', 'Europe/Paris'];
    const chromeVersions = ['122', '123', '124', '125', '126'];

    const profile = {
        domain,
        screenWidth: res[0],
        screenHeight: res[1],
        timezone: timezones[Math.floor(Math.random() * timezones.length)],
        chromeVersion: chromeVersions[Math.floor(Math.random() * chromeVersions.length)],
        canvasNoiseSeed: Math.floor(Math.random() * 1000),
        hardwareConcurrency: [4, 8, 12, 16][Math.floor(Math.random() * 4)],
        deviceMemory: [4, 8][Math.floor(Math.random() * 2)],
        devicePixelRatio: [1, 1, 1, 2][Math.floor(Math.random() * 4)], // weighted toward 1
        platform: 'Win32',
        createdAt: new Date().toISOString()
    };

    browserProfiles[domain] = profile;
    saveProfiles();
    console.log(`[PROFILES] Created profile for ${domain}: ${profile.screenWidth}x${profile.screenHeight} Chrome/${profile.chromeVersion} ${profile.timezone}`);
    return profile;
}

loadProfiles();

// ── Stealth Script ────────────────────────────────────────────────────────────
// Injected via evaluateOnNewDocument — runs before any site JS.
//
// What headless Chrome exposes that detectors check for:
//  1.  navigator.webdriver          — explicit bot flag
//  2.  navigator.vendor             — empty string (real Chrome: 'Google Inc.')
//  3.  navigator.hardwareConcurrency/deviceMemory — defaults may not match profile
//  4.  navigator.plugins            — empty array in headless
//  5.  chrome.runtime               — absent in headless
//  6.  Notification.permission      — 'denied' in headless vs 'default' real Chrome
//  7.  document.hasFocus()          — returns false in headless; JS frameworks gate
//                                     nav rendering on this. Highest-impact fix.
//  8.  document.hidden/visibilityState — 'hidden' in headless; React/Vue/jQuery
//                                        skip initialization for background tabs
//  9.  window.outerWidth/outerHeight — 0 in headless
// 10.  window.devicePixelRatio      — always 1 regardless of profile
// 11.  Canvas fingerprint           — deterministic output in headless
// 12.  WebGL vendor/renderer        — different strings in headless
// 13.  AudioContext sampleRate      — different value in headless
// 14.  navigator.connection         — rtt=0, downlink=0 in headless
// 15.  Battery API                  — absent in headless
// 16.  Error stack traces           — may contain 'puppeteer'/'playwright'
// 17.  Function.prototype.toString  — overridden natives return function source
//                                     instead of '[native code]'
//
// NOT handled here (covered by puppeteer-extra-plugin-stealth):
//  - cdc_* global removal
//  - navigator.userAgent HeadlessChrome string

function getStealthScript(profile) {
    const dpr = profile.devicePixelRatio || 1;
    return `
    (() => {
        // ── toString proxy — must be first ──────────────────────────────────
        // Any function we override will appear as [native code] when toString'd.
        // Advanced detectors call fn.toString() on overridden navigator properties.
        const _nativeToString = Function.prototype.toString;
        const _proxied = new WeakSet();
        Function.prototype.toString = new Proxy(_nativeToString, {
            apply(target, thisArg, args) {
                if (_proxied.has(thisArg)) return 'function ' + (thisArg.name || '') + '() { [native code] }';
                return target.apply(thisArg, args);
            }
        });
        _proxied.add(Function.prototype.toString);

        // Helper: define a read-only native-looking property
        function defineNative(obj, prop, getter) {
            const g = typeof getter === 'function' ? getter : () => getter;
            _proxied.add(g);
            try { Object.defineProperty(obj, prop, { get: g, configurable: true }); } catch(e) {}
        }

        // 1. webdriver
        defineNative(navigator, 'webdriver', () => undefined);
        try { delete navigator.__proto__.webdriver; } catch(e) {}

        // 2. vendor — empty string in headless
        defineNative(navigator, 'vendor', () => 'Google Inc.');

        // 3. Hardware
        defineNative(navigator, 'hardwareConcurrency', () => ${profile.hardwareConcurrency});
        defineNative(navigator, 'deviceMemory',        () => ${profile.deviceMemory});

        // 4. Plugins — empty array in headless
        const makePlugin = (name, filename, desc) => {
            const p = Object.create(Plugin.prototype);
            Object.defineProperties(p, {
                name:        { get: () => name },
                filename:    { get: () => filename },
                description: { get: () => desc },
                length:      { get: () => 0 }
            });
            return p;
        };
        const pluginArray = [
            makePlugin('PDF Viewer',        'internal-pdf-viewer',               'Portable Document Format'),
            makePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', 'Portable Document Format'),
        ];
        pluginArray.__proto__ = PluginArray.prototype;
        defineNative(navigator, 'plugins',    () => pluginArray);
        defineNative(navigator, 'mimeTypes',  () => []);
        defineNative(navigator, 'languages',  () => ['en-US', 'en']);
        defineNative(navigator, 'platform',   () => '${profile.platform}');

        // 5. chrome.runtime — absent in headless, checked widely
        window.chrome = {
            app: { isInstalled: false },
            runtime: {
                connect: () => {}, sendMessage: () => {},
                getPlatformInfo: (cb) => cb({ os: 'win', arch: 'x86-64', nacl_arch: 'x86-64' }),
                onMessage: { addListener: () => {}, removeListener: () => {} },
                onConnect: { addListener: () => {}, removeListener: () => {} },
                id: undefined
            },
            loadTimes: () => ({
                requestTime: Date.now() / 1000 - 0.3, finishLoadTime: Date.now() / 1000,
                firstPaintTime: 0, navigationType: 'Other',
                wasFetchedViaSpdy: true, wasNpnNegotiated: true,
                npnNegotiatedProtocol: 'h2', connectionInfo: 'h2'
            }),
            csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: 1, tran: 15 }),
        };

        // 6. Notification permission — 'denied' in headless, 'default' in real Chrome
        const _query = window.navigator.permissions.query.bind(navigator.permissions);
        const _patchedQuery = p =>
            p.name === 'notifications' ? Promise.resolve({ state: 'default' }) : _query(p);
        _proxied.add(_patchedQuery);
        window.navigator.permissions.query = _patchedQuery;

        // 7. document.hasFocus() — false in headless. Single highest-impact fix:
        //    JS frameworks gate nav rendering on this. If false, menus never build.
        document.hasFocus = () => true;
        _proxied.add(document.hasFocus);

        // 8. Page Visibility — 'hidden' in headless. React/Vue/jQuery skip
        //    initialization entirely for background tabs.
        defineNative(document, 'hidden',          () => false);
        defineNative(document, 'visibilityState', () => 'visible');

        // 9. outerWidth/outerHeight — 0 in headless
        defineNative(window, 'outerWidth',  () => ${profile.screenWidth});
        defineNative(window, 'outerHeight', () => ${profile.screenHeight});

        // 10. devicePixelRatio — always 1 in headless regardless of profile
        defineNative(window, 'devicePixelRatio', () => ${dpr});

        // 11. Canvas noise
        const _getCtx = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
            const ctx = _getCtx.call(this, type, ...args);
            if (type === '2d' && ctx) {
                const _getImageData = ctx.getImageData.bind(ctx);
                _proxied.add(_getImageData);
                ctx.getImageData = function(x, y, w, h) {
                    const data = _getImageData(x, y, w, h);
                    const noise = ${profile.canvasNoiseSeed % 5};
                    for (let i = 0; i < data.data.length; i += 100) data.data[i] ^= noise;
                    return data;
                };
                _proxied.add(ctx.getImageData);
                const _fillText = ctx.fillText.bind(ctx);
                ctx.fillText = function(...a) { ctx.shadowBlur = ${profile.canvasNoiseSeed % 3}; return _fillText(...a); };
                _proxied.add(ctx.fillText);
            }
            return ctx;
        };
        _proxied.add(HTMLCanvasElement.prototype.getContext);

        // 12. WebGL vendor/renderer
        const patchWebGL = (proto) => {
            const _get = proto.getParameter;
            proto.getParameter = function(p) {
                if (p === 37445) return 'Intel Inc.';
                if (p === 37446) return 'Intel Iris Pro OpenGL Engine';
                if (p === 35724) return 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
                return _get.call(this, p);
            };
            _proxied.add(proto.getParameter);
        };
        patchWebGL(WebGLRenderingContext.prototype);
        if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext.prototype);

        // 13. AudioContext sampleRate
        try {
            Object.defineProperty(AudioContext.prototype, 'sampleRate', { get: () => 44100 });
        } catch(e) {}

        // 14. Screen dimensions
        defineNative(screen, 'width',       () => ${profile.screenWidth});
        defineNative(screen, 'height',      () => ${profile.screenHeight});
        defineNative(screen, 'availWidth',  () => ${profile.screenWidth});
        defineNative(screen, 'availHeight', () => ${profile.screenHeight} - 40);
        defineNative(screen, 'colorDepth',  () => 24);
        defineNative(screen, 'pixelDepth',  () => 24);

        // 15. Connection info — rtt/downlink are 0 in headless
        if (navigator.connection) {
            try {
                Object.defineProperty(navigator.connection, 'rtt',      { get: () => 100, configurable: true });
                Object.defineProperty(navigator.connection, 'downlink', { get: () => 10,  configurable: true });
            } catch(e) {}
        }

        // 16. Battery API — absent in headless
        if (!navigator.getBattery) {
            const _battery = () => Promise.resolve({
                charging: true, chargingTime: 0, dischargingTime: Infinity, level: 0.98,
                addEventListener: () => {}, removeEventListener: () => {}
            });
            _proxied.add(_battery);
            navigator.getBattery = _battery;
        }

        // 17. Error stack trace sanitization
        const _Error = Error;
        const _patchedError = function(...args) {
            const err = new _Error(...args);
            if (err.stack) err.stack = err.stack.replace(/puppeteer|playwright|selenium/gi, 'Chrome');
            return err;
        };
        _patchedError.prototype = _Error.prototype;
        _proxied.add(_patchedError);
        window.Error = _patchedError;

        // Misc
        try { window.name = ''; } catch(e) {}

        // ── In-flight request counter ─────────────────────────────────────
        // Used by waitForJSContent to know whether XHR/fetch calls are still
        // outstanding. Without this, the MutationObserver can declare the DOM
        // "stable" during the gap between page load and a slow XHR response
        // arriving -- exactly when product grids and search results populate.
        // Patching both fetch and XHR covers all request patterns in use today.
        window.__activeRequests = 0;
        const _origFetch = window.fetch;
        window.fetch = function(...args) {
            window.__activeRequests++;
            return _origFetch.apply(this, args).finally(() => {
                window.__activeRequests = Math.max(0, window.__activeRequests - 1);
            });
        };
        _proxied.add(window.fetch);
        const _origXHRSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function(...args) {
            window.__activeRequests++;
            this.addEventListener('loadend', () => {
                window.__activeRequests = Math.max(0, window.__activeRequests - 1);
            }, { once: true });
            return _origXHRSend.apply(this, args);
        };
        _proxied.add(XMLHttpRequest.prototype.send);
    })();
    `;
}

// ── Modal / Overlay Dismisser ─────────────────────────────────────────────────
// Many sites gate their content behind consent banners, cookie notices, privacy
// policy overlays, newsletter popups, and age gates. These must be dismissed
// before dynamic content (product grids, listings, nav trees) will render.
//
// Four passes in order of specificity — stops at the first successful dismissal:
//   1. Escape key — fastest, works for many modals before touching the DOM
//   2. ARIA/role targeting — role="dialog" elements with labelled close buttons
//   3. Fixed viewport-covering elements — catches custom consent overlays that
//      don't use ARIA roles (very common in retail/grocery sites). Detected by
//      position:fixed + covering most of the viewport + having a button inside.
//   4. Text-matched buttons — scans all visible buttons for common dismiss phrases
//   5. Backdrop click-away — clicks semi-transparent dimming elements
//
// Returns immediately with no wait if no overlay is detected.
// Max added time if all passes are needed: ~2.5s.
//
async function dismissModals(page) {
    // Pass 1: Escape key — many modals respond to this before JS even checks buttons
    await page.keyboard.press('Escape').catch(() => {});
    await new Promise(r => setTimeout(r, 300));

    const dismissed = await page.evaluate(async () => {
        const DISMISS_PHRASES = [
            'accept all', 'accept & close', 'accept and close', 'i accept',
            'agree and continue', 'agree & continue', 'i agree',
            'got it', 'ok, got it', 'got it!',
            'continue to site', 'continue without accepting',
            'confirm my choices', 'save preferences',
            'confirm', 'accept', 'close', 'dismiss', 'done',
            'no thanks', 'not now', 'maybe later',
            'i am over 18', 'i am 18', 'enter site',
        ];

        const vw = window.innerWidth  || document.documentElement.clientWidth;
        const vh = window.innerHeight || document.documentElement.clientHeight;

        const isVisible = el => {
            if (!el) return false;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };

        const tryClick = async (el) => {
            if (!el || !isVisible(el)) return false;
            el.click();
            await new Promise(r => setTimeout(r, 500));
            return true;
        };

        const getButtonText = el =>
            (el.innerText || el.textContent || el.getAttribute('aria-label') || '').toLowerCase().trim();

        const findDismissButton = (root) => {
            const btns = [...root.querySelectorAll('button, [role="button"]')];
            for (const phrase of DISMISS_PHRASES) {
                const match = btns.find(b => isVisible(b) && getButtonText(b).includes(phrase));
                if (match) return match;
            }
            return null;
        };

        // Pass 2: ARIA dialog roles
        for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
            if (!isVisible(dialog)) continue;
            const btn = dialog.querySelector(
                'button[aria-label*="close" i], button[aria-label*="accept" i], ' +
                'button[aria-label*="dismiss" i], button[aria-label*="agree" i], ' +
                '[data-testid*="close" i], [data-testid*="accept" i], [data-testid*="dismiss" i]'
            ) || findDismissButton(dialog);
            if (btn && await tryClick(btn)) return 'aria-dialog';
        }

        // Pass 3: Fixed viewport-covering overlays (custom consent/privacy modals).
        // Detects any fixed/sticky element covering >40% of viewport area that
        // contains a dismissable button. This is the pattern used by retail sites
        // (and many others) that build consent flows without ARIA roles.
        const allEls = [...document.querySelectorAll('*')];
        for (const el of allEls) {
            if (!isVisible(el)) continue;
            const s = window.getComputedStyle(el);
            if (s.position !== 'fixed' && s.position !== 'sticky') continue;
            const r = el.getBoundingClientRect();
            const coverageX = r.width  / vw;
            const coverageY = r.height / vh;
            // Must cover a significant portion of the viewport to count as an overlay
            if (coverageX < 0.4 || coverageY < 0.2) continue;
            const btn = findDismissButton(el);
            if (btn && await tryClick(btn)) return 'fixed-overlay';
        }

        // Pass 4: Text-matched buttons anywhere on page (catches anything missed above)
        const allBtns = [...document.querySelectorAll('button, [role="button"], a[href="#"]')];
        for (const phrase of DISMISS_PHRASES) {
            const match = allBtns.find(b => isVisible(b) && getButtonText(b).includes(phrase));
            if (match && await tryClick(match)) return `text:${phrase}`;
        }

        // Pass 5: Semi-transparent backdrop click-away
        for (const el of document.querySelectorAll(
            '[class*="overlay" i], [class*="backdrop" i], [class*="modal-bg" i], [id*="overlay" i]'
        )) {
            if (!isVisible(el)) continue;
            const bg = window.getComputedStyle(el).backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
                if (await tryClick(el)) return 'backdrop';
            }
        }

        return null;
    }).catch(() => null);

    if (dismissed) {
        console.log(`[MODAL] Dismissed overlay via: ${dismissed}`);
        await new Promise(r => setTimeout(r, 400));
    }
    return dismissed; // truthy if something was clicked, null if nothing found
}

// ── Cloudflare Challenge Handler ──────────────────────────────────────────────
// Polls up to 10s. If unresolved by then, CF needs a manual click — bail out.
async function handleCloudflareChallenge(page) {
    const cfSignals = ['just a moment', 'checking your browser', 'enable javascript and cookies', 'ray id', 'cf-browser-verification'];

    const getPageText = async () =>
        (await page.evaluate(() => (document.body?.innerText || '') + document.title).catch(() => '')).toLowerCase();

    const initialText = await getPageText();
    if (!cfSignals.some(s => initialText.includes(s))) return false;

    console.log('[CF] Cloudflare challenge detected — waiting up to 10s for auto-solve...');
    const startUrl = page.url();

    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const current = await getPageText();
        if (!cfSignals.some(s => current.includes(s)) || page.url() !== startUrl) {
            console.log(`[CF] Resolved after ~${i + 1}s`);
            return true;
        }
    }

    console.log('[CF] Did not resolve in 10s — site likely requires manual CAPTCHA interaction');
    return false;
}

// ── URL Cleaner ───────────────────────────────────────────────────────────────
const TRACKING_PARAMS = [
    'click_key', 'click_sum', 'ls', 'ref', 'pro', 'frs',
    'ga_order', 'ga_search_type', 'ga_view_type', 'ga_search_query',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid',
    'trackingId', 'refId', 'trk', 'position', 'pageNum', 'sessionId',
    '_ga', '_gl', 'sts', 'content_source', 'etp', 'dd'
];

function cleanUrl(url) {
    try {
        const u = new URL(url);
        TRACKING_PARAMS.forEach(p => u.searchParams.delete(p));
        const cleaned = u.toString();
        if (cleaned !== url) console.log(`[URL] Stripped tracking params: ${cleaned}`);
        return cleaned;
    } catch {
        return url;
    }
}

// ── Wait for JS-Rendered Content ──────────────────────────────────────────────
// Called after waitUntil:'load', which already guarantees all scripts have run.
// This handles content that still arrives after load:
//
//   - XHR/fetch-populated product grids, search results, listing pages
//   - Intersection Observer-gated elements (lazy menus, product cards)
//   - Components waiting on scroll or resize events to initialize
//
// Strategy:
//   1. Short network idle — catches XHR calls that fire immediately post-load
//   2. Progressive scroll — steps down the page to trigger every IO threshold,
//      which is what a real user's browser does when the page first appears
//   3. MutationObserver DOM stability — resolves the moment the DOM stops
//      changing for 400ms rather than polling on a fixed timer. Reactive:
//      exits as soon as content is done, not after a fixed wait.
//      Max wall time capped at 4s so a persistently-updating page never stalls.
//
async function waitForJSContent(page, fastMode = false, hints = {}) {
    // fastMode = true for pages 2+ where the session is warm and XHR is faster.
    // Reduces worst-case wait from ~11s to ~5s without losing content.
    // hints (from site_adapters.js) let a specific site ask for more patience:
    //   waitForSelector — wait for a real content element before settling
    //   infiniteScroll  — repeatedly scroll to load lazy result cards
    //   extraWaitMs     — extra quiet time after the DOM settles
    const idleTime    = fastMode ? 300  : 500;
    const idleTimeout = fastMode ? 1000 : 3000;
    const maxWait     = fastMode ? 4000 : 12000;  // 12s for page 1 — covers slow SPA first-paint
    const quietAfter  = fastMode ? 300  : 500;

    // Step 1: catch any XHR/fetch calls that fire immediately after load
    if (typeof page.waitForNetworkIdle === 'function') {
        await page.waitForNetworkIdle({ idleTime, timeout: idleTimeout }).catch(() => {});
    }

    // Step 1b: if the adapter named a content selector, wait for it to appear.
    // This is the strongest "is the real content here yet?" signal available —
    // far better than counting anchors, which a nav bar satisfies prematurely.
    if (hints.waitForSelector) {
        try {
            await page.waitForSelector(hints.waitForSelector, {
                visible: true, timeout: fastMode ? 4000 : 10000,
            });
            console.log(`[WAIT] Content selector appeared: ${hints.waitForSelector}`);
        } catch {
            console.log(`[WAIT] Content selector not found in time: ${hints.waitForSelector}`);
        }
    }

    // Step 2: progressive scroll — steps through the full page height so every
    // Intersection Observer threshold is crossed, exactly as a real browser would.
    // This triggers lazy product cards, deferred nav sections, and any element
    // gated behind an IO callback.
    //
    // When hints.infiniteScroll is set, we don't stop at one pass: we keep
    // scrolling to the bottom and waiting for the page to grow, up to
    // maxScrollRounds times or until the height stops increasing. This is the
    // generic mechanism behind "load more result cards" on infinite-scroll
    // sites — no per-site selector needed.
    const doScrollPass = () => page.evaluate(async () => {
        await new Promise(resolve => {
            const totalHeight = document.body.scrollHeight;
            const stepSize   = Math.max(200, Math.floor(totalHeight / 10));
            let scrolled     = 0;

            const step = () => {
                scrolled += stepSize;
                window.scrollTo({ top: scrolled, behavior: 'instant' });
                window.dispatchEvent(new Event('scroll'));
                if (scrolled < totalHeight) {
                    setTimeout(step, 25);
                } else {
                    resolve();
                }
            };
            step();
        });
        window.dispatchEvent(new Event('resize'));
        return document.body.scrollHeight;
    }).catch(() => 0);

    if (hints.infiniteScroll) {
        const rounds = Math.max(1, hints.maxScrollRounds || 8);
        let lastHeight = 0;
        for (let i = 0; i < rounds; i++) {
            const h = await doScrollPass();
            if (typeof page.waitForNetworkIdle === 'function') {
                await page.waitForNetworkIdle({ idleTime: 400, timeout: 2500 }).catch(() => {});
            } else {
                await new Promise(r => setTimeout(r, 500));
            }
            if (h <= lastHeight) { console.log(`[WAIT] Infinite scroll settled after ${i + 1} round(s)`); break; }
            lastHeight = h;
        }
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })).catch(() => {});
    } else {
        await doScrollPass();
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })).catch(() => {});
    }

    // Step 3: Combined DOM + network stability.
    //
    // The MutationObserver watches for DOM changes and resets a quiet timer on
    // every mutation. Crucially, it also checks window.__activeRequests (set by
    // the fetch/XHR patches in the stealth script) before declaring stable.
    //
    // This prevents a false-stable signal during the gap between "page loaded"
    // and "XHR response arrives and writes products to the DOM" — which is
    // exactly the window where product grids and search results load on sites
    // that fetch content post-load.
    //
    // Behaviour on different page types:
    //   Fast static pages  : DOM already quiet, no requests → exits in ~500ms
    //   Nav-only JS sites  : DOM settles after framework hydration → ~500-900ms
    //   XHR product grids  : waits for requests to complete + DOM to settle
    //   Persistent pollers : hits MAX_WAIT cap (8s) and continues anyway
    //
    const stable = await page.evaluate((maxWait, quietAfter) => new Promise(resolve => {
        const MAX_WAIT    = maxWait;
        const QUIET_AFTER = quietAfter;

        let hardLimit = setTimeout(() => { observer.disconnect(); resolve('timeout'); }, MAX_WAIT);
        let quietTimer = null;

        const checkStable = () => {
            clearTimeout(quietTimer);
            const activeReqs  = window.__activeRequests || 0;
            const linkCount   = document.querySelectorAll('a[href]').length;

            // Two distinct cases:
            //
            // CASE 1 — Empty DOM (shell page / pre-hydration gap):
            //   Links = 0. The framework hasn't rendered yet. We MUST wait
            //   for in-flight requests because the content fetch hasn't started
            //   or completed. Polling every 200ms preserves the original fix
            //   for XHR-populated grids that are momentarily quiet on load.
            //
            // CASE 2 — Content already rendered (links ≥ 5):
            //   Real content is visible. In-flight requests are background
            //   prefetches (detail pages, images, analytics) — they are NOT
            //   going to mutate the listing DOM. Waiting for them adds 2-3s
            //   per page with zero benefit. The MutationObserver is still
            //   active: if any request DID mutate the DOM, it would fire and
            //   reset the quiet timer. So declaring stable here is safe.
            //
            // The threshold of 5 links is deliberately conservative — a page
            // with only 1-4 links could still be a partially-loaded shell.
            const contentReady = linkCount >= 5;

            if (!contentReady) {
                // Shell / pre-hydration gap: keep polling whether or not requests
                // are in-flight. Covers both the momentary-quiet gap (requests
                // haven't started yet) and the active-fetch case.
                quietTimer = setTimeout(checkStable, 200);
            } else {
                // Content rendered: start quiet countdown regardless of background requests
                quietTimer = setTimeout(() => {
                    clearTimeout(hardLimit);
                    observer.disconnect();
                    resolve('stable');
                }, QUIET_AFTER);
            }
        };

        const observer = new MutationObserver(checkStable);
        observer.observe(document.body, { childList: true, subtree: true, attributes: false });

        // Kick immediately — page may already be static
        checkStable();
    }), maxWait, quietAfter).catch(() => 'error');

    // Optional per-site settle time for results that trickle in after the
    // first render burst (adapters set this for slow, XHR-driven grids).
    if (hints.extraWaitMs > 0) {
        await new Promise(r => setTimeout(r, hints.extraWaitMs));
    }

    const linkCount = await page.evaluate(() => document.querySelectorAll('a').length).catch(() => 0);
    console.log(`[WAIT] DOM ${stable} — ${linkCount} links`);
}

// ── Cookie helpers ────────────────────────────────────────────────────────────
async function restoreCookiesToPage(page, url) {
    const { jar, domain } = getJar(url);
    const existing = jar.getCookiesSync(url);
    if (existing.length === 0) {
        console.log(`[COOKIES] No existing cookies for ${domain} — fresh session`);
        return existing;
    }
    console.log(`[COOKIES] Restoring ${existing.length} cookies for ${domain}`);
    const puppeteerCookies = existing.map(c => ({
        name: c.key, value: c.value,
        domain: c.domain || `.${domain}`,
        path: c.path || '/',
        httpOnly: c.httpOnly || false,
        secure: c.secure || false,
        sameSite: 'Lax'
    }));
    await page.setCookie(...puppeteerCookies).catch(() => {});
    return existing;
}

async function savePageCookies(page, url) {
    const { jar } = getJar(url);
    const cookies = await page.cookies().catch(() => []);
    console.log(`[COOKIES] Saving ${cookies.length} cookies from ${getDomainKey(url)}`);
    cookies.forEach(c => {
        try {
            jar.setCookieSync(
                `${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path}` +
                (c.httpOnly ? '; HttpOnly' : '') +
                (c.secure ? '; Secure' : '') +
                (c.expires ? `; Expires=${new Date(c.expires * 1000).toUTCString()}` : ''),
                url
            );
        } catch {}
    });
    saveCookies();
    return cookies;
}

// ── Block heavy resources ─────────────────────────────────────────────────────
// Images and media only. Scripts, XHR, fetch, CSS, and fonts MUST pass through:
// - Scripts: frameworks need all bundles to render navigation
// - XHR/fetch: session validation and content hydration happen here
// - CSS/fonts: some frameworks stall on document.fonts.ready before rendering
async function blockHeavyResources(page, { loadImages = false } = {}) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        // A few sites gate rendering on image load; an adapter can set
        // loadImages to let images (but never other media) through.
        const type = req.resourceType();
        if (type === 'media' || (type === 'image' && !loadImages)) req.abort();
        else req.continue();
    });
}

// ── Main Enhanced Scraper ─────────────────────────────────────────────────────
async function scrapeEnhanced(url, options = {}) {
    const { useProfile = true, retries = 2, fastMode = false, hints = {} } = options;

    if (!puppeteer) throw new Error('Puppeteer not available — run: npm install puppeteer-extra puppeteer-extra-plugin-stealth');

    const domain = getDomainKey(url);
    const profile = useProfile ? getOrCreateProfile(domain) : getOrCreateProfile('default');

    console.log(`[ENHANCED] Scraping ${url}`);
    console.log(`[ENHANCED] Profile: ${profile.screenWidth}x${profile.screenHeight} Chrome/${profile.chromeVersion} ${profile.timezone}`);

    for (let attempt = 1; attempt <= retries; attempt++) {
        console.log(`[ENHANCED] Attempt ${attempt}/${retries}`);
        let browser;

        try {
            const proxy = getProxy();
            if (proxy) console.log(`[ENHANCED] Using proxy: ${proxy.server}${proxy.username ? ' (auth)' : ''}`);
            browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    ...BASE_LAUNCH_ARGS,
                    `--window-size=${profile.screenWidth},${profile.screenHeight}`,
                    ...(proxy ? [`--proxy-server=${proxy.server}`] : []),
                ]
            });

            const page = await browser.newPage();
            if (proxy && proxy.username) {
                await page.authenticate({ username: proxy.username, password: proxy.password || '' });
            }

            await page.setViewport({
                width: profile.screenWidth,
                height: profile.screenHeight,
                deviceScaleFactor: profile.devicePixelRatio || 1,
                hasTouch: false,
                isLandscape: true,
                isMobile: false
            });

            await page.setUserAgent(
                `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
                `(KHTML, like Gecko) Chrome/${profile.chromeVersion}.0.0.0 Safari/537.36`
            );

            await page.evaluateOnNewDocument(getStealthScript(profile));
            await page.emulateTimezone(profile.timezone);
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'sec-ch-ua': `"Not_A Brand";v="8", "Chromium";v="${profile.chromeVersion}", "Google Chrome";v="${profile.chromeVersion}"`,
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
            });

            await blockHeavyResources(page, { loadImages: hints.loadImages });

            const cleanedUrl = cleanUrl(url);
            await restoreCookiesToPage(page, cleanedUrl);

            // ── XHR capture via CDP ────────────────────────────────────────
            // Uses Chrome DevTools Protocol Network events directly.
            // This is completely independent of setRequestInterception, so it
            // never conflicts with blockHeavyResources or affects page rendering.
            const capturedRequests = [];
            const pendingCaptures = new Map(); // requestId → response metadata
            const requestBodies   = new Map(); // requestId → request method + postData

            let cdpClient;
            try {
                cdpClient = await page.target().createCDPSession();
                await cdpClient.send('Network.enable');

                // Step 1: record every request's method + POST body before it fires
                cdpClient.on('Network.requestWillBeSent', (event) => {
                    try {
                        requestBodies.set(event.requestId, {
                            method:   event.request.method,
                            postData: event.request.postData || null,
                            headers:  event.request.headers || {},
                        });
                    } catch {}
                });

                // Step 2: flag JSON responses from any domain
                cdpClient.on('Network.responseReceived', (event) => {
                    try {
                        const mime   = event.response.mimeType || '';
                        const resUrl = event.response.url;
                        if (!mime.includes('json')) return;
                        if (event.response.status < 200 || event.response.status >= 300) return;
                        if (resUrl.startsWith('chrome-extension://') || resUrl.startsWith('data:')) return;
                        pendingCaptures.set(event.requestId, { url: resUrl });
                        console.log(`[XHR] Flagged: ${event.request?.method || ''} ${resUrl}`);
                    } catch {}
                });

                // Step 3: once body is ready, read it and merge with request data
                cdpClient.on('Network.loadingFinished', async (event) => {
                    if (!pendingCaptures.has(event.requestId)) return;
                    const meta    = pendingCaptures.get(event.requestId);
                    const reqData = requestBodies.get(event.requestId) || {};
                    pendingCaptures.delete(event.requestId);
                    try {
                        const { body, base64Encoded } = await cdpClient.send(
                            'Network.getResponseBody', { requestId: event.requestId }
                        );
                        const text = base64Encoded
                            ? Buffer.from(body, 'base64').toString('utf8') : body;
                        if (!text || text.length < 200) return;
                        let json;
                        try { json = JSON.parse(text); } catch { return; }
                        capturedRequests.push({
                            url:          meta.url,
                            method:       reqData.method   || 'GET',
                            headers:      reqData.headers  || {},
                            postData:     reqData.postData || null,
                            responseJson: json,
                            bodyLength:   text.length,
                        });
                        console.log(`[XHR] Captured ${reqData.method || 'GET'} ${meta.url} (${text.length} chars)`);
                    } catch {}
                });
            } catch (e) {
                console.log(`[XHR] CDP setup failed: ${e.message} — capture disabled`);
            }

            // ── Navigate ───────────────────────────────────────────────────
            // waitUntil:'load' waits for all scripts (sync + defer + async) to
            // finish their first execution pass before resolving. This is the
            // critical difference from 'domcontentloaded', which fires before
            // any scripts run, causing JS-rendered nav elements to be missing.
            const parsedTarget = new URL(cleanedUrl);
            const pathParts = parsedTarget.pathname.split('/').filter(Boolean);
            const targetReferer = options.refererUrl
                || (pathParts.length > 1 ? `${parsedTarget.origin}/${pathParts[0]}` : parsedTarget.origin);

            console.log(`[ENHANCED] Navigating — referer: ${targetReferer}`);
            await page.goto(cleanedUrl, {
                waitUntil: 'load',
                timeout: 30000,
                referer: targetReferer
            });

            let htmlSize = (await page.content().catch(() => '')).length;

            // ── Guard: page too small ──────────────────────────────────────
            if (htmlSize < 5000) {
                const rawHtml = (await page.content().catch(() => '')).toLowerCase();
                const isHardBlock = htmlSize < 2000 && (
                    rawHtml.includes('robot') || rawHtml.includes('blocked') ||
                    rawHtml.includes('access denied') || rawHtml.includes('captcha') ||
                    rawHtml.includes('unusual traffic') || rawHtml.length < 1000
                );

                if (isHardBlock) {
                    throw new Error('HARD_BLOCK: Server-level block (TLS fingerprinting or IP). A residential proxy or real Chrome binary is required.');
                }

                // One fallback goto
                console.log(`[ENHANCED] Page small (${htmlSize} chars) — retrying goto...`);
                await page.goto(cleanedUrl, { waitUntil: 'load', timeout: 25000, referer: targetReferer });
                htmlSize = (await page.content().catch(() => '')).length;
            }

            if (htmlSize < 2000) {
                throw new Error('HARD_BLOCK: Server-level block (TLS fingerprinting or IP). A residential proxy or real Chrome binary is required.');
            }
            if (htmlSize < 5000) {
                throw new Error(`Page too small after navigation (${htmlSize} chars) — likely blocked or redirected`);
            }

            // ── Cloudflare ─────────────────────────────────────────────────
            await handleCloudflareChallenge(page);

            // ── Dismiss consent banners / privacy modals / overlays ────────
            // Must run before waitForJSContent — many sites won't render dynamic
            // content (product grids, listings) until the overlay is dismissed.
            const modalDismissed = await dismissModals(page);

            // ── Post-modal pause ───────────────────────────────────────────
            // After accepting a consent banner, many sites (IBM careers, retail,
            // news) re-initialize their components and fire their primary content
            // XHR *after* the click. Without this pause the DOM settler fires
            // immediately, sees zero in-flight requests (the search hasn't started
            // yet), declares stable, and we exit with only nav/footer links.
            //
            // Strategy: if a modal was dismissed, wait 600ms then do a fresh
            // network-idle check. This catches the consent-triggered XHR before
            // waitForJSContent starts its own MutationObserver.
            if (modalDismissed) {
                await new Promise(r => setTimeout(r, 600));
                if (typeof page.waitForNetworkIdle === 'function') {
                    await page.waitForNetworkIdle({ idleTime: 400, timeout: 4000 }).catch(() => {});
                }
            }

            // ── Bot detection signals ──────────────────────────────────────
            const bodyText = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).toLowerCase();
            const botSignals = ['unusual activity', 'access denied', 'bot activity', 'automated requests', 'verify you are human', 'are you a robot'];
            const detected = botSignals.find(s => bodyText.includes(s));

            if (detected) {
                console.log(`[BOT DETECTED] "${detected}" on attempt ${attempt}`);
                await browser.close();
                if (attempt < retries) {
                    const wait = 1500 * attempt;
                    console.log(`[RETRY] Waiting ${wait}ms...`);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                throw new Error(`Bot detected after ${retries} attempts: ${detected}`);
            }

            // ── Wait for JS-rendered content ───────────────────────────────
            await waitForJSContent(page, fastMode, hints);

            // Give any in-flight CDP body reads a moment to complete
            await new Promise(r => setTimeout(r, 300));
            if (cdpClient) cdpClient.detach().catch(() => {});

            const html = await page.content();
            const finalUrl = page.url();
            const linkCount = (html.match(/<a[\s>]/gi) || []).length;
            console.log(`[ENHANCED] Done — ${html.length} chars, ~${linkCount} anchor tags`);

            await savePageCookies(page, cleanedUrl);
            await browser.close();
            return { html, method: 'puppeteer-enhanced', finalUrl, capturedRequests };

        } catch (error) {
            if (browser) { try { await browser.close(); } catch {} }
            if (attempt === retries || error.message.startsWith('HARD_BLOCK')) throw error;
            console.log(`[ENHANCED] Attempt ${attempt} failed: ${error.message}`);
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
        }
    }
}

// ── Next-page detection ───────────────────────────────────────────────────────
// Runs inside the live browser page and returns a descriptor of how to get to
// the next page, or null if none is found.
//
// Five strategies in order of reliability:
//   1. <a rel="next">        — semantic HTML, always unambiguous
//   2. aria-label="next…"   — accessible buttons, covers most SPAs
//   3. Exact text match      — "next", "›", "»", etc.
//   4. Numbered pagination   — finds the link whose text is currentPage+1
//   5. Load-more button      — "load more", "show more", etc. (infinite scroll)
//
// Returns { type: 'navigate', url } or { type: 'click', selector, fallbackText }
//
async function findNextPage(page, currentPageNum) {
    return await page.evaluate((currentPage) => {
        const isVisible = el => {
            if (!el) return false;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.1) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };

        const getText = el =>
            (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();

        // Build an action descriptor from a found element.
        // Prefer navigate (faster, no click ambiguity) over click.
        const toAction = el => {
            const href = el.getAttribute('href');
            const isClickableHref = href && href !== '#' &&
                !href.startsWith('javascript:') && !href.startsWith('mailto:');
            if (isClickableHref) return { type: 'navigate', url: href };

            // Click path — try to build a stable selector
            const sel = el.id                             ? `#${el.id}` :
                        el.getAttribute('data-testid')    ? `[data-testid="${el.getAttribute('data-testid')}"]` :
                        el.getAttribute('aria-label')     ? `[aria-label="${el.getAttribute('aria-label')}"]` : null;
            return { type: 'click', selector: sel, fallbackText: getText(el) };
        };

        const clickables = [...document.querySelectorAll(
            'a, button, [role="button"], [role="link"]'
        )];

        // 1. Semantic rel="next"
        const relNext = document.querySelector('a[rel="next"]');
        if (relNext && isVisible(relNext)) return toAction(relNext);

        // 2. aria-label with word "next" (word boundary to avoid "newest", "context" etc.)
        for (const el of document.querySelectorAll('[aria-label]')) {
            if (!isVisible(el)) continue;
            if (/\bnext\b/i.test(el.getAttribute('aria-label') || '')) return toAction(el);
        }

        // 3. Exact text match — single character glyphs first (less likely to be prose)
        const NEXT_TEXTS = ['›', '»', '→', 'next', 'next page', 'next »', 'next ›', 'next →'];
        for (const phrase of NEXT_TEXTS) {
            for (const el of clickables) {
                if (!isVisible(el)) continue;
                if (getText(el).toLowerCase().trim() === phrase) return toAction(el);
            }
        }

        // 4. Numbered pagination: find the element whose text is currentPage+1
        if (currentPage) {
            const nextStr = String(currentPage + 1);
            for (const el of clickables) {
                if (!isVisible(el)) continue;
                if (getText(el).trim() === nextStr) return toAction(el);
            }
        }

        // 5. Load-more / show-more (infinite scroll trigger)
        const LOAD_MORE = ['load more', 'show more', 'view more', 'see more results', 'more results'];
        for (const phrase of LOAD_MORE) {
            for (const el of clickables) {
                if (!isVisible(el)) continue;
                if (getText(el).toLowerCase().includes(phrase)) {
                    const sel = el.id                          ? `#${el.id}` :
                                el.getAttribute('data-testid') ? `[data-testid="${el.getAttribute('data-testid')}"]` : null;
                    return { type: 'click', selector: sel, fallbackText: getText(el), isLoadMore: true };
                }
            }
        }

        return null;
    }, currentPageNum);
}

// ── Click the element identified by findNextPage ──────────────────────────────
async function clickNextElement(page, action) {
    // Try the stable CSS selector first
    if (action.selector) {
        try {
            await page.waitForSelector(action.selector, { visible: true, timeout: 2000 });
            await page.click(action.selector);
            return true;
        } catch { /* fall through */ }
    }

    // Fallback: find by exact text content and .click()
    if (action.fallbackText) {
        const clicked = await page.evaluate((text) => {
            const lower = text.toLowerCase().trim();
            const isVisible = el => {
                const s = window.getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden') return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            };
            const match = [...document.querySelectorAll('a, button, [role="button"], [role="link"]')]
                .find(el => isVisible(el) &&
                    (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
                        .trim().toLowerCase() === lower);
            if (match) { match.click(); return true; }
            return false;
        }, action.fallbackText);
        if (clicked) return true;
    }

    return false;
}

// ── Multi-page scraper ────────────────────────────────────────────────────────
// Opens one browser session, extracts page 1 normally, then walks through
// subsequent pages via DOM navigation — clicking "next", numbered links, or
// load-more buttons as found by findNextPage().
//
// Returns { pages: [{html, finalUrl}], capturedRequests }
// where pages[0] is always page 1 and capturedRequests contains every JSON
// XHR response seen (used by scraper.js's XHR replay fallback).
//
async function scrapeMultiPage(url, options = {}) {
    const {
        useProfile  = true,
        retries     = 2,
        maxPages    = 10,
        maxDomPages = maxPages,   // limit DOM navigation; defaults to maxPages
        refererUrl: optReferer = null,
        hints       = {},         // per-site engine knobs (see site_adapters.js)
    } = options;

    if (!puppeteer) throw new Error('Puppeteer not available');

    const domain  = getDomainKey(url);
    const profile = useProfile ? getOrCreateProfile(domain) : getOrCreateProfile('default');

    console.log(`[MULTI] Scraping ${url} (up to ${maxPages} pages)`);
    console.log(`[MULTI] Profile: ${profile.screenWidth}x${profile.screenHeight} Chrome/${profile.chromeVersion}`);

    for (let attempt = 1; attempt <= retries; attempt++) {
        console.log(`[MULTI] Attempt ${attempt}/${retries}`);
        let browser;

        try {
            const proxy = getProxy();
            if (proxy) console.log(`[MULTI] Using proxy: ${proxy.server}${proxy.username ? ' (auth)' : ''}`);
            browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    ...BASE_LAUNCH_ARGS,
                    `--window-size=${profile.screenWidth},${profile.screenHeight}`,
                    ...(proxy ? [`--proxy-server=${proxy.server}`] : []),
                ]
            });

            const page = await browser.newPage();
            if (proxy && proxy.username) {
                await page.authenticate({ username: proxy.username, password: proxy.password || '' });
            }

            await page.setViewport({
                width: profile.screenWidth, height: profile.screenHeight,
                deviceScaleFactor: profile.devicePixelRatio || 1,
                hasTouch: false, isLandscape: true, isMobile: false,
            });
            await page.setUserAgent(
                `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
                `(KHTML, like Gecko) Chrome/${profile.chromeVersion}.0.0.0 Safari/537.36`
            );
            await page.evaluateOnNewDocument(getStealthScript(profile));
            await page.emulateTimezone(profile.timezone);
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'sec-ch-ua': `"Not_A Brand";v="8", "Chromium";v="${profile.chromeVersion}", "Google Chrome";v="${profile.chromeVersion}"`,
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
            });

            await blockHeavyResources(page, { loadImages: hints.loadImages });

            const cleanedUrl = cleanUrl(url);
            await restoreCookiesToPage(page, cleanedUrl);

            // ── CDP XHR capture ────────────────────────────────────────────
            // Kept alive for the entire browser session so we capture responses
            // from later pages too, and don't race against detach timing.
            const capturedRequests = [];
            const pendingCaptures  = new Map();
            const requestBodies    = new Map();
            let cdpClient;

            try {
                cdpClient = await page.target().createCDPSession();
                await cdpClient.send('Network.enable');

                cdpClient.on('Network.requestWillBeSent', ({ requestId, request }) => {
                    try {
                        requestBodies.set(requestId, {
                            method:   request.method,
                            postData: request.postData || null,
                            headers:  request.headers || {},
                        });
                    } catch {}
                });

                cdpClient.on('Network.responseReceived', ({ requestId, response, request }) => {
                    try {
                        const mime = response.mimeType || '';
                        if (!mime.includes('json')) return;
                        if (response.status < 200 || response.status >= 300) return;
                        const resUrl = response.url;
                        if (resUrl.startsWith('chrome-extension://') || resUrl.startsWith('data:')) return;
                        pendingCaptures.set(requestId, { url: resUrl });
                    } catch {}
                });

                cdpClient.on('Network.loadingFinished', async ({ requestId }) => {
                    if (!pendingCaptures.has(requestId)) return;
                    const meta    = pendingCaptures.get(requestId);
                    const reqData = requestBodies.get(requestId) || {};
                    pendingCaptures.delete(requestId);
                    try {
                        const { body, base64Encoded } = await cdpClient.send(
                            'Network.getResponseBody', { requestId }
                        );
                        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
                        if (!text || text.length < 200) return;
                        let json;
                        try { json = JSON.parse(text); } catch { return; }
                        capturedRequests.push({
                            url:          meta.url,
                            method:       reqData.method   || 'GET',
                            headers:      reqData.headers  || {},
                            postData:     reqData.postData || null,
                            responseJson: json,
                            bodyLength:   text.length,
                        });
                        console.log(`[XHR] Captured ${reqData.method || 'GET'} ${meta.url} (${text.length} chars)`);
                    } catch {}
                });
            } catch (e) {
                console.log(`[XHR] CDP setup failed: ${e.message} — capture disabled`);
            }

            // ── Page 1: full load ──────────────────────────────────────────
            const parsedTarget = new URL(cleanedUrl);
            const pathParts    = parsedTarget.pathname.split('/').filter(Boolean);
            const targetReferer = optReferer ||
                (pathParts.length > 1 ? `${parsedTarget.origin}/${pathParts[0]}` : parsedTarget.origin);

            console.log(`[MULTI] Navigating page 1 — referer: ${targetReferer}`);
            await page.goto(cleanedUrl, { waitUntil: 'load', timeout: 30000, referer: targetReferer });

            // Hard-block guard
            {
                const rawHtml = (await page.content().catch(() => '')).toLowerCase();
                const tooSmall = rawHtml.length < 2000;
                const blocked = tooSmall && (
                    rawHtml.includes('robot') || rawHtml.includes('blocked') ||
                    rawHtml.includes('access denied') || rawHtml.includes('captcha') ||
                    rawHtml.includes('unusual traffic')
                );
                if (blocked) throw new Error('HARD_BLOCK: Server-level block. A residential proxy is required.');
                if (tooSmall) {
                    // One retry goto
                    await page.goto(cleanedUrl, { waitUntil: 'load', timeout: 25000, referer: targetReferer });
                    if ((await page.content().catch(() => '')).length < 2000)
                        throw new Error('HARD_BLOCK: Page too small after retry.');
                }
            }

            await handleCloudflareChallenge(page);
            const modalDismissed = await dismissModals(page);

            // Post-modal pause: consent acceptance triggers re-initialization
            // and fires content XHR after the click. Wait + network-idle before
            // the DOM settler starts so we don't exit with only nav links.
            if (modalDismissed) {
                await new Promise(r => setTimeout(r, 600));
                if (typeof page.waitForNetworkIdle === 'function') {
                    await page.waitForNetworkIdle({ idleTime: 400, timeout: 4000 }).catch(() => {});
                }
            }

            // Bot signal check
            {
                const body = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).toLowerCase();
                const hit  = ['unusual activity','access denied','bot activity','automated requests','verify you are human','are you a robot']
                    .find(s => body.includes(s));
                if (hit) {
                    await browser.close();
                    if (attempt < retries) {
                        const wait = 1500 * attempt;
                        console.log(`[MULTI] Bot signal "${hit}" — retrying in ${wait}ms`);
                        await new Promise(r => setTimeout(r, wait));
                        continue;
                    }
                    throw new Error(`Bot detected after ${retries} attempts: ${hit}`);
                }
            }

            // ── Option A: early shell detection ───────────────────────────
            // Check for a shell page BEFORE spending 12s in waitForJSContent.
            // A shell has tiny HTML and no rendered links immediately after load.
            // If detected, skip waitForJSContent entirely — the origin warm-up
            // that follows provides the human-like pause instead.
            // Server-rendered pages (Wikipedia etc.) already have links and
            // bypass this check, going straight into waitForJSContent as before.
            //
            // isShell is declared here (not inside a block) so the SPA guard
            // below can reuse it without a second DOM query.
            const earlyHtml  = await page.content().catch(() => '');
            const earlyLinks = await page.evaluate(
                () => document.querySelectorAll('a[href]').length
            ).catch(() => 0);
            // A site adapter can raise minLinks so a content-heavy result page
            // that renders only a nav bar on first paint is treated as a shell
            // and gets the warm-navigation retry.
            const shellLinkFloor = Math.max(3, hints.minLinks || 3);
            const isShell = earlyHtml.length < 30000 && earlyLinks < shellLinkFloor;

            if (!isShell) {
                // Normal page — run full stability wait (with per-site hints)
                await waitForJSContent(page, false, hints);
            }
            // Shell pages fall through to the warm navigation block, saving up to 12s.

            // ── SPA shell guard + warm navigation ─────────────────────────
            //
            // Symptom: HTML < 30 KB and 0 links even after all waiting.
            // Cause:   SPAs that initialize session state at their origin before
            //          making content API calls will silently abort when hit as
            //          a cold deep link. The app boots, but the content fetch
            //          never fires because no session exists yet.
            //
            // Fix (warm navigation):
            //   1. Navigate to origin — seeds cookies / session tokens
            //   2. Wait for origin to settle
            //   3. Navigate to the original deep-link — session is now warm,
            //      the content API call fires normally
            //   4. Final DOM-stability pass
            //
            // General: applies to any SPA with this pattern. Server-rendered
            // pages already have links after step 1, so the guard is skipped
            // with zero extra latency.
            //
            // isShell is already computed above — reuse it, no extra DOM query.
            {
                if (isShell) {
                    const origin = parsedTarget.origin;
                    console.log(`[SPA] Shell detected — warm navigating via origin: ${origin}`);

                    // Step 1: visit origin to seed session cookies / tokens.
                    // We need the session-init XHR to complete (sets cookies/tokens)
                    // but we don't need the page to fully render. networkidle with a
                    // 3s cap is enough — session inits complete well within that.
                    // Kept as networkidle (not a fixed timer) so slower sites still
                    // get their full initialization time if needed.
                    await page.goto(origin, {
                        waitUntil: 'load', timeout: 20000, referer: origin
                    }).catch(() => {});
                    if (typeof page.waitForNetworkIdle === 'function') {
                        await page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch(() => {});
                    }

                    // Step 2: navigate to deep link — session now warm
                    console.log(`[SPA] Warm navigating to target: ${cleanedUrl}`);
                    await page.goto(cleanedUrl, {
                        waitUntil: 'load', timeout: 25000, referer: origin
                    }).catch(() => {});

                    // Step 3: wait for network idle then DOM stability
                    if (typeof page.waitForNetworkIdle === 'function') {
                        await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});
                    }
                    await waitForJSContent(page, false, hints);

                    const warmLinks = await page.evaluate(
                        () => document.querySelectorAll('a[href]').length
                    ).catch(() => 0);
                    console.log(`[SPA] After warm nav: ${warmLinks} links`);
                }
            }

            const pages = [{ html: await page.content(), finalUrl: page.url() }];
            console.log(`[MULTI] Page 1: ${pages[0].html.length} chars | ${(pages[0].html.match(/<a[\s>]/gi) || []).length} anchors`);

            // ── Pages 2-N (Option A): URL-param pagination ─────────────────
            // When an adapter provides hints.pageParam, we page by loading the
            // same URL with that query param incremented (start=25, page=2, …)
            // rather than hunting for a "next" button. This is the only way to
            // paginate server-rendered API endpoints (e.g. LinkedIn's jobs-guest
            // feed) where the page itself IS the result payload.
            if (hints.pageParam) {
                const { pageParam, pageStep = 25, pageStart = 0 } = hints;
                let prevAnchorSet = new Set(
                    (await page.evaluate(() =>
                        [...document.querySelectorAll('a[href]')].map(a => a.href)
                    ).catch(() => []))
                );

                for (let pNum = 2; pNum <= maxDomPages; pNum++) {
                    const pageUrl = new URL(page.url());
                    pageUrl.searchParams.set(pageParam, String(pageStart + (pNum - 1) * pageStep));
                    console.log(`[MULTI] Page ${pNum} (url-param): ${pageParam}=${pageUrl.searchParams.get(pageParam)}`);

                    await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 20000, referer: page.url() })
                        .catch(e => console.log(`[MULTI] goto page ${pNum} error: ${e.message}`));
                    await waitForJSContent(page, true, { ...hints, extraWaitMs: 0 });

                    const html    = await page.content();
                    const anchors = await page.evaluate(() =>
                        [...document.querySelectorAll('a[href]')].map(a => a.href)).catch(() => []);
                    const genuinelyNew = anchors.filter(h => !prevAnchorSet.has(h)).length;

                    // Stop when a page brings essentially nothing new — end of results.
                    if (genuinelyNew < 3) {
                        console.log(`[MULTI] Page ${pNum}: only ${genuinelyNew} new links — end of results`);
                        break;
                    }
                    pages.push({ html, finalUrl: page.url() });
                    anchors.forEach(h => prevAnchorSet.add(h));
                    console.log(`[MULTI] Page ${pNum}: +${genuinelyNew} new links`);
                }

                await new Promise(r => setTimeout(r, 800));
                if (cdpClient) await cdpClient.detach().catch(() => {});
                await savePageCookies(page, cleanedUrl);
                await browser.close();
                console.log(`[MULTI] Done (url-param): ${pages.length} page(s), ${capturedRequests.length} XHR captured`);
                return { pages, capturedRequests };
            }

            // ── Pages 2-N: DOM navigation ──────────────────────────────────
            let currentPageNum = 1;

            for (let pNum = 2; pNum <= maxDomPages; pNum++) {
                const nextAction = await findNextPage(page, currentPageNum);
                if (!nextAction) {
                    console.log(`[MULTI] No next-page element after page ${currentPageNum} — done`);
                    break;
                }

                const prevUrl   = page.url();
                // Capture the actual set of hrefs before navigation so we can
                // detect SPA page-replacement (same anchor count, different links).
                // Count-only comparison misses this and stops pagination too early.
                const prevHrefs = await page.evaluate(() =>
                    [...document.querySelectorAll('a[href]')]
                        .map(a => a.getAttribute('href'))
                        .filter(h => h && h !== '#' && !h.startsWith('javascript:'))
                        .sort().join('|')
                ).catch(() => '');

                console.log(`[MULTI] Page ${pNum}: ${nextAction.type} → ${nextAction.url || nextAction.fallbackText || '?'}`);

                if (nextAction.type === 'navigate' && nextAction.url) {
                    const nextUrl = new URL(nextAction.url, page.url()).toString();
                    await page.goto(nextUrl, { waitUntil: 'load', timeout: 20000, referer: page.url() })
                        .catch(e => console.log(`[MULTI] goto page ${pNum} error: ${e.message}`));
                } else {
                    const clicked = await clickNextElement(page, nextAction);
                    if (!clicked) { console.log(`[MULTI] Click failed on page ${pNum} — stopping`); break; }

                    // Wait for navigation (traditional sites) OR DOM update (SPAs).
                    // Race: whichever comes first — full load or 3s timeout.
                    await Promise.race([
                        page.waitForNavigation({ waitUntil: 'load', timeout: 8000 }).catch(() => {}),
                        new Promise(r => setTimeout(r, 3000)),
                    ]);
                }

                // Fast settle for pages 2+ — session is warm, XHR is faster.
                // Keep selector/scroll hints, but drop the extra dwell time so
                // later pages stay quick.
                await waitForJSContent(page, true, { ...hints, extraWaitMs: 0 });

                const newUrl   = page.url();
                const newHtml  = await page.content();
                const newLinkCount = await page.evaluate(() =>
                    document.querySelectorAll('a').length).catch(() => 0);
                const newHrefs = await page.evaluate(() =>
                    [...document.querySelectorAll('a[href]')]
                        .map(a => a.getAttribute('href'))
                        .filter(h => h && h !== '#' && !h.startsWith('javascript:'))
                        .sort().join('|')
                ).catch(() => '');

                // Stop: no meaningful change.
                // Compare actual href content, not just count.  SPAs that paginate
                // by replacing content (e.g. Next.js job boards) keep the same total
                // anchor count but swap in entirely different links — count-only
                // comparison would wrongly stop here.
                // Count new hrefs that did not exist on the previous page.
                const prevSet = new Set(prevHrefs.split('|'));
                const newSet  = new Set(newHrefs.split('|'));
                const genuinelyNew = [...newSet].filter(h => h && !prevSet.has(h)).length;
                if (newUrl === prevUrl && genuinelyNew < 3) {
                    console.log(`[MULTI] Page ${pNum}: no change (URL same, ${genuinelyNew} new hrefs) — stopping`);
                    break;
                }

                // Stop: looped back to first page
                if (pages.length > 0 && newUrl === pages[0].finalUrl) {
                    console.log(`[MULTI] Page ${pNum}: looped back to start — stopping`);
                    break;
                }

                pages.push({ html: newHtml, finalUrl: newUrl });
                currentPageNum = pNum;
                console.log(`[MULTI] Page ${pNum}: ${newHtml.length} chars | ${newLinkCount} anchors`);
            }

            // Let any in-flight CDP body reads finish before detaching
            await new Promise(r => setTimeout(r, 800));
            if (cdpClient) await cdpClient.detach().catch(() => {});

            await savePageCookies(page, cleanedUrl);
            await browser.close();

            console.log(`[MULTI] Done: ${pages.length} DOM page(s), ${capturedRequests.length} XHR captured`);
            return { pages, capturedRequests };

        } catch (err) {
            if (browser) { try { await browser.close(); } catch {} }
            if (attempt === retries || err.message.startsWith('HARD_BLOCK')) throw err;
            console.log(`[MULTI] Attempt ${attempt} failed: ${err.message}`);
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
        }
    }
}

// ── Cookie/Profile management ─────────────────────────────────────────────────
function getCookieStats() {
    const stats = {};
    for (const domain in cookieJars) {
        const cookies = cookieJars[domain].serializeSync().cookies;
        stats[domain] = {
            count: cookies.length,
            cookies: cookies.map(c => ({ name: c.key, domain: c.domain, expires: c.expires }))
        };
    }
    return stats;
}

function clearCookiesForDomain(domain) {
    if (cookieJars[domain]) { delete cookieJars[domain]; saveCookies(); return true; }
    return false;
}

function clearAllCookies() {
    cookieJars = {};
    saveCookies();
}

function clearProfileForDomain(domain) {
    if (browserProfiles[domain]) { delete browserProfiles[domain]; saveProfiles(); return true; }
    return false;
}

module.exports = {
    scrapeEnhanced,
    scrapeMultiPage,
    getCookieStats,
    clearCookiesForDomain,
    clearAllCookies,
    clearProfileForDomain,
    getOrCreateProfile,
    getDomainKey,
};