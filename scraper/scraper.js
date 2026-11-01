const http  = require('http');
const https = require('https');
const fs = require('fs');
const cheerio = require('cheerio');

const {
    scrapeEnhanced,
    scrapeMultiPage,
    getCookieStats,
    clearCookiesForDomain,
    clearAllCookies,
    clearProfileForDomain,
    getOrCreateProfile
} = require('./antidetect');

// Per-site URL rewriting + engine hints. Data-driven and generic —
// see site_adapters.js to teach the scraper a new site.
const { rewriteUrl, getScrapeHints, getLinkTransformer } = require('./site_adapters');

// ── XHR Replay ────────────────────────────────────────────────────────────────
// These functions replay captured browser API calls directly using Node's
// built-in https — no Puppeteer, no browser startup cost.
// Pages 2-N go from ~8s (full browser) to ~300ms (raw HTTP).

// Raw HTTP request using Node built-ins — no dependencies.
function httpRequest(url, method = 'GET', headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const parsed  = new URL(url);
        const mod     = parsed.protocol === 'https:' ? https : http;
        const options = {
            hostname: parsed.hostname,
            port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path:     parsed.pathname + parsed.search,
            method,
            headers:  {
                ...headers,
                // Force identity encoding — we handle raw text, not gzip streams
                'accept-encoding': 'identity',
            },
            timeout: 10000,
        };

        const req = mod.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ body: data, status: res.statusCode, headers: res.headers }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('XHR replay timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

// Recursively extract { url, text } links from a JSON API response.
// Strategy: scan ALL string values for URL patterns, try to find a nearby
// text field on the same object to use as label. This works regardless of
// what key names the API uses (jobUrl, href, canonicalUrl, path, etc.)
const URL_PATTERN = /^(https?:\/\/|\/[a-zA-Z0-9])[^\s"'<>]{4,}/i;
// Keys treated as URL fields — checked before the generic URL_PATTERN scan.
// Listing job-board and e-commerce specific names covers most real APIs.
const URL_KEYS = new Set([
    'url', 'href', 'link', 'path', 'uri',
    'joburl', 'joblink', 'jobpath', 'landingpageurl', 'applyurl', 'detailurl',
    'producturl', 'pageurl', 'canonicalurl', 'permalink', 'slug',
    'externalurl', 'redirecturl', 'targeturl', 'deeplink',
]);
const TEXT_KEYS = new Set([
    'title', 'name', 'label', 'jobtitle', 'positiontitle',
    'displaytitle', 'requisitiontitle', 'heading', 'summary',
    'jobname', 'positionname', 'rolename', 'jobrole',
]);

function extractLinksFromJson(obj, baseUrl, _seen = new Set(), depth = 0) {
    const links = [];
    if (depth > 15 || !obj) return links;

    if (Array.isArray(obj)) {
        for (const item of obj) links.push(...extractLinksFromJson(item, baseUrl, _seen, depth + 1));
        return links;
    }

    if (typeof obj === 'object') {
        let foundUrl  = null;
        let foundText = '';

        for (const [k, v] of Object.entries(obj)) {
            if (typeof v !== 'string') continue;
            const lk = k.toLowerCase().replace(/[_\-]/g, '');

            // Priority 1: key is explicitly a URL field
            if (!foundUrl && URL_KEYS.has(lk) && URL_PATTERN.test(v)) {
                foundUrl = v;
            }

            // Priority 2: value looks like a URL and key isn't media
            if (!foundUrl && URL_PATTERN.test(v)) {
                const isMedia = lk.includes('image') || lk.includes('img') ||
                                lk.includes('icon') || lk.includes('logo') ||
                                lk.includes('thumb') || lk.includes('photo') ||
                                lk.includes('avatar') || lk.includes('banner');
                if (!isMedia) foundUrl = v;
            }

            if (!foundText && TEXT_KEYS.has(lk) && v.trim().length > 2) foundText = v.trim();
        }

        if (foundUrl) {
            try {
                const resolved = new URL(foundUrl, baseUrl).toString();
                if (!_seen.has(resolved)) {
                    _seen.add(resolved);
                    links.push({ url: resolved, text: foundText || foundUrl });
                }
            } catch {}
        }

        for (const v of Object.values(obj)) {
            if (v && typeof v === 'object') links.push(...extractLinksFromJson(v, baseUrl, _seen, depth + 1));
        }
    }

    return links;
}

// Count the total number of items in the largest array anywhere in a JSON object.
// Used to score captured requests — the one with the biggest array is the content call.
function largestArrayCount(obj, depth = 0) {
    if (depth > 10 || !obj || typeof obj !== 'object') return 0;
    if (Array.isArray(obj)) {
        return Math.max(obj.length, ...obj.map(i => largestArrayCount(i, depth + 1)));
    }
    return Math.max(0, ...Object.values(obj).map(v => largestArrayCount(v, depth + 1)));
}

const PAGE_PARAMS   = ['page', 'p', 'pg', 'pagenumber', 'pageno', 'currentpage', 'pageindex'];
// Broad offset param list — covers Solr (start/rows), Elastic (from/size),
// generic REST APIs (offset/limit, skip/take, first/count), and IBM-style APIs
const OFFSET_PARAMS = [
    'start', 'offset', 'from', 'skip', 'first',
    'rows', 'size', 'limit', 'count', 'num',
    'pagesize', 'per_page', 'perpage', 'numresults', 'numitems',
    'results_per_page', 'items_per_page', 'page_size',
];
// Analytics/tracking domains to skip entirely when choosing content request
const SKIP_DOMAINS  = new Set([
    'segment.io', 'segment.com', 'demdex.net', 'trustarc.com',
    'company-target.com', 'doubleclick.net', 'google-analytics.com',
    'googletagmanager.com', 'facebook.net', 'hotjar.com', 'mixpanel.com',
]);

function isAnalyticsDomain(url) {
    try {
        const host = new URL(url).hostname;
        return [...SKIP_DOMAINS].some(d => host === d || host.endsWith('.' + d));
    } catch { return false; }
}

// Recursively search a JSON object for a key that matches a pagination param.
// Returns { keyPath, value } or null. Depth-first so shallow keys win.
function findNestedParam(obj, params, depth = 0) {
    if (depth > 6 || !obj || typeof obj !== 'object') return null;
    for (const [k, v] of Object.entries(obj)) {
        const lk = k.toLowerCase();
        if (params.includes(lk) && (typeof v === 'number' || typeof v === 'string')) {
            return { key: k, value: v };
        }
    }
    for (const v of Object.values(obj)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const found = findNestedParam(v, params, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

// Recursively set a key in a JSON object (modifies in place, returns true if set).
function setNestedParam(obj, key, newValue, depth = 0) {
    if (depth > 6 || !obj || typeof obj !== 'object') return false;
    if (key in obj) { obj[key] = newValue; return true; }
    for (const v of Object.values(obj)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (setNestedParam(v, key, newValue, depth + 1)) return true;
        }
    }
    return false;
}

// Given a captured request and target page number, returns a replay descriptor
// { url, method, body } or null if no pagination param found.
function buildReplayUrl(captured, pageNum) {
    try {
        // ── URL query params ──────────────────────────────────────────────
        const u = new URL(captured.url);

        for (const param of PAGE_PARAMS) {
            if (u.searchParams.has(param)) {
                u.searchParams.set(param, pageNum);
                return { url: u.toString(), method: captured.method, body: captured.postData };
            }
        }
        for (const param of OFFSET_PARAMS) {
            if (u.searchParams.has(param)) {
                const pageSize = largestArrayCount(captured.responseJson);
                if (pageSize < 1) return null;
                u.searchParams.set(param, (pageNum - 1) * pageSize);
                return { url: u.toString(), method: captured.method, body: captured.postData };
            }
        }

        // ── POST JSON body params (top-level and nested) ──────────────────
        if (captured.postData && (captured.method === 'POST' || captured.method === 'PUT')) {
            try {
                const bodyObj = JSON.parse(captured.postData);

                // Top-level page param
                for (const param of PAGE_PARAMS) {
                    if (param in bodyObj) {
                        bodyObj[param] = pageNum;
                        return { url: captured.url, method: captured.method, body: JSON.stringify(bodyObj) };
                    }
                }
                // Top-level offset param
                for (const param of OFFSET_PARAMS) {
                    if (param in bodyObj) {
                        const pageSize = largestArrayCount(captured.responseJson);
                        if (pageSize < 1) return null;
                        bodyObj[param] = (pageNum - 1) * pageSize;
                        return { url: captured.url, method: captured.method, body: JSON.stringify(bodyObj) };
                    }
                }

                // Nested page param — walk the object tree
                const nestedPage = findNestedParam(bodyObj, PAGE_PARAMS);
                if (nestedPage) {
                    setNestedParam(bodyObj, nestedPage.key, pageNum);
                    return { url: captured.url, method: captured.method, body: JSON.stringify(bodyObj) };
                }

                // Nested offset param
                const nestedOffset = findNestedParam(bodyObj, OFFSET_PARAMS);
                if (nestedOffset) {
                    const pageSize = largestArrayCount(captured.responseJson);
                    if (pageSize < 1) return null;
                    setNestedParam(bodyObj, nestedOffset.key, (pageNum - 1) * pageSize);
                    return { url: captured.url, method: captured.method, body: JSON.stringify(bodyObj) };
                }
            } catch {}
        }
    } catch {}
    return null;
}

// Pick the captured request most likely to be the page's main content API.
//
// SELECTION STRATEGY — two-pass scoring:
//
// Pass 1: Score only requests where pagination params are detectable.
//   This is the correct pool — only paginate-able requests can be replayed.
//   Prevents a high-array metadata/filter call (e.g. a GraphQL GetFilters that
//   returns 900 facet values) from beating the actual paginated content call
//   even though the filter call fires once and can never be paginated.
//
// Pass 2: If NO request in pass 1 scored (no pagination params anywhere),
//   fall back to scoring everything so the caller gets a useful log and the
//   POST body is printed — making it easy to identify and add the missing param.
//
// Score formula: (largestArray × 100 + bodyLength) × domainBonus
//   largestArray × 100  — content richness: more items = more likely listing
//   bodyLength          — tie-breaker: bigger response = more content
//   domainBonus ×10     — same root domain calls preferred over third-party
//
function findContentRequest(capturedRequests, pageUrl) {
    if (!capturedRequests || capturedRequests.length === 0) return null;

    let rootDomain = '';
    try {
        const parts = new URL(pageUrl).hostname.split('.');
        rootDomain = parts.slice(-2).join('.');
    } catch {}

    const scoreReq = (req) => {
        const arrayScore = largestArrayCount(req.responseJson);
        let reqHostname = '';
        try { reqHostname = new URL(req.url).hostname; } catch {}
        const domainBonus = (reqHostname === rootDomain || reqHostname.endsWith('.' + rootDomain)) ? 10 : 1;
        return (arrayScore * 100 + req.bodyLength) * domainBonus;
    };

    // Pass 1: only paginate-able candidates
    let best = null;
    let bestScore = 0;

    for (const req of capturedRequests) {
        if (isAnalyticsDomain(req.url)) continue;
        const replayable = buildReplayUrl(req, 2);
        if (!replayable) continue; // not paginate-able — skip in pass 1

        const score = scoreReq(req);
        console.log(`[XHR] Replayable score ${score} (arrays:${largestArrayCount(req.responseJson)} size:${req.bodyLength}): ${req.method} ${req.url}`);
        if (score > bestScore) { bestScore = score; best = req; }
    }

    if (best) {
        console.log(`[XHR] Best replayable candidate: ${best.method} ${best.url}`);
        if (best.postData) {
            try   { console.log(`[XHR] POST body: ${JSON.stringify(JSON.parse(best.postData)).slice(0, 400)}`); }
            catch { console.log(`[XHR] POST body (raw): ${best.postData.slice(0, 400)}`); }
        }
        console.log(`[XHR] Pagination detected — ready to replay`);
        return best;
    }

    // Pass 2: no paginate-able candidate found — score everything for diagnostics
    console.log('[XHR] No paginate-able candidates in pass 1 — scoring all for diagnostics');
    let diagBest = null;
    let diagBestScore = 0;

    for (const req of capturedRequests) {
        if (isAnalyticsDomain(req.url)) continue;
        const score = scoreReq(req);
        console.log(`[XHR] Candidate score ${score} (arrays:${largestArrayCount(req.responseJson)} size:${req.bodyLength} domain:×${(new URL(req.url).hostname.endsWith(rootDomain) ? 10 : 1)}): ${req.url}`);
        if (score > diagBestScore) { diagBestScore = score; diagBest = req; }
    }

    if (!diagBest) {
        console.log('[XHR] No content candidates found (all skipped as analytics)');
        return null;
    }

    console.log(`[XHR] Best non-replayable candidate: ${diagBest.method} ${diagBest.url}`);
    if (diagBest.postData) {
        try   { console.log(`[XHR] POST body: ${JSON.stringify(JSON.parse(diagBest.postData)).slice(0, 400)}`); }
        catch { console.log(`[XHR] POST body (raw): ${diagBest.postData.slice(0, 400)}`); }
    }
    console.log('[XHR] Pagination params not detected in best candidate — XHR replay not possible');
    console.log('[XHR] Add the param name shown above to OFFSET_PARAMS or PAGE_PARAMS to enable replay');
    return null;
}

// Replay a captured API request for a given page number and return extracted links.
async function replayXHRPage(captured, pageNum, baseUrl) {
    const target = buildReplayUrl(captured, pageNum);
    if (!target) return null;

    const { url, method, body } = target;
    console.log(`[XHR] Replaying page ${pageNum}: ${method} ${url}`);

    const { body: resBody, status } = await httpRequest(url, method, captured.headers, body || null);

    if (status < 200 || status >= 300) {
        console.log(`[XHR] Page ${pageNum} returned status ${status}`);
        return null;
    }

    let json;
    try { json = JSON.parse(resBody); } catch {
        console.log(`[XHR] Page ${pageNum} response is not JSON`);
        return null;
    }

    const links = extractLinksFromJson(json, baseUrl);
    console.log(`[XHR] Page ${pageNum} yielded ${links.length} links`);
    return links;
}

// ── Cache ──────────────────────────────────────────────────────────────────
const cache = {};
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_SIZE = 100;

function cacheSet(key, data) {
    const keys = Object.keys(cache);
    if (keys.length >= MAX_CACHE_SIZE) {
        const oldest = keys.sort((a, b) => cache[a].cachedAt - cache[b].cachedAt)[0];
        delete cache[oldest];
    }
    cache[key] = { data, cachedAt: Date.now(), expiresAt: Date.now() + CACHE_TTL_MS };
}

function cacheGet(key) {
    const entry = cache[key];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { delete cache[key]; return null; }
    return entry;
}

// ── Last successful page per hostname — used as Referer on next request ────
const lastSuccessfulPage = {};

// ── Permanent seen-links store ─────────────────────────────────────────────
const SEEN_LINKS_FILE = './seen_links.json';
let seenLinks = new Set();

try {
    const saved = JSON.parse(fs.readFileSync(SEEN_LINKS_FILE, 'utf8'));
    seenLinks = new Set(saved);
    console.log(`[SEEN] Loaded ${seenLinks.size} previously seen links`);
} catch {
    console.log('[SEEN] No seen_links.json found, starting fresh');
}

function saveSeenLinks() {
    fs.writeFileSync(SEEN_LINKS_FILE, JSON.stringify([...seenLinks]));
}

function normalizeUrl(url) {
    try {
        const u = new URL(url);
        ['trackingId', 'refId', 'trk', 'position', 'pageNum', 'sessionId'].forEach(p => u.searchParams.delete(p));
        return u.origin + u.pathname + (u.search || '');
    } catch {
        return url;
    }
}

function markLinksSeen(links) {
    let added = 0;
    links.forEach(link => {
        const key = normalizeUrl(link.url);
        if (!seenLinks.has(key)) { seenLinks.add(key); added++; }
    });
    if (added > 0) saveSeenLinks();
    return added;
}

function filterToNewLinks(links) {
    return links.filter(link => !seenLinks.has(normalizeUrl(link.url)));
}

const port = process.env.PORT || 3000;
const host = '0.0.0.0';

// ── Proxy Configuration ────────────────────────────────────────────────────
// Proxy support now lives in antidetect.js (getProxy + page.authenticate),
// which is where browsers are launched. Configure it via env vars:
//   USE_PROXY=true  PROXY_URL=http://user:pass@host:port
//   (or PROXY_POOL=http://a,http://b for random rotation)

// ── Request Router ─────────────────────────────────────────────────────────
const server = http.createServer(function (req, res) {
    if (req.url === '/health' || req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }
    if (req.url.startsWith('/api/scrape'))          return scrapeWebsite(req, res);
    if (req.url.startsWith('/api/cache'))           return handleCache(req, res);
    if (req.url.startsWith('/api/analyze-content')) return analyzeContent(req, res);
    if (req.url.startsWith('/api/cookies'))         return handleCookieManager(req, res);
    if (req.url.startsWith('/api/profiles'))        return handleProfileManager(req, res);
    if (req.url === '/api/test') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'ok', message: 'Scraper API is running!',
            endpoints: {
                scrape:  '/api/scrape?url=YOUR_URL',
                analyze: '/api/analyze-content?url=YOUR_URL&keywords=keyword1,keyword2',
                cookies: '/api/cookies?action=list',
                profiles: '/api/profiles?action=list'
            }
        }));
    }
    if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.readFile('index.html', (err, data) => {
            if (err) { res.writeHead(404); res.write('Error: File Not Found'); }
            else res.write(data);
            res.end();
        });
        return;
    }
    res.writeHead(404);
    res.end('Not Found');
});

function getBaseUrl(req) {
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    return `${protocol}://${req.headers.host}`;
}

server.listen(port, host, (error) => {
    if (error) {
        console.log('Something went wrong', error);
    } else {
        console.log(`Server is listening on ${host}:${port}`);
        console.log('Environment: ' + (process.env.PORT ? 'Production (Render)' : 'Local Development'));
        if (!process.env.PORT) console.log(`Open http://localhost:${port} in your browser`);
    }
});

// ── Crash guards ─────────────────────────────────────────────────────────────
// A single bad scrape must never take the whole server down. On Node 15+ an
// unhandled promise rejection terminates the process by default — and Puppeteer
// is a rich source of them (e.g. a browser op that rejects AFTER the 60s
// Promise.race timeout already "won", so nothing is awaiting it any more).
// We log and keep serving instead of exiting. Individual requests are already
// isolated behind their own try/catch, so staying alive is safe here.
process.on('unhandledRejection', (reason) => {
    console.error('[GUARD] Unhandled promise rejection (server kept alive):',
        reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
    console.error('[GUARD] Uncaught exception (server kept alive):', err && err.message ? err.message : err);
});

// ── Cache Handler ──────────────────────────────────────────────────────────
function handleCache(req, res) {
    const params = new URL(req.url, getBaseUrl(req)).searchParams;
    const action = params.get('action') || 'list';
    const lookupUrl = params.get('url');

    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (action === 'list') {
        const now = Date.now();
        return res.end(JSON.stringify({
            count: Object.keys(cache).length,
            entries: Object.entries(cache).map(([key, entry]) => ({
                key,
                cachedAt: new Date(entry.cachedAt),
                expiresAt: new Date(entry.expiresAt),
                ttlRemainingSeconds: Math.max(0, Math.round((entry.expiresAt - now) / 1000)),
                linkCount: entry.data?.externalLinks?.length ?? 0
            }))
        }));
    }

    if (!lookupUrl) return res.end(JSON.stringify({ error: 'url param required for this action' }));

    if (action === 'get') {
        const entry = cacheGet(lookupUrl);
        if (!entry) return res.end(JSON.stringify({ hit: false, url: lookupUrl }));
        return res.end(JSON.stringify({ hit: true, cachedAt: new Date(entry.cachedAt), expiresAt: new Date(entry.expiresAt), ...entry.data }));
    }
    if (action === 'delete') {
        const existed = !!cache[lookupUrl];
        delete cache[lookupUrl];
        return res.end(JSON.stringify({ deleted: existed, key: lookupUrl }));
    }
    if (action === 'clear') {
        const count = Object.keys(cache).length;
        Object.keys(cache).forEach(k => delete cache[k]);
        return res.end(JSON.stringify({ cleared: count }));
    }

    res.end(JSON.stringify({ error: 'Unknown action. Valid: list, get, delete, clear' }));
}

// ── Cookie Manager Handler ─────────────────────────────────────────────────
function handleCookieManager(req, res) {
    const params = new URL(req.url, getBaseUrl(req)).searchParams;
    const action = params.get('action') || 'list';
    const domain = params.get('domain');

    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (action === 'list')                  return res.end(JSON.stringify(getCookieStats()));
    if (action === 'clear' && domain)       return res.end(JSON.stringify({ cleared: clearCookiesForDomain(domain), domain }));
    if (action === 'clearAll')              { clearAllCookies(); return res.end(JSON.stringify({ cleared: true })); }

    res.end(JSON.stringify({ error: 'Unknown action. Valid: list, clear, clearAll' }));
}

// ── Profile Manager Handler ────────────────────────────────────────────────
function handleProfileManager(req, res) {
    const params = new URL(req.url, getBaseUrl(req)).searchParams;
    const action = params.get('action') || 'list';
    const domain = params.get('domain');

    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (action === 'list') {
        try { return res.end(JSON.stringify(JSON.parse(fs.readFileSync('./browser_profiles.json', 'utf8')))); }
        catch { return res.end(JSON.stringify({})); }
    }
    if (action === 'reset' && domain) return res.end(JSON.stringify({ cleared: clearProfileForDomain(domain), domain }));
    if (action === 'view'  && domain) return res.end(JSON.stringify(getOrCreateProfile(domain)));

    res.end(JSON.stringify({ error: 'Unknown action. Valid: list, reset, view' }));
}

// ── Open Graph Extraction ──────────────────────────────────────────────────
function extractOpenGraphData($) {
    const og = {};
    $('meta[property^="og:"]').each((_, el) => {
        const p = $(el).attr('property'), c = $(el).attr('content');
        if (p && c) og[p.replace('og:', '')] = c;
    });
    if (!og.title)       og.title       = $('meta[name="twitter:title"]').attr('content') || $('title').first().text() || $('h1').first().text();
    if (!og.description) og.description = $('meta[name="twitter:description"]').attr('content') || $('meta[name="description"]').attr('content');
    if (!og.image)       og.image       = $('meta[name="twitter:image"]').attr('content');
    return og;
}

// ── Content Analysis ───────────────────────────────────────────────────────
async function analyzeContent(req, res) {
    const params = new URL(req.url, getBaseUrl(req)).searchParams;
    const url = params.get('url');
    const keywordsParam = params.get('keywords');

    if (!url || !keywordsParam) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'URL and keywords required' }));
    }

    const userKeywords = keywordsParam.toLowerCase().split(',').map(s => s.trim());
    const { url: scrapeUrl } = rewriteUrl(url);
    const hints = getScrapeHints(scrapeUrl);
    console.log('[ANALYZE] Analyzing content:', scrapeUrl);

    try {
        const result = await scrapeEnhanced(scrapeUrl, { useProfile: true, retries: 1, hints });
        const $ = cheerio.load(result.html);
        const pageText = $('body').text().toLowerCase();
        const og = extractOpenGraphData($);
        const matchedKeywords = userKeywords.filter(kw => pageText.includes(kw));

        console.log('[ANALYZE] Matched:', matchedKeywords.length, 'of', userKeywords.length, 'keywords');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            matchedKeywords, totalKeywords: userKeywords.length, matchCount: matchedKeywords.length,
            preview: { title: og.title, description: og.description, image: og.image, url: og.url || url }
        }));
    } catch (error) {
        console.error('[ANALYZE] Error:', error.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// ── Link Helpers ───────────────────────────────────────────────────────────
function deduplicateLinks(links) {
    const seen = new Set();
    return links.filter(link => seen.has(link.url) ? false : (seen.add(link.url), true));
}

function filterUnwantedLinks(links) {
    const unwanted = ['.css', '.js', '.json', '.xml', '.woff', '.woff2', '.ttf', '.eot', '.svg', '.ico'];
    return links.filter(link => {
        try { return !unwanted.some(ext => new URL(link.url).pathname.toLowerCase().endsWith(ext)); }
        catch { return true; }
    });
}

function categorizeLinks(links) {
    const domainGroups = {};

    links.forEach((link, index) => {
        try {
            const urlObj = new URL(link.url);
            const domain = urlObj.hostname;
            const pathParts = urlObj.pathname.split('/').filter(p => p.length > 0);
            if (!domainGroups[domain]) domainGroups[domain] = {};
            for (let depth = 1; depth <= Math.min(3, pathParts.length); depth++) {
                const pattern = pathParts.slice(0, depth).join('/');
                if (!domainGroups[domain][pattern]) domainGroups[domain][pattern] = [];
                domainGroups[domain][pattern].push({ ...link, index, pathParts, depth });
            }
        } catch {}
    });

    const categories = [];
    const usedLinks = new Set();
    const allPatterns = [];

    for (const domain in domainGroups) {
        for (const pattern in domainGroups[domain]) {
            allPatterns.push({ domain, pattern, depth: pattern.split('/').length, links: domainGroups[domain][pattern] });
        }
    }
    allPatterns.sort((a, b) => b.depth !== a.depth ? b.depth - a.depth : b.links.length - a.links.length);

    for (const pg of allPatterns) {
        const available = pg.links.filter(l => !usedLinks.has(l.index));
        if (available.length < 3) continue;

        const allPaths = available.map(l => l.pathParts);
        const commonParts = [];
        const maxLen = Math.min(...allPaths.map(p => p.length));
        for (let i = 0; i < maxLen; i++) {
            if (allPaths.every(path => path[i] === allPaths[0][i])) commonParts.push(allPaths[0][i]);
            else break;
        }

        const uniqueSubcats = [...new Set(available.map(l => l.pathParts.slice(commonParts.length).join('/') || 'root'))];
        if (uniqueSubcats.length > 1 || available.length >= 5) {
            categories.push({ domain: pg.domain, pattern: commonParts.join('/') || pg.domain, commonPath: commonParts, count: available.length, links: available });
            available.forEach(l => usedLinks.add(l.index));
        }
    }

    return categories.sort((a, b) => b.count - a.count);
}

// ── Link Extraction ────────────────────────────────────────────────────────
// Handles both standard anchor links and non-anchor clickable elements used
// by React/Vue/Angular component libraries:
//
//   Source type                   Example pattern
//   ─────────────────────────────────────────────────────────────────────────
//   Standard anchor               <a href="/product/123">
//   Anchor with data attrs        <a data-href="/product/123">
//   role="link" element           <div role="link" data-href="/product/123">
//   data-url / data-link          <div data-url="/product/123">
//   tabindex="0" navigables       <li tabindex="0" data-path="/product/123">
//
// Non-anchor elements are only included when they carry an explicit URL
// attribute — never guessed from onClick handlers or cursor:pointer styles.
//
function extractLinks($, finalUrl) {
    const MAX_LINK_TEXT = 150;

    const isMeaningful = (str) => {
        if (!str || str.length < 1) return false;
        str = str.replace(/\s*\[[a-z0-9\-]+\]\s*/gi, '').trim();
        if (!str) return false;
        if (/^\d+$/.test(str)) return false;
        if (/^\d{4}[A-Za-z]+[\d\.]+[A-Za-z]?[\d\.]*[A-Z]?$/i.test(str)) return false;
        if (/^\d{4}-\d{3}[\dXx]$/.test(str)) return false;
        if (/^10\.\d+\//.test(str)) return false;
        if (/^[\d\.]+$/.test(str)) return false;
        if (/[a-z]\d+$/i.test(str)) return false;
        if (['archived', 'archive', 'click here', 'read more', 'link', 'here', 'more'].includes(str.toLowerCase())) return false;
        if (str.length < 3 && !/[a-zA-Z]/.test(str)) return false;
        return true;
    };

    const resolveHref = (href) => {
        if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return null;
        if (href.startsWith('http://') || href.startsWith('https://')) return href;
        if (href.startsWith('//')) return 'https:' + href;
        try { return new URL(href, finalUrl).toString(); }
        catch { return null; }
    };

    const URL_ATTRS = ['href', 'data-href', 'data-url', 'data-link', 'data-path', 'data-target'];

    const getHref = (elem) => {
        for (const attr of URL_ATTRS) {
            const val = $(elem).attr(attr);
            if (val) return val;
        }
        return null;
    };

    const getText = (elem) => {
        let text = '';

        const titleSpan = $(elem).find('span[role="text"], span[class*="title"], span[class*="Title"], div[class*="title"], div[class*="Title"]').first();
        if (titleSpan.length && isMeaningful(titleSpan.text().trim())) text = titleSpan.text().trim();

        if (!text) {
            const aria = ($(elem).attr('aria-label') || '').trim().replace(/\s+\d+\s+(second|minute|hour|day|week|month|year)s?\s*$/i, '').trim();
            if (isMeaningful(aria)) text = aria;
        }
        if (!text) { const t = ($(elem).attr('title') || '').trim(); if (isMeaningful(t)) text = t; }

        if (!text) {
            const $clone = $(elem).clone();
            $clone.find('time, .timestamp, .date, .duration, .metadata, sup').remove();
            const direct = $clone.text().trim();
            if (isMeaningful(direct)) text = direct;
        }
        if (!text) {
            let longest = '';
            $(elem).find('*').each((_, child) => {
                const t = $(child).clone().children().remove().end().text().trim();
                if (isMeaningful(t) && t.length > longest.length) longest = t;
            });
            if (longest) text = longest;
        }

        text = text.replace(/\s*\[[a-z0-9\-]+\]\s*/gi, '').replace(/^["']|["']$/g, '').trim();
        if (text.length > MAX_LINK_TEXT) text = text.slice(0, MAX_LINK_TEXT).trimEnd() + '…';
        return text;
    };

    const allLinks = [];
    const seenUrls = new Set();

    const addLink = (elem, url) => {
        if (seenUrls.has(url)) return;
        seenUrls.add(url);
        let text = getText(elem);
        if (!text) {
            try { text = `Content from ${new URL(url).hostname}`; } catch { text = 'Link'; }
        }
        allLinks.push({ url, text });
    };

    // Pass 1: All <a> elements (standard + data-href variants)
    let droppedNoHref = 0, droppedHash = 0, droppedDupe = 0;
    $('a').each((_, elem) => {
        const raw = getHref(elem);
        if (!raw) { droppedNoHref++; return; }
        if (raw === '#' || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) {
            droppedHash++;
            return;
        }
        const url = resolveHref(raw);
        if (!url) { droppedNoHref++; return; }
        const before = seenUrls.size;
        addLink(elem, url);
        if (seenUrls.size === before) droppedDupe++;
    });
    console.log(`[EXTRACT] <a> pass: kept ${allLinks.length}, dropped hash/js=${droppedHash} no-href=${droppedNoHref} dupe=${droppedDupe}`);

    // Pass 2: Non-anchor elements with explicit URL attributes.
    // Covers role="link", data-href/url/link/path — patterns used by React/Vue
    // product card components that render as <div> or <li> instead of <a>.
    // seenUrls deduplication handles any overlap with Pass 1 automatically.
    const nonAnchorSelector = '[role="link"], [data-href], [data-url], [data-link], [data-path]';
    $(nonAnchorSelector).not('a').each((_, elem) => {
        const url = resolveHref(getHref(elem));
        if (url) addLink(elem, url);
    });

    console.log(`[EXTRACT] ${allLinks.length} links (anchors + non-anchor elements)`);
    return allLinks;
}

// ── Main Scrape Handler ────────────────────────────────────────────────────
async function scrapeWebsite(req, res) {
    console.log('Starting scraper...');

    const params      = new URL(req.url, getBaseUrl(req)).searchParams;
    const rawUrl      = params.get('url') || 'https://en.wikipedia.org/wiki/Special:Random';
    const bypassCache = params.get('nocache') === 'true';
    const maxPages    = Math.max(1, Math.min(parseInt(params.get('pages') || '10', 10), 50));

    // ── Per-site URL rewrite ────────────────────────────────────────────────
    // Rewrite the pasted URL into the form that returns the best results for
    // this site (recency sort, larger page size, a server-rendered API
    // endpoint instead of a JS app, …). Falls back to the original on any
    // error. `hints` tunes how patient the browser engine is for this site.
    const { url, adapter, changed: urlRewritten } = rewriteUrl(rawUrl);
    const hints = getScrapeHints(url);
    if (adapter) console.log(`[ADAPTER] Matched "${adapter}"${urlRewritten ? ' (URL rewritten)' : ''}`);

    // ── Cache check ────────────────────────────────────────────────────────
    if (!bypassCache) {
        const hit = cacheGet(url);
        if (hit) {
            console.log('[CACHE HIT]', url);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                ...hit.data,
                cache: hit.data.cache ?? { newLinks: 0, totalSeen: seenLinks.size },
                cached: true, cachedAt: new Date(hit.cachedAt), expiresAt: new Date(hit.expiresAt)
            }));
        }
    }

    console.log(`Scraping: ${url}  maxPages: ${maxPages}`);

    try {
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT_ERROR')), 60000)
        );

        const doScrape = async () => {
            const _scrapeStart = Date.now();
            const _elapsed = () => `${((Date.now() - _scrapeStart) / 1000).toFixed(1)}s`;

            let refererUrl = null;
            try {
                const hostname = new URL(url).hostname;
                if (lastSuccessfulPage[hostname]) refererUrl = lastSuccessfulPage[hostname];
            } catch {}

            // ── Tier 1: browser loads ALL pages via DOM navigation ────────
            console.log(`[TIMING] Tier 1 scrapeMultiPage start`);
            // A single browser session handles both page-1 capture (for XHR
            // inspection) and full pagination.  This avoids a second browser
            // launch in the DOM fallback path.  XHR replay (Tier 2) then acts
            // as a bonus — it adds any API-only links on top of what DOM found.
            const { pages: firstPages, capturedRequests } = await scrapeMultiPage(url, {
                useProfile: true, retries: 2, maxPages, refererUrl, hints,
            });

            console.log(`[TIMING] Tier 1 done: ${_elapsed()}`);

            if (!firstPages[0]?.html || firstPages[0].html.length < 100)
                throw new Error('Received empty or invalid response');

            const allLinks  = [];
            const seenHrefs = new Set();
            let pageTitle   = '';
            let finalUrl    = url;
            const method    = 'puppeteer-multi';

            {
                const { html, finalUrl: pageUrl } = firstPages[0];
                finalUrl = pageUrl;
                const $meta     = cheerio.load(html);
                const canonical = $meta('link[rel="canonical"]').attr('href');
                const ogUrl     = $meta('meta[property="og:url"]').attr('content');
                if (canonical) { finalUrl = canonical; console.log('[META] Canonical:', finalUrl); }
                else if (ogUrl) { finalUrl = ogUrl;    console.log('[META] og:url:',   finalUrl); }

                const $h = cheerio.load(html);
                pageTitle = $h('h1').first().text() || $h('title').text() || '';
                if (!pageTitle.trim() || pageTitle.toLowerCase() === 'untitled') {
                    try { pageTitle = `Content from ${new URL(finalUrl).hostname}`; }
                    catch { pageTitle = 'Untitled'; }
                }

                console.log(`HTML: ${html.length} chars | XHR captured: ${capturedRequests.length}`);
                try { lastSuccessfulPage[new URL(finalUrl).hostname] = finalUrl; } catch {}

                const $ = cheerio.load(html);
                const page1Links = extractLinks($, pageUrl || finalUrl);
                console.log(`Page 1 HTML: ${page1Links.length} links`);
                for (const l of page1Links) {
                    if (!seenHrefs.has(l.url)) { seenHrefs.add(l.url); allLinks.push(l); }
                }
            }

            let domPagesScraped = 1;
            const xhrPagesScraped = [];

            if (maxPages <= 1) {
                return { allLinks, pageTitle, finalUrl, method, domPagesScraped, xhrPagesScraped };
            }

            // ── Tier 2: parallel XHR API replay ───────────────────────────
            // Fire all page requests simultaneously — ~300ms total vs ~3s/page.
            // Only applies when a replayable content request was captured AND
            // pages 2+ actually return new links. Falls through to DOM nav otherwise.
            const contentReq = hints.forceDom ? null : findContentRequest(capturedRequests, finalUrl);
            if (hints.forceDom) console.log('[XHR] Skipping API replay — adapter set forceDom');
            if (contentReq) {
                const page1XhrLinks = extractLinksFromJson(contentReq.responseJson, finalUrl);
                const fp1 = new Set(page1XhrLinks.map(l => {
                    try { return new URL(l.url).pathname; } catch { return l.url; }
                }));
                for (const l of page1XhrLinks) {
                    if (!seenHrefs.has(l.url)) { seenHrefs.add(l.url); allLinks.push(l); }
                }
                if (page1XhrLinks.length > 0) {
                    console.log(`[XHR] Page 1 API: ${page1XhrLinks.length} links — parallel-replaying pages 2-${maxPages}`);
                }

                const _tXHR = Date.now();
                const pageNums   = Array.from({ length: maxPages - 1 }, (_, i) => i + 2);
                const xhrResults = await Promise.all(
                    pageNums.map(async (pNum) => {
                        try {
                            const links = await replayXHRPage(contentReq, pNum, finalUrl);
                            return { pNum, links: links || [] };
                        } catch (e) {
                            return { pNum, links: [] };
                        }
                    })
                );
                console.log(`[TIMING] Tier 2 XHR parallel replay: ${Date.now() - _tXHR}ms (elapsed: ${_elapsed()})`);

                for (const { pNum, links } of xhrResults) {
                    if (!links.length) { console.log(`[XHR] Page ${pNum} empty — stopping`); break; }
                    const fpN     = new Set(links.map(l => { try { return new URL(l.url).pathname; } catch { return l.url; } }));
                    const overlap = [...fpN].filter(p => fp1.has(p)).length;
                    if (fpN.size > 0 && overlap / fpN.size > 0.8) { console.log(`[XHR] Page ${pNum} duplicate — stopping`); break; }
                    let added = 0;
                    for (const l of links) {
                        if (!seenHrefs.has(l.url)) { seenHrefs.add(l.url); allLinks.push(l); added++; }
                    }
                    xhrPagesScraped.push({ page: pNum, links: added });
                    console.log(`[XHR] Page ${pNum}: +${added} new links`);
                }

                // Only exit here if pages 2+ actually produced links.
                // If xhrPagesScraped is empty (pagination not detected or all pages
                // were duplicates/empty), fall through to use the DOM pages already
                // captured in Tier 1 — no second browser launch needed.
                if (xhrPagesScraped.length > 0) {
                    console.log(`[XHR] Parallel replay done — ${xhrPagesScraped.length + 1} API pages`);
                    return { allLinks, pageTitle, finalUrl, method, domPagesScraped, xhrPagesScraped };
                }
                console.log('[XHR] No pages 2+ from API replay — using DOM pages from Tier 1');
            }

            // ── Tier 3: DOM pages already captured in Tier 1 ──────────────
            // firstPages contains every page the browser navigated, so we just
            // extract links from pages 2-N here — no second browser launch.
            console.log(`[DOM] Extracting from ${firstPages.length} DOM page(s) captured in Tier 1`);
            // Page 1 already extracted above — start from index 1
            for (let i = 1; i < firstPages.length; i++) {
                const { html, finalUrl: pageUrl } = firstPages[i];
                const $ = cheerio.load(html);
                const pageLinks = extractLinks($, pageUrl || finalUrl);
                console.log(`[DOM] Page ${i + 1}: ${pageLinks.length} links`);
                for (const l of pageLinks) {
                    if (!seenHrefs.has(l.url)) { seenHrefs.add(l.url); allLinks.push(l); }
                }
            }
            domPagesScraped = firstPages.length;
            console.log(`[TIMING] doScrape total: ${_elapsed()}`);
            return { allLinks, pageTitle, finalUrl, method, domPagesScraped, xhrPagesScraped };
        };

        const { allLinks, pageTitle, finalUrl, method, domPagesScraped, xhrPagesScraped }
            = await Promise.race([doScrape(), timeoutPromise]);

        console.log(`Total links collected: ${allLinks.length}`);

        // Per-site link transform (e.g. unwrap DuckDuckGo redirect links to
        // their real destinations). Runs before dedup so unwrapped duplicates
        // collapse; a null result drops the link.
        const transformLink = getLinkTransformer(url);
        let workingLinks = allLinks;
        if (transformLink) {
            const before = workingLinks.length;
            workingLinks = workingLinks
                .map(l => { const t = transformLink(l.url); return t ? { ...l, url: t } : null; })
                .filter(Boolean);
            console.log(`[ADAPTER] Link transform: ${before} → ${workingLinks.length} (unwrapped/filtered)`);
        }

        let externalLinks = deduplicateLinks(workingLinks);

        const beforeFilter = externalLinks.length;
        externalLinks = filterUnwantedLinks(externalLinks);
        const resourcesFiltered = beforeFilter - externalLinks.length;
        console.log(`After filter: ${externalLinks.length} (removed ${resourcesFiltered})`);

        const categories = categorizeLinks(externalLinks);

        const trulyNewLinks = filterToNewLinks(externalLinks);
        const newUrlSet     = new Set(trulyNewLinks.map(l => l.url));
        externalLinks       = externalLinks.map(link => ({ ...link, isNew: newUrlSet.has(link.url) }));
        const addedCount    = markLinksSeen(externalLinks);
        console.log(`[SEEN] +${addedCount} new (${seenLinks.size} total)`);

        const responseData = {
            title: pageTitle, sourceUrl: finalUrl, externalLinks, categories,
            stats: {
                external: externalLinks.length, categories: categories.length,
                duplicatesRemoved: workingLinks.length - beforeFilter, resourcesFiltered,
                newLinks: trulyNewLinks.length, unchangedLinks: externalLinks.length - trulyNewLinks.length,
                domPages: domPagesScraped,
                ...(xhrPagesScraped.length > 0 && { xhrPages: xhrPagesScraped.length }),
            },
            cache: { newLinks: trulyNewLinks.length, totalSeen: seenLinks.size },
            method, timestamp: new Date(),
            // Tells the UI which site adapter fired and whether the pasted URL
            // was rewritten to a better-results form before scraping.
            adapter: adapter ? { name: adapter, urlRewritten, requestedUrl: rawUrl, scrapedUrl: url } : null
        };

        cacheSet(finalUrl, responseData);
        if (finalUrl !== url) cacheSet(url, responseData);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));

    } catch (error) {
        console.error('Scrape error:', error.message);

        if (error.message === 'TIMEOUT_ERROR') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                error: 'Scraping timeout: site took longer than 60s. May have strong anti-bot protection or require authentication.'
            }));
        }
        if (error.message.startsWith('HARD_BLOCK:')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                error: '🛡️ Server-level bot detection (TLS fingerprinting or IP reputation). Other pages on this domain may still work.',
                hardBlock: true
            }));
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}