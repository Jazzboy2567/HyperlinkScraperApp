const http = require('http');
const fs = require('fs');
const cheerio = require('cheerio');

const {
    scrapeEnhanced,
    getCookieStats,
    clearCookiesForDomain,
    clearAllCookies,
    clearProfileForDomain,
    getOrCreateProfile
} = require('./antidetect');

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
    cache[key] = {
        data,
        cachedAt: Date.now(),
        expiresAt: Date.now() + CACHE_TTL_MS
    };
}

function cacheGet(key) {
    const entry = cache[key];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        delete cache[key];
        return null;
    }
    return entry;
}

// ── Last successful non-listing page per hostname ─────────────────────────
// Used as the pre-visit referer for listing pages, since category pages
// contain listing links and can be clicked from — unlike search pages.
const lastSuccessfulPage = {};

// ── Permanent seen-links store ─────────────────────────────────────────────
const SEEN_LINKS_FILE = './seen_links.json';
let seenLinks = new Set();

try {
    const saved = JSON.parse(fs.readFileSync(SEEN_LINKS_FILE, 'utf8'));
    seenLinks = new Set(saved);
    console.log(`[SEEN] Loaded ${seenLinks.size} previously seen links`);
} catch (e) {
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
    } catch (e) {
        return url;
    }
}

function markLinksSeen(links) {
    let addedCount = 0;
    links.forEach(link => {
        const key = normalizeUrl(link.url);
        if (!seenLinks.has(key)) {
            seenLinks.add(key);
            addedCount++;
        }
    });
    if (addedCount > 0) saveSeenLinks();
    return addedCount;
}

function filterToNewLinks(links) {
    return links.filter(link => !seenLinks.has(normalizeUrl(link.url)));
}

const port = process.env.PORT || 3000;
const host = '0.0.0.0';

// ============================================
// PROXY CONFIGURATION
// ============================================
const PROXY_CONFIG = {
    enabled: process.env.USE_PROXY === 'true',
    url: process.env.PROXY_URL || null,
    auth: process.env.PROXY_AUTH || null,
    pool: process.env.PROXY_POOL ? process.env.PROXY_POOL.split(',').map(p => p.trim()) : [],
    currentIndex: 0
};

function getProxy() {
    if (!PROXY_CONFIG.enabled) return null;
    if (PROXY_CONFIG.url) {
        console.log('[PROXY] Using single proxy');
        return PROXY_CONFIG.url;
    }
    if (PROXY_CONFIG.pool.length > 0) {
        const proxy = PROXY_CONFIG.pool[PROXY_CONFIG.currentIndex];
        PROXY_CONFIG.currentIndex = (PROXY_CONFIG.currentIndex + 1) % PROXY_CONFIG.pool.length;
        console.log(`[PROXY] Using proxy ${PROXY_CONFIG.currentIndex}/${PROXY_CONFIG.pool.length}: ${proxy}`);
        return proxy;
    }
    console.log('[PROXY] Proxy enabled but no proxy URL or pool configured!');
    return null;
}

// ── Request Router ─────────────────────────────────────────────────────────
const server = http.createServer(function (req, res) {
    if (req.url === '/health' || req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }
    if (req.url.startsWith('/api/scrape')) {
        scrapeWebsite(req, res);
    } else if (req.url.startsWith('/api/cache')) {
        handleCache(req, res);
    } else if (req.url.startsWith('/api/analyze-content')) {
        analyzeContent(req, res);
    } else if (req.url.startsWith('/api/cookies')) {
        handleCookieManager(req, res);
    } else if (req.url.startsWith('/api/profiles')) {
        handleProfileManager(req, res);
    } else if (req.url === '/api/test') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            message: 'Scraper API is running!',
            endpoints: {
                scrape: '/api/scrape?url=YOUR_URL',
                analyze: '/api/analyze-content?url=YOUR_URL&keywords=keyword1,keyword2',
                cookies: '/api/cookies?action=list',
                profiles: '/api/profiles?action=list'
            }
        }));
    } else if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.readFile('index.html', function (error, data) {
            if (error) {
                res.writeHead(404);
                res.write('Error: File Not Found');
            } else {
                res.write(data);
            }
            res.end();
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

function getBaseUrl(req) {
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const hostname = req.headers.host;
    return `${protocol}://${hostname}`;
}

server.listen(port, host, function (error) {
    if (error) {
        console.log('Something went wrong', error);
    } else {
        console.log('Server is listening on ' + host + ':' + port);
        console.log('Environment: ' + (process.env.PORT ? 'Production (Render)' : 'Local Development'));
        if (!process.env.PORT) {
            console.log('Open http://localhost:' + port + ' in your browser');
        }
    }
});

// ── Cache Handler ──────────────────────────────────────────────────────────
function handleCache(req, res) {
    const urlParams = new URL(req.url, getBaseUrl(req));
    const action = urlParams.searchParams.get('action') || 'list';
    const lookupUrl = urlParams.searchParams.get('url');

    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (action === 'list') {
        const now = Date.now();
        const entries = Object.entries(cache).map(([key, entry]) => ({
            key,
            cachedAt: new Date(entry.cachedAt),
            expiresAt: new Date(entry.expiresAt),
            ttlRemainingSeconds: Math.max(0, Math.round((entry.expiresAt - now) / 1000)),
            linkCount: entry.data?.externalLinks?.length ?? 0
        }));
        return res.end(JSON.stringify({ count: entries.length, entries }));
    }

    if (!lookupUrl) {
        return res.end(JSON.stringify({ error: 'url param required for this action' }));
    }

    const key = lookupUrl;

    if (action === 'get') {
        const entry = cacheGet(key);
        if (!entry) return res.end(JSON.stringify({ hit: false, url: lookupUrl }));
        return res.end(JSON.stringify({
            hit: true,
            cachedAt: new Date(entry.cachedAt),
            expiresAt: new Date(entry.expiresAt),
            ...entry.data
        }));
    }

    if (action === 'delete') {
        const existed = !!cache[key];
        delete cache[key];
        return res.end(JSON.stringify({ deleted: existed, key }));
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
    const urlParams = new URL(req.url, getBaseUrl(req));
    const action = urlParams.searchParams.get('action') || 'list';
    const domain = urlParams.searchParams.get('domain');

    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (action === 'list') {
        return res.end(JSON.stringify(getCookieStats()));
    }
    if (action === 'clear' && domain) {
        const cleared = clearCookiesForDomain(domain);
        return res.end(JSON.stringify({ cleared, domain }));
    }
    if (action === 'clearAll') {
        clearAllCookies();
        return res.end(JSON.stringify({ cleared: true }));
    }

    res.end(JSON.stringify({ error: 'Unknown action. Valid: list, clear, clearAll' }));
}

// ── Profile Manager Handler ────────────────────────────────────────────────
function handleProfileManager(req, res) {
    const urlParams = new URL(req.url, getBaseUrl(req));
    const action = urlParams.searchParams.get('action') || 'list';
    const domain = urlParams.searchParams.get('domain');

    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (action === 'list') {
        try {
            const profiles = JSON.parse(fs.readFileSync('./browser_profiles.json', 'utf8'));
            return res.end(JSON.stringify(profiles));
        } catch {
            return res.end(JSON.stringify({}));
        }
    }
    if (action === 'reset' && domain) {
        const cleared = clearProfileForDomain(domain);
        return res.end(JSON.stringify({ cleared, domain }));
    }
    if (action === 'view' && domain) {
        const profile = getOrCreateProfile(domain);
        return res.end(JSON.stringify(profile));
    }

    res.end(JSON.stringify({ error: 'Unknown action. Valid: list, reset, view' }));
}

// ── Content Analysis ───────────────────────────────────────────────────────
function extractOpenGraphData($) {
    const ogData = {};
    $('meta[property^="og:"]').each((i, elem) => {
        const property = $(elem).attr('property');
        const content = $(elem).attr('content');
        if (property && content) ogData[property.replace('og:', '')] = content;
    });
    if (!ogData.title) ogData.title = $('meta[name="twitter:title"]').attr('content');
    if (!ogData.description) ogData.description = $('meta[name="twitter:description"]').attr('content');
    if (!ogData.image) ogData.image = $('meta[name="twitter:image"]').attr('content');
    if (!ogData.title) ogData.title = $('title').first().text() || $('h1').first().text();
    if (!ogData.description) ogData.description = $('meta[name="description"]').attr('content');
    return ogData;
}

async function analyzeContent(req, res) {
    const urlParams = new URL(req.url, getBaseUrl(req));
    const url = urlParams.searchParams.get('url');
    const keywordsParam = urlParams.searchParams.get('keywords');

    if (!url || !keywordsParam) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'URL and keywords required' }));
        return;
    }

    const userKeywords = keywordsParam.toLowerCase().split(',').map(s => s.trim());
    console.log('[ANALYZE] Analyzing content:', url);

    try {
        let refererUrl = null;
        try {
            const u = new URL(url);
            const hostname = u.hostname;
            const ref = u.searchParams.get('ref') || '';
            const isListing = u.pathname.startsWith('/listing/');
            if (isListing && lastSuccessfulPage[hostname]) {
                refererUrl = lastSuccessfulPage[hostname];
            } else if (ref) {
                const segment = ref.split(/[-_]/)[0];
                refererUrl = segment && segment !== 'search' ? `${u.origin}/${segment}` : null;
            }
        } catch {}

        const result = await scrapeEnhanced(url, {
            humanBehavior: false,
            useProfile: true,
            retries: 1,
            refererUrl
        });

        const $ = cheerio.load(result.html);
        const pageText = $('body').text().toLowerCase();
        const openGraph = extractOpenGraphData($);
        const matchedKeywords = userKeywords.filter(kw => pageText.includes(kw));

        console.log('[ANALYZE] Matched:', matchedKeywords.length, 'of', userKeywords.length, 'keywords');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            matchedKeywords,
            totalKeywords: userKeywords.length,
            matchCount: matchedKeywords.length,
            preview: {
                title: openGraph.title,
                description: openGraph.description,
                image: openGraph.image,
                url: openGraph.url || url
            }
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
    return links.filter(link => {
        if (seen.has(link.url)) return false;
        seen.add(link.url);
        return true;
    });
}

function filterUnwantedLinks(links) {
    const unwanted = ['.css', '.js', '.json', '.xml', '.woff', '.woff2', '.ttf', '.eot', '.svg', '.ico'];
    return links.filter(link => {
        try {
            const pathname = new URL(link.url).pathname.toLowerCase();
            return !unwanted.some(ext => pathname.endsWith(ext));
        } catch {
            return true;
        }
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
        } catch { /* skip invalid URLs */ }
    });

    const categories = [];
    const usedLinks = new Set();
    const allPatterns = [];

    for (const domain in domainGroups) {
        for (const pattern in domainGroups[domain]) {
            allPatterns.push({
                domain,
                pattern,
                depth: pattern.split('/').length,
                links: domainGroups[domain][pattern]
            });
        }
    }

    allPatterns.sort((a, b) => b.depth !== a.depth ? b.depth - a.depth : b.links.length - a.links.length);

    for (const patternGroup of allPatterns) {
        const availableLinks = patternGroup.links.filter(l => !usedLinks.has(l.index));
        if (availableLinks.length < 3) continue;

        const allPaths = availableLinks.map(l => l.pathParts);
        const commonParts = [];
        const maxLength = Math.min(...allPaths.map(p => p.length));

        for (let i = 0; i < maxLength; i++) {
            if (allPaths.every(path => path[i] === allPaths[0][i])) {
                commonParts.push(allPaths[0][i]);
            } else break;
        }

        const uniqueSubcats = [...new Set(availableLinks.map(link => {
            const varying = link.pathParts.slice(commonParts.length);
            return varying.join('/') || 'root';
        }))];

        if (uniqueSubcats.length > 1 || availableLinks.length >= 5) {
            categories.push({
                domain: patternGroup.domain,
                pattern: commonParts.join('/') || patternGroup.domain,
                commonPath: commonParts,
                count: availableLinks.length,
                links: availableLinks
            });
            availableLinks.forEach(l => usedLinks.add(l.index));
        }
    }

    return categories.sort((a, b) => b.count - a.count);
}

// ── Main Scrape Handler ────────────────────────────────────────────────────
async function scrapeWebsite(req, res) {
    console.log('Starting scraper...');

    const urlParams = new URL(req.url, getBaseUrl(req));
    const url = urlParams.searchParams.get('url') || 'https://en.wikipedia.org/wiki/Special:Random';
    const bypassCache = urlParams.searchParams.get('nocache') === 'true';

    // ── Cache check ────────────────────────────────────────────────────────
    const inputCacheKey = url;
    if (!bypassCache) {
        const hit = cacheGet(inputCacheKey);
        if (hit) {
            console.log('[CACHE HIT]', url);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ...hit.data,
                cache: hit.data.cache ?? { newLinks: 0, totalSeen: seenLinks.size },
                cached: true,
                cachedAt: new Date(hit.cachedAt),
                expiresAt: new Date(hit.expiresAt)
            }));
            return;
        }
    }

    console.log('Scraping URL:', url);

    try {
        // ── 60-second hard timeout ─────────────────────────────────────────
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT_ERROR')), 60000)
        );

        // ── Derive referer: use last known good page for this domain ───────
        let refererUrl = null;
        try {
            const u = new URL(url);
            const hostname = u.hostname;
            const ref = u.searchParams.get('ref') || '';
            const isListing = u.pathname.startsWith('/listing/');

            if (isListing && lastSuccessfulPage[hostname]) {
                refererUrl = lastSuccessfulPage[hostname];
            } else if (ref) {
                const segment = ref.split(/[-_]/)[0];
                refererUrl = segment && segment !== 'search' ? `${u.origin}/${segment}` : null;
            }
            if (refererUrl) console.log(`[REFERER] Pre-visit: ${refererUrl}`);
        } catch {}

        const scrapeLogic = () => scrapeEnhanced(url, {
            warmup: true,
            humanBehavior: true,
            useProfile: true,
            retries: 2,
            refererUrl
        });

        const result = await Promise.race([scrapeLogic(), timeoutPromise]);
        let { html, method, finalUrl = url } = result;

        // ── Resolve final URL from meta tags if not set by Puppeteer ──────
        if (finalUrl === url) {
            const $meta = cheerio.load(html);
            const canonical = $meta('link[rel="canonical"]').attr('href');
            const ogUrl = $meta('meta[property="og:url"]').attr('content');
            if (canonical) {
                finalUrl = canonical;
                console.log('[META] Canonical URL:', finalUrl);
            } else if (ogUrl) {
                finalUrl = ogUrl;
                console.log('[META] og:url:', finalUrl);
            }
        }

        if (!html || html.length < 100) {
            throw new Error('Received empty or invalid response');
        }

        console.log('HTML length:', html.length, '| method:', method);

        // ── Record this page as a good referer candidate for future scrapes ─
        try {
            const scraped = new URL(finalUrl);
            if (!scraped.pathname.startsWith('/listing/')) {
                lastSuccessfulPage[scraped.hostname] = finalUrl;
                console.log(`[REFERER] Recorded last page: ${finalUrl}`);
            }
        } catch {}

        const $ = cheerio.load(html);
        let pageTitle = $('h1').first().text() || $('title').text() || '';

        if (!pageTitle.trim() || pageTitle.toLowerCase() === 'untitled') {
            try {
                pageTitle = `Content from ${new URL(finalUrl).hostname}`;
            } catch {
                pageTitle = 'Untitled';
            }
        }

        console.log('Page title:', pageTitle);

        // ── Extract all links ──────────────────────────────────────────────
        const MAX_LINK_TEXT = 150; // hard cap — prevents grabbing entire comment bodies
        const allLinks = [];

        $('a').each((i, elem) => {
            const href = $(elem).attr('href');
            if (!href) return;

            let text = '';

            const isMeaningful = (str) => {
                if (!str || str.length === 0) return false;
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

            // 1. Prefer explicit title span
            const contentSpan = $(elem).find('span[role="text"], span[class*="title"], span[class*="Title"], div[class*="title"], div[class*="Title"]').first();
            if (contentSpan.length > 0 && isMeaningful(contentSpan.text().trim())) {
                text = contentSpan.text().trim();
            }
            // 2. aria-label
            if (!text) {
                const aria = ($(elem).attr('aria-label') || '').trim().replace(/\s+\d+\s+(second|minute|hour|day|week|month|year)s?\s*$/i, '').trim();
                if (isMeaningful(aria)) text = aria;
            }
            // 3. title attribute
            if (!text) {
                const title = ($(elem).attr('title') || '').trim();
                if (isMeaningful(title)) text = title;
            }
            // 4. Direct text (strip noise children)
            if (!text) {
                const $clone = $(elem).clone();
                $clone.find('time, .timestamp, .date, .duration, .metadata, sup').remove();
                const direct = $clone.text().trim();
                if (isMeaningful(direct)) text = direct;
            }
            // 5. Longest child text
            if (!text) {
                let longest = '';
                $(elem).find('*').each((_, child) => {
                    const t = $(child).clone().children().remove().end().text().trim();
                    if (isMeaningful(t) && t.length > longest.length) longest = t;
                });
                if (longest) text = longest;
            }

            text = text.replace(/\s*\[[a-z0-9\-]+\]\s*/gi, '').replace(/^["']|["']$/g, '').trim();

            // ── Hard cap: truncate runaway text from comment/post bodies ──
            if (text.length > MAX_LINK_TEXT) {
                text = text.slice(0, MAX_LINK_TEXT).trimEnd() + '…';
            }

            // Resolve to absolute URL
            let absoluteUrl;
            if (href.startsWith('http://') || href.startsWith('https://')) {
                absoluteUrl = href;
            } else if (href.startsWith('//')) {
                absoluteUrl = 'https:' + href;
            } else if (href.startsWith('/')) {
                try {
                    const base = new URL(finalUrl);
                    absoluteUrl = base.protocol + '//' + base.host + href;
                } catch { return; }
            } else {
                return;
            }

            if (!text) {
                try { text = `Content from ${new URL(absoluteUrl).hostname}`; }
                catch { text = 'Link'; }
            }

            allLinks.push({ url: absoluteUrl, text });
        });

        console.log('Total links (with dupes):', allLinks.length);

        let externalLinks = deduplicateLinks(allLinks);
        console.log('Unique links:', externalLinks.length);

        const beforeFilter = externalLinks.length;
        externalLinks = filterUnwantedLinks(externalLinks);
        const resourcesFiltered = beforeFilter - externalLinks.length;
        console.log('After resource filter:', externalLinks.length, '(removed', resourcesFiltered, ')');

        const categories = categorizeLinks(externalLinks);
        console.log('Categories:', categories.length);

        // ── New-link tracking ──────────────────────────────────────────────
        const trulyNewLinks = filterToNewLinks(externalLinks);
        const newUrlSet = new Set(trulyNewLinks.map(l => l.url));
        externalLinks = externalLinks.map(link => ({ ...link, isNew: newUrlSet.has(link.url) }));
        const addedCount = markLinksSeen(externalLinks);
        console.log(`[SEEN] +${addedCount} new (${seenLinks.size} total)`);

        const responseData = {
            title: pageTitle,
            sourceUrl: finalUrl,
            externalLinks,
            categories,
            stats: {
                external: externalLinks.length,
                categories: categories.length,
                duplicatesRemoved: allLinks.length - beforeFilter,
                resourcesFiltered,
                newLinks: trulyNewLinks.length,
                unchangedLinks: externalLinks.length - trulyNewLinks.length
            },
            cache: {
                newLinks: trulyNewLinks.length,
                totalSeen: seenLinks.size
            },
            method,
            timestamp: new Date()
        };

        cacheSet(`${finalUrl}`, responseData);
        if (finalUrl !== url) {
            console.log(`[CACHE] Storing by finalUrl (redirected from ${url} → ${finalUrl})`);
        } else {
            cacheSet(inputCacheKey, responseData);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));

     } catch (error) {
        console.error('Scrape error:', error.message);

        if (error.message === 'TIMEOUT_ERROR') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Scraping timeout: This website took longer than 60 seconds. The site may have very strong anti-bot protection or require authentication.'
            }));
        } else if (error.message.startsWith('HARD_BLOCK:')) {
            // Server-side TLS/IP block — no retry will help, surface a clear message
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: '🛡️ This page is protected by server-level bot detection (TLS fingerprinting or IP reputation check). Headless Chrome cannot bypass it. Other pages on this domain may still work fine.',
                hardBlock: true
            }));
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }
}