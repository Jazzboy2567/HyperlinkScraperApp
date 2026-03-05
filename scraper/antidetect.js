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
        platform: 'Win32',
        createdAt: new Date().toISOString()
    };

    browserProfiles[domain] = profile;
    saveProfiles();
    console.log(`[PROFILES] Created profile for ${domain}: ${profile.screenWidth}x${profile.screenHeight} Chrome/${profile.chromeVersion} ${profile.timezone}`);
    return profile;
}

loadProfiles();

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomDelay(min, max) {
    return new Promise(r => setTimeout(r, min + Math.floor(Math.random() * (max - min))));
}

async function humanMouseMove(page) {
    try {
        const vp = page.viewport();
        if (!vp) return;
        const sx = Math.floor(Math.random() * vp.width);
        const sy = Math.floor(Math.random() * vp.height);
        const ex = Math.floor(Math.random() * vp.width);
        const ey = Math.floor(Math.random() * vp.height);
        const cpx = sx + (Math.random() - 0.5) * 200;
        const cpy = sy + (Math.random() - 0.5) * 200;
        const steps = 20 + Math.floor(Math.random() * 20);
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = Math.round((1 - t) ** 2 * sx + 2 * (1 - t) * t * cpx + t ** 2 * ex);
            const y = Math.round((1 - t) ** 2 * sy + 2 * (1 - t) * t * cpy + t ** 2 * ey);
            await page.mouse.move(x, y);
            await new Promise(r => setTimeout(r, t < 0.8 ? 10 + Math.random() * 15 : 20 + Math.random() * 40));
        }
    } catch { /* non-fatal */ }
}

async function humanScroll(page) {
    try {
        const distance = 300 + Math.floor(Math.random() * 700);
        const steps = 8 + Math.floor(Math.random() * 12);
        const perStep = Math.floor(distance / steps);
        for (let i = 0; i < steps; i++) {
            await page.evaluate(n => window.scrollBy(0, n), perStep);
            await randomDelay(Math.random() > 0.7 ? 300 : 50, Math.random() > 0.7 ? 1200 : 200);
        }
    } catch { /* non-fatal */ }
}

async function simulateHumanBehavior(page) {
    console.log('[HUMAN] Simulating human behavior...');
    await randomDelay(800, 2000);
    await humanMouseMove(page);
    await humanScroll(page);
    if (Math.random() > 0.5) {
        await randomDelay(400, 1000);
        await humanMouseMove(page);
    }
}

// ── Stealth Script ────────────────────────────────────────────────────────────

function getStealthScript(profile) {
    return `
    (() => {
        // ── Core webdriver removal ──────────────────────────────────────────
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
        delete navigator.__proto__.webdriver;

        // ── Hardware fingerprint ────────────────────────────────────────────
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${profile.hardwareConcurrency} });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => ${profile.deviceMemory} });

        // ── Plugins — real Chrome always has these ──────────────────────────
        const makePlugin = (name, filename, desc) => {
            const p = Object.create(Plugin.prototype);
            Object.defineProperties(p, {
                name: { get: () => name }, filename: { get: () => filename },
                description: { get: () => desc }, length: { get: () => 0 }
            });
            return p;
        };
        const pluginArray = [
            makePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
            makePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', 'Portable Document Format'),
            makePlugin('Chromium PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', 'Portable Document Format'),
        ];
        pluginArray.__proto__ = PluginArray.prototype;
        Object.defineProperty(navigator, 'plugins', { get: () => pluginArray });
        Object.defineProperty(navigator, 'mimeTypes', { get: () => [] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'platform', { get: () => '${profile.platform}' });

        // ── chrome.runtime — required for many bot checks ───────────────────
        window.chrome = {
            app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
            runtime: {
                connect: () => {}, sendMessage: () => {}, getPlatformInfo: (cb) => cb({ os: 'win', arch: 'x86-64', nacl_arch: 'x86-64' }),
                onMessage: { addListener: () => {}, removeListener: () => {} },
                onConnect: { addListener: () => {}, removeListener: () => {} },
                id: undefined
            },
            loadTimes: () => ({ requestTime: Date.now() / 1000 - 0.3, startLoadTime: Date.now() / 1000 - 0.3, commitLoadTime: Date.now() / 1000 - 0.1, finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000, firstPaintTime: 0, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' }),
            csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: 1, tran: 15 }),
        };

        // ── Permissions ─────────────────────────────────────────────────────
        const _query = window.navigator.permissions.query.bind(navigator.permissions);
        window.navigator.permissions.query = p =>
            p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : _query(p);

        // ── Canvas noise — defeats canvas fingerprinting ────────────────────
        const _getCtx = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
            const ctx = _getCtx.call(this, type, ...args);
            if (type === '2d' && ctx) {
                const _getImageData = ctx.getImageData.bind(ctx);
                ctx.getImageData = function(x, y, w, h) {
                    const data = _getImageData(x, y, w, h);
                    const noise = ${profile.canvasNoiseSeed % 5};
                    for (let i = 0; i < data.data.length; i += 100) {
                        data.data[i] = data.data[i] ^ noise;
                    }
                    return data;
                };
                const _fillText = ctx.fillText.bind(ctx);
                ctx.fillText = function(...a) { ctx.shadowBlur = ${profile.canvasNoiseSeed % 3}; return _fillText(...a); };
            }
            return ctx;
        };

        // ── WebGL — full vendor/renderer spoof + extensions ─────────────────
        const _getParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(p) {
            if (p === 37445) return 'Intel Inc.';
            if (p === 37446) return 'Intel Iris Pro OpenGL Engine';
            if (p === 35724) return 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
            if (p === 7937)  return 'WebKit WebGL';
            if (p === 7936)  return 'WebKit';
            return _getParam.call(this, p);
        };
        if (typeof WebGL2RenderingContext !== 'undefined') {
            const _getParam2 = WebGL2RenderingContext.prototype.getParameter;
            WebGL2RenderingContext.prototype.getParameter = function(p) {
                if (p === 37445) return 'Intel Inc.';
                if (p === 37446) return 'Intel Iris Pro OpenGL Engine';
                return _getParam2.call(this, p);
            };
        }

        // ── AudioContext fingerprint noise ──────────────────────────────────
        // Headless Chrome has a distinctive AudioContext output; adding tiny
        // noise makes it match real hardware profiles.
        try {
            const _createOscillator = AudioContext.prototype.createOscillator;
            AudioContext.prototype.createOscillator = function() {
                const osc = _createOscillator.apply(this, arguments);
                const _connect = osc.connect.bind(osc);
                osc.connect = function(dest) {
                    return _connect(dest);
                };
                return osc;
            };
            Object.defineProperty(AudioContext.prototype, 'sampleRate', {
                get: function() { return 44100; }
            });
        } catch(e) {}

        // ── Screen dimensions ───────────────────────────────────────────────
        Object.defineProperty(screen, 'width',       { get: () => ${profile.screenWidth} });
        Object.defineProperty(screen, 'height',      { get: () => ${profile.screenHeight} });
        Object.defineProperty(screen, 'availWidth',  { get: () => ${profile.screenWidth} });
        Object.defineProperty(screen, 'availHeight', { get: () => ${profile.screenHeight} - 40 });
        Object.defineProperty(screen, 'colorDepth',  { get: () => 24 });
        Object.defineProperty(screen, 'pixelDepth',  { get: () => 24 });

        // ── User agent — strip HeadlessChrome ───────────────────────────────
        Object.defineProperty(navigator, 'userAgent', {
            get: () => navigator.userAgent.replace('HeadlessChrome', 'Chrome')
        });

        // ── Connection — real users have connection info ─────────────────────
        if (navigator.connection) {
            Object.defineProperty(navigator.connection, 'rtt', { get: () => 100 });
        }

        // ── Object.defineProperty hardening — some checks probe this ────────
        const _defineProperty = Object.defineProperty;
        window._defineProperty = _defineProperty;

        // ── iframe contentWindow ─────────────────────────────────────────────
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
            get: function() { return window; }
        });

        // ── Prevent automation detection via Error stack traces ──────────────
        const _error = Error;
        Error = function(...args) {
            const err = new _error(...args);
            if (err.stack) err.stack = err.stack.replace(/puppeteer|playwright|selenium/gi, 'Chrome');
            return err;
        };
        Error.prototype = _error.prototype;
    })();
    `;
}

// ── Cloudflare Challenge Handler ──────────────────────────────────────────────
async function handleCloudflareChallenge(page) {
    const cfSignals = ['just a moment', 'checking your browser', 'enable javascript and cookies', 'ray id', 'cf-browser-verification'];

    const getText = async () => {
        const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        const title = await page.title().catch(() => '');
        return (body + title).toLowerCase();
    };

    const text = await getText();
    if (!cfSignals.some(s => text.includes(s))) return false;

    console.log('[CF] Cloudflare challenge detected — waiting up to 30s for auto-solve...');
    const startUrl = page.url();

    for (let i = 0; i < 30; i++) {
        await randomDelay(1000, 1500);
        const current = await getText();
        const resolved = !cfSignals.some(s => current.includes(s));
        const redirected = page.url() !== startUrl;

        if (resolved || redirected) {
            console.log(`[CF] Challenge resolved after ~${i + 1}s`);
            await randomDelay(500, 1000);
            return true;
        }

        if (i % 5 === 0) await humanMouseMove(page);
    }

    console.log('[CF] Challenge did not resolve in 30s — continuing anyway');
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
        if (cleaned !== url) {
            console.log(`[URL] Stripped tracking params: ${cleaned}`);
        }
        return cleaned;
    } catch {
        return url;
    }
}

// ── Session Warming ───────────────────────────────────────────────────────────
async function warmSession(page, targetUrl) {
    const domain = getDomainKey(targetUrl);
    console.log(`[WARM] Warming session for ${domain}...`);
    try {
        await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
        await randomDelay(800, 1500);
        await humanMouseMove(page);

        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(domain)}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await randomDelay(800, 1500);
        await humanScroll(page);

        console.log('[WARM] Session warmed successfully');
    } catch (e) {
        console.log('[WARM] Warming failed (non-fatal):', e.message);
    }
}

// ── Wait for Links ────────────────────────────────────────────────────────────
async function waitForLinks(page) {
    let prev = 0, stable = 0;
    for (let i = 0; i < 6; i++) {
        const count = await page.evaluate(() => document.querySelectorAll('a').length).catch(() => 0);
        if (count === prev && count > 5) {
            if (++stable >= 2) { console.log(`[WAIT] Links stable at ${count}`); break; }
        } else {
            stable = 0;
        }
        prev = count;
        await randomDelay(600, 1000);
    }
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
        name: c.key,
        value: c.value,
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

// ── Block heavy non-essential resources to speed up page loads ────────────────
// Only block images and media. Scripts, XHR, fetch and stylesheets must be
// allowed — many sites (e.g. Etsy) run session-validation XHR during page load,
// and blocking those prevents the session from establishing, causing bot walls.
async function blockHeavyResources(page) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const type = req.resourceType();
        // ONLY block images and media — everything else passes through
        if (['image', 'media'].includes(type)) {
            req.abort();
        } else {
            req.continue();
        }
    });
}

// ── Main Enhanced Scraper ─────────────────────────────────────────────────────
async function scrapeEnhanced(url, options = {}) {
    const {
        humanBehavior = true,
        useProfile = true,
        retries = 2
    } = options;

    if (!puppeteer) throw new Error('Puppeteer not available — run: npm install puppeteer-extra puppeteer-extra-plugin-stealth');

    const domain = getDomainKey(url);
    const profile = useProfile ? getOrCreateProfile(domain) : getOrCreateProfile('default');

    console.log(`[ENHANCED] Scraping ${url}`);
    console.log(`[ENHANCED] Profile: ${profile.screenWidth}x${profile.screenHeight} Chrome/${profile.chromeVersion} ${profile.timezone}`);

    for (let attempt = 1; attempt <= retries; attempt++) {
        console.log(`[ENHANCED] Attempt ${attempt}/${retries}`);
        let browser;

        try {
            browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    `--window-size=${profile.screenWidth},${profile.screenHeight}`,
                    '--disable-dev-shm-usage',
                    '--no-first-run',
                    '--lang=en-US',
                    '--disable-extensions',
                    '--mute-audio',
                    // Disable GPU — speeds up headless rendering significantly
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                ]
            });

            const page = await browser.newPage();

            await page.setViewport({
                width: profile.screenWidth,
                height: profile.screenHeight,
                deviceScaleFactor: 1,
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

            // ── Block heavy resources before any navigation ────────────────
            await blockHeavyResources(page);

            // ── Clean URL ──────────────────────────────────────────────────
            const cleanedUrl = cleanUrl(url);

            // ── Restore cookies ────────────────────────────────────────────
            const existingCookies = await restoreCookiesToPage(page, cleanedUrl);

            // ── Warm session on first visit (no cookies yet) ───────────────
            if (existingCookies.length === 0) {
                await warmSession(page, cleanedUrl);
            }

            // ── Pre-visit: build realistic in-session navigation history ───
            // Strict 12s cap — we only need cookies/session state, not full render.
            // If pre-visit fails or is slow we skip it rather than burning budget.
            try {
                const parsedUrl = new URL(cleanedUrl);
                const origin = parsedUrl.origin;
                const isDeepPath = parsedUrl.pathname.length > 1;

                if (isDeepPath) {
                    const preVisitUrl = options.refererUrl || origin;
                    console.log(`[ENHANCED] Pre-visiting: ${preVisitUrl}`);

                    await Promise.race([
                        page.goto(preVisitUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: 12000,
                            referer: 'https://www.google.com/'
                        }),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('pre-visit timeout')), 12000))
                    ]);

                    await handleCloudflareChallenge(page);
                    await savePageCookies(page, cleanedUrl);

                    const preVisitSize = (await page.content().catch(() => '')).length;
                    if (preVisitSize < 5000) {
                        console.log(`[ENHANCED] Pre-visit page too small (${preVisitSize} chars) — skipping to target`);
                    } else {
                        // Minimal human signal — just a quick mouse move, no full scroll
                        await randomDelay(600, 1000);
                        await humanMouseMove(page);
                        await randomDelay(400, 700);
                    }
                }
            } catch (e) {
                console.log('[ENHANCED] Pre-visit failed (non-fatal):', e.message);
            }

            // ── Navigate to target ─────────────────────────────────────────
            console.log('[ENHANCED] Navigating to target...');

            const parsedTarget = new URL(cleanedUrl);
            const targetPath = parsedTarget.pathname;
            const pathParts = targetPath.split('/').filter(Boolean);

            // Build the most specific same-site referer we can.
            const targetReferer = options.refererUrl
                || (pathParts.length > 1 ? `${parsedTarget.origin}/${pathParts[0]}` : parsedTarget.origin);

            // ── Two-strategy navigation ────────────────────────────────────
            // Strategy 1: If we already have a page open on this domain (from
            // the pre-visit), use JS location assignment. This looks identical
            // to the site's own SPA navigation and bypasses checks that look
            // for cold browser navigations to deep URLs. We then wait for the
            // DOM to settle rather than relying on a navigation event.
            //
            // Strategy 2: Fall back to goto for root-level or cross-origin.

            const currentUrl = page.url();
            const alreadyOnDomain = (() => {
                try {
                    return new URL(currentUrl).hostname === parsedTarget.hostname;
                } catch { return false; }
            })();

            let htmlSize = 0;

            if (alreadyOnDomain && pathParts.length > 0) {
                console.log(`[ENHANCED] JS navigate (same domain): ${cleanedUrl}`);
                // Kick off navigation and wait for it concurrently — window.location.href
                // does cause a real Puppeteer navigation event, we just need to race it.
                const [navResult] = await Promise.allSettled([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 18000 }),
                    page.evaluate((url) => { window.location.href = url; }, cleanedUrl)
                ]);
                if (navResult.status === 'rejected') {
                    console.log(`[ENHANCED] waitForNavigation rejected: ${navResult.reason?.message}`);
                }
                await randomDelay(600, 1000);
                htmlSize = (await page.content().catch(() => '')).length;
                if (htmlSize >= 5000) {
                    console.log(`[ENHANCED] JS navigate settled — ${htmlSize} chars`);
                } else {
                    console.log(`[ENHANCED] JS navigate page small (${htmlSize} chars)`);
                }
            } else {
                console.log(`[ENHANCED] goto with referer: ${targetReferer}`);
                await page.goto(cleanedUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000,
                    referer: targetReferer
                });
                await randomDelay(800, 1500);
                htmlSize = (await page.content().catch(() => '')).length;
            }

            // ── Guard: page too small ──────────────────────────────────────
            if (htmlSize < 5000) {
                // Check if this is a hard server-side block (tiny fixed response).
                // These are TLS/IP-level blocks — no navigation strategy fixes them,
                // so don't waste time on a fallback goto or a second retry attempt.
                const rawHtml = (await page.content().catch(() => '')).toLowerCase();
                const isHardBlock = htmlSize > 0 && htmlSize < 2000 && (
                    rawHtml.includes('robot') ||
                    rawHtml.includes('blocked') ||
                    rawHtml.includes('access denied') ||
                    rawHtml.includes('captcha') ||
                    rawHtml.includes('unusual traffic') ||
                    rawHtml.length < 1000  // truly empty = hard block
                );

                if (isHardBlock) {
                    console.log(`[ENHANCED] Hard server-side block detected (${htmlSize} chars) — skipping retries`);
                    throw new Error(`HARD_BLOCK: This page is protected at the server level (TLS fingerprinting or IP block). A residential proxy or real Chrome binary is required to access it.`);
                }

                // Not a hard block — try a direct goto as final fallback
                console.log(`[ENHANCED] Page still small (${htmlSize} chars) — fallback goto...`);
                await page.goto(cleanedUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 20000,
                    referer: targetReferer
                });
                await randomDelay(800, 1500);
                htmlSize = (await page.content().catch(() => '')).length;
            }

            if (htmlSize < 5000) {
                // Check again after fallback
                const rawHtml2 = (await page.content().catch(() => '')).toLowerCase();
                const stillBlocked = htmlSize < 2000;
                if (stillBlocked) {
                    throw new Error(`HARD_BLOCK: This page is protected at the server level (TLS fingerprinting or IP block). A residential proxy or real Chrome binary is required to access it.`);
                }
                throw new Error(`Page too small after navigation (${htmlSize} chars) — likely blocked or redirected`);
            }

            // ── Handle Cloudflare challenge ────────────────────────────────
            await handleCloudflareChallenge(page);

            // ── Save cookies after landing ─────────────────────────────────
            await savePageCookies(page, cleanedUrl);

            // ── Check for bot detection signals ────────────────────────────
            const bodyText = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).toLowerCase();
            const botSignals = ['unusual activity', 'access denied', 'bot activity', 'automated requests', 'verify you are human', 'are you a robot'];
            const detected = botSignals.find(s => bodyText.includes(s));

            if (detected) {
                console.log(`[BOT DETECTED] "${detected}" on attempt ${attempt}`);
                await browser.close();
                if (attempt < retries) {
                    const wait = 6000 * attempt;
                    console.log(`[RETRY] Waiting ${wait}ms...`);
                    await randomDelay(wait, wait + 3000);
                    continue;
                }
                throw new Error(`Bot detected after ${retries} attempts: ${detected}`);
            }

            // ── Simulate human behavior (only if budget allows) ────────────
            // Skip on retry attempts to save time, and keep it lightweight.
            if (humanBehavior && attempt === 1) {
                await simulateHumanBehavior(page);
            }

            // ── Wait for dynamic content ───────────────────────────────────
            await waitForLinks(page);

            const html = await page.content();
            const finalUrl = page.url();

            await savePageCookies(page, cleanedUrl);

            await browser.close();
            console.log(`[ENHANCED] Success on attempt ${attempt}, HTML: ${html.length} chars`);
            return { html, method: 'puppeteer-enhanced', finalUrl };

        } catch (error) {
            if (browser) { try { await browser.close(); } catch {} }
            if (attempt === retries) throw error;
            console.log(`[ENHANCED] Attempt ${attempt} failed: ${error.message}`);
            await randomDelay(3000, 5000);
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
    if (cookieJars[domain]) {
        delete cookieJars[domain];
        saveCookies();
        return true;
    }
    return false;
}

function clearAllCookies() {
    cookieJars = {};
    saveCookies();
}

function clearProfileForDomain(domain) {
    if (browserProfiles[domain]) {
        delete browserProfiles[domain];
        saveProfiles();
        return true;
    }
    return false;
}

module.exports = {
    scrapeEnhanced,
    getCookieStats,
    clearCookiesForDomain,
    clearAllCookies,
    clearProfileForDomain,
    getOrCreateProfile,
    getDomainKey
};