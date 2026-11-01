// ============================================================
// SITE ADAPTERS — site_adapters.js
// ------------------------------------------------------------
// A generic, data-driven registry that lets the scraper behave
// differently per site WITHOUT hardcoding anything into the core
// engine. Two jobs:
//
//   1. rewriteUrl(url)     — rewrite a pasted URL into the form that
//                            returns the best / most complete results
//                            for that site (add sort=recent, force a
//                            large page size, swap a JS page for its
//                            server-rendered API endpoint, etc.).
//
//   2. getScrapeHints(url) — per-site knobs that make the browser
//                            engine more patient / thorough on sites
//                            that lazy-load content with JavaScript.
//
// NOTHING here is specific to "jobs". The seed entries below happen to
// be common search sites, but the mechanism is fully general: to teach
// the scraper a new site, add one entry to the ADAPTERS array. See the
// big comment above the array for the entry shape.
//
// ── DESIGN RULE (important) ──────────────────────────────────────────
// This file is the ONLY place site-specific hardcoding is allowed, and
// even here it must stay limited to "filtering standards" for a site:
//   • which query params mean sort / recency / page size / pagination
//   • which CSS selector marks real content (waitForSelector)
//   • how patient to be (scroll rounds, extra wait)
//   • necessary URL rewrites (JS page → server-rendered endpoint) and
//     link rewrites (unwrap a search engine's redirect links)
// General scraping LOGIC never goes here — that lives in the engine
// (antidetect.js) and stays site-agnostic. Keeping per-site knowledge
// declarative here is what lets the same engine handle any site.
// ============================================================

// ── Scrape hint defaults ─────────────────────────────────────────────
// Every field an adapter may override. Adapters supply only the ones
// that differ; getScrapeHints() fills the rest from here.
const DEFAULT_HINTS = {
    // CSS selector the engine waits to appear before it considers the
    // page "ready". Great for JS sites where <a> tags exist in a nav bar
    // long before the real results render. null = use generic detection.
    waitForSelector: null,

    // Extra milliseconds to sit still after the DOM settles. Use for
    // sites whose results trickle in after the first render burst.
    extraWaitMs: 0,

    // When true, repeatedly scroll to the bottom to trigger infinite
    // scroll / lazy-loaded result cards until the page stops growing.
    infiniteScroll: false,
    maxScrollRounds: 8,

    // Minimum number of <a> links that must be present before the page
    // is considered non-empty. Below this, the engine retries the
    // warm-navigation path. Raise it for content-heavy result pages.
    minLinks: 3,

    // Skip XHR/API replay and force DOM navigation. Use for sites whose
    // JSON APIs are auth-walled but whose HTML pages render fine.
    forceDom: false,

    // Allow images through (normally blocked for speed). A few sites
    // gate rendering on image load; set true only if results go missing.
    loadImages: false,

    // URL-param pagination. When pageParam is set, the engine paginates by
    // loading the SAME url with this query param incremented, instead of
    // hunting for a "next" button. Ideal for server-rendered result/API
    // endpoints that page via ?start=25 / ?page=2 / ?offset=50.
    //   pageParam — query param name to change (e.g. 'start', 'page')
    //   pageStep  — amount to add per page (e.g. 25 for offsets, 1 for pages)
    //   pageStart — value on page 1 (0 for offset-style, 1 for page-number)
    pageParam: null,
    pageStep: 25,
    pageStart: 0,
};

// ── Helpers shared by adapter rewrite() functions ────────────────────
// Set a query param only if it is missing, so we never clobber a value
// the user deliberately typed.
function setIfAbsent(u, key, value) {
    if (!u.searchParams.has(key)) u.searchParams.set(key, value);
}

// True when a URL's query string carries any of the given search keys —
// used to tell "a real search" apart from a bare landing/detail page, so
// we only inject sort/recency params where they make sense.
function hasAnyParam(u, keys) {
    return keys.some(k => u.searchParams.has(k) && u.searchParams.get(k).trim() !== '');
}

// ============================================================
// ADAPTER ENTRIES
// ------------------------------------------------------------
// Each adapter is:
//   {
//     name:  'human-readable id' (for logs),
//     test:  (hostname, url) => boolean   — does this adapter apply?
//     rewrite?: (URL) => URL | string | null
//                 Mutate/replace the URL for best results. Return the
//                 URL object (mutated), a new URL string, or null/the
//                 same object to leave it unchanged. Wrap risky logic in
//                 try/catch — a throw is caught and the original is used.
//     hints?: { ...partial DEFAULT_HINTS }  — per-site engine knobs.
//   }
//
// Order matters: the FIRST adapter whose test() passes wins. Put more
// specific hosts before broader ones.
// ============================================================
const ADAPTERS = [
    // ── LinkedIn ─────────────────────────────────────────────────────
    // The public /jobs/search page is a heavy JS app that fights bots.
    // LinkedIn also exposes a guest endpoint that returns the SAME
    // results as a plain server-rendered HTML list — no login, no JS,
    // trivially scrapeable and paginated via ?start=N. We rewrite search
    // URLs to that endpoint; individual /jobs/view/<id> pages are left
    // alone so they still resolve normally.
    {
        name: 'linkedin-jobs',
        test: (h, url) => /(^|\.)linkedin\.com$/.test(h) && /\/jobs\//.test(new URL(url).pathname),
        rewrite: (u) => {
            const path = u.pathname;
            // Only rewrite search result pages, not a single posting.
            if (!/\/jobs\/(search|search-results)/.test(path)) return u;

            const api = new URL('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
            // Carry over EVERY filter the user set, so a hand-tuned search keeps
            // all of it — experience (f_E), job type (f_JT), title/function
            // (f_T), distance, date-posted (f_TPR), work-type (f_WT), geoId,
            // sortBy, etc. The guest endpoint reads the same filter params as
            // the logged-in page and simply ignores ones it doesn't know.
            const UI_ONLY = new Set(['currentjobid', 'origin', 'refresh', 'position', 'pagenum', 'trk']);
            for (const [k, v] of u.searchParams) {
                if (UI_ONLY.has(k.toLowerCase())) continue;   // pure UI state, not a filter
                api.searchParams.set(k, v);
            }
            // Normalize the two params whose names differ from the guest form.
            if (!api.searchParams.has('keywords') && u.searchParams.has('q')) api.searchParams.set('keywords', u.searchParams.get('q'));
            if (!api.searchParams.has('location') && u.searchParams.has('l')) api.searchParams.set('location', u.searchParams.get('l'));
            // Newest first ONLY if the user didn't already pick a sort (keeps their sortBy=R).
            setIfAbsent(api, 'sortBy', 'DD');   // DD = date descending
            api.searchParams.set('start', '0');
            return api;
        },
        // Guest endpoint returns ~25 cards per call and pages via ?start=N.
        hints: { minLinks: 5, extraWaitMs: 400, pageParam: 'start', pageStep: 25, pageStart: 0 },
    },

    // ── Indeed ───────────────────────────────────────────────────────
    // Server-rendered enough to scrape, but defaults to "relevance" and
    // shows stale postings. Force recency + date sort on real searches.
    {
        name: 'indeed',
        test: (h) => /(^|\.)indeed\.[a-z.]+$/.test(h),
        rewrite: (u) => {
            if (!/\/jobs/.test(u.pathname)) return u;
            if (hasAnyParam(u, ['q', 'l'])) {
                setIfAbsent(u, 'sort', 'date');   // newest first
                setIfAbsent(u, 'fromage', '7');   // posted within 7 days
            }
            return u;
        },
        hints: { minLinks: 5, extraWaitMs: 500, infiniteScroll: true },
    },

    // ── ZipRecruiter ─────────────────────────────────────────────────
    // JS-heavy result grid. Force recency and give it room to render.
    {
        name: 'ziprecruiter',
        test: (h) => /(^|\.)ziprecruiter\.com$/.test(h),
        rewrite: (u) => {
            if (!/\/jobs-search|\/candidate\/search|\/jobs\//.test(u.pathname)) return u;
            if (hasAnyParam(u, ['search', 'q'])) {
                setIfAbsent(u, 'days', '7');   // posted within the last 7 days
            }
            return u;
        },
        hints: { minLinks: 5, extraWaitMs: 800, infiniteScroll: true },
    },

    // ── Glassdoor ────────────────────────────────────────────────────
    // Aggressive bot detection and a fully JS-rendered grid. We can't do
    // much to the URL safely, but we can make the engine far more patient
    // and let it scroll for lazy-loaded cards.
    {
        name: 'glassdoor',
        test: (h) => /(^|\.)glassdoor\.[a-z.]+$/.test(h),
        hints: { minLinks: 5, extraWaitMs: 1200, infiniteScroll: true, maxScrollRounds: 10 },
    },

    // ── Greenhouse (ATS boards) ──────────────────────────────────────
    // boards.greenhouse.io/<company> is server-rendered HTML — already
    // easy. Just make sure the engine waits for the opening list.
    {
        name: 'greenhouse',
        test: (h) => /(^|\.)greenhouse\.io$/.test(h),
        hints: { waitForSelector: 'a[href*="/jobs/"], .opening a', minLinks: 3 },
    },

    // ── Lever (ATS boards) ───────────────────────────────────────────
    // jobs.lever.co/<company> — server-rendered posting list.
    {
        name: 'lever',
        test: (h) => /(^|\.)lever\.co$/.test(h),
        hints: { waitForSelector: 'a.posting-title, a[href*="/jobs/"]', minLinks: 3 },
    },

    // ── Workday ──────────────────────────────────────────────────────
    // <company>.<dc>.myworkdayjobs.com — a React SPA that boots at its
    // origin before firing the results POST. The engine's shell/warm-nav
    // path handles this; we just give it more patience and rely on XHR
    // replay (the JSON API paginates via offset params) for later pages.
    {
        name: 'workday',
        test: (h) => /myworkdayjobs\.com$/.test(h),
        hints: { minLinks: 5, extraWaitMs: 1500, waitForSelector: '[data-automation-id="jobTitle"], a[data-automation-id]' },
    },

    // ══ SHOPPING / GROCERY ═══════════════════════════════════════════
    // The same idea as the job sites: on search pages, ask for more items
    // per page + page through results, and give JS-heavy grids the extra
    // patience they need. Product links (/dp/, /ip/, /itm/, /p/) are plain
    // anchors, so the core extractor already picks them up.

    // ── eBay ─────────────────────────────────────────────────────────
    // Server-rendered search — the easiest win here. Bump items-per-page
    // to 240 and paginate via ?_pgn=N (page numbers start at 1).
    {
        name: 'ebay',
        test: (h) => /(^|\.)ebay\.[a-z.]+$/.test(h),
        rewrite: (u) => {
            if (!/\/sch\//.test(u.pathname)) return u;
            if (hasAnyParam(u, ['_nkw'])) {
                setIfAbsent(u, '_ipg', '240');   // 240 items per page
            }
            return u;
        },
        hints: { minLinks: 5, pageParam: '_pgn', pageStep: 1, pageStart: 1 },
    },

    // ── Amazon ───────────────────────────────────────────────────────
    // Heavy JS grid with strong bot detection. On /s search pages, page
    // through via &page=N; scroll for lazily-rendered results.
    {
        name: 'amazon',
        test: (h) => /(^|\.)amazon\.[a-z.]+$/.test(h),
        rewrite: (u) => u,   // Amazon's /s?k= form is already optimal
        hints: {
            minLinks: 5, extraWaitMs: 800, infiniteScroll: true,
            pageParam: 'page', pageStep: 1, pageStart: 1,
            waitForSelector: '[data-component-type="s-search-result"], a.a-link-normal',
        },
    },

    // ── Walmart ──────────────────────────────────────────────────────
    // SPA search grid; paginates via &page=N. Product links are /ip/....
    {
        name: 'walmart',
        test: (h) => /(^|\.)walmart\.[a-z.]+$/.test(h),
        hints: {
            minLinks: 5, extraWaitMs: 1000, infiniteScroll: true,
            pageParam: 'page', pageStep: 1, pageStart: 1,
            waitForSelector: 'a[link-identifier], a[href*="/ip/"]',
        },
    },

    // ── Target ───────────────────────────────────────────────────────
    // Fully JS-rendered grid; results load after the shell. Be patient
    // and scroll. Product links are /p/....
    {
        name: 'target',
        test: (h) => /(^|\.)target\.com$/.test(h),
        hints: {
            minLinks: 5, extraWaitMs: 1500, infiniteScroll: true,
            waitForSelector: 'a[href*="/p/"]',
        },
    },

    // ── Costco ───────────────────────────────────────────────────────
    // JS-rendered product grid on category pages (e.g. /laptops.html).
    // Product links contain ".product." — wait for the first tile before
    // settling, and scroll for the lazily-rendered ones. NOTE: Costco uses
    // Akamai bot protection; if it blocks by IP, set USE_PROXY (residential).
    {
        name: 'costco',
        test: (h) => /(^|\.)costco\.[a-z.]+$/.test(h),
        hints: {
            minLinks: 5, extraWaitMs: 1500, infiniteScroll: true, maxScrollRounds: 8,
            loadImages: true,
            waitForSelector: 'a[href*=".product."], .product-tile, [automation-id*="productList"]',
        },
    },

    // ── Grocery delivery (Instacart, Kroger, Albertsons, Safeway, …) ──
    // Location- and often login-gated SPAs with aggressive bot detection.
    // We can't rewrite the URL usefully, so we give them the most patience
    // and let them scroll. NOTE: many require you to be signed in / have a
    // store+ZIP selected before products render — scraping a public
    // category URL works best, and a residential proxy (USE_PROXY) helps.
    {
        name: 'grocery-spa',
        test: (h) => /(^|\.)(instacart\.com|kroger\.com|albertsons\.com|safeway\.com|wholefoodsmarket\.com)$/.test(h),
        hints: {
            minLinks: 5, extraWaitMs: 1800, infiniteScroll: true,
            maxScrollRounds: 10, loadImages: true,
        },
    },

    // ── DuckDuckGo (scrape-friendly web search) ──────────────────────
    // Google blocks automated browsers; DuckDuckGo's server-rendered HTML
    // endpoint does not, which makes it the reliable way to run `site:`
    // queries (e.g. site:job-boards.greenhouse.io "product manager").
    //
    // Two jobs:
    //   rewrite       — send any DDG search to the plain-HTML endpoint.
    //   transformLink — every result link is wrapped in a DDG redirect
    //                   (duckduckgo.com/l/?uddg=<real url>); unwrap it back
    //                   to the true destination, and drop DDG's own chrome.
    {
        name: 'duckduckgo',
        test: (h) => /(^|\.)duckduckgo\.com$/.test(h),
        rewrite: (u) => {
            const q = u.searchParams.get('q');
            if (!q) return u;
            const api = new URL('https://html.duckduckgo.com/html/');
            api.searchParams.set('q', q);
            for (const p of ['kl', 'df']) {   // region / date filters, if set
                if (u.searchParams.has(p)) api.searchParams.set(p, u.searchParams.get(p));
            }
            return api;
        },
        // Unwrap redirects → real URLs; return null to discard a link.
        transformLink: (link) => {
            try {
                const u = new URL(link);
                if (/(^|\.)duckduckgo\.com$/.test(u.hostname)) {
                    if (u.pathname === '/l/' && u.searchParams.get('uddg')) {
                        return decodeURIComponent(u.searchParams.get('uddg'));
                    }
                    return null;   // DDG's own nav / assets — not a result
                }
            } catch {}
            return link;
        },
        hints: { minLinks: 5, extraWaitMs: 300 },
    },

    // ── Google (search, plus Shopping via ?tbm=shop) ─────────────────
    // Ask for more results per page, and unwrap result links. Google often
    // serves results as either direct hrefs or /url?q=<real>&… redirects,
    // and surrounds them with its own nav/settings links — transformLink
    // returns the real destination and drops Google's own chrome.
    //
    // REALITY: Google aggressively blocks automated browsers (consent walls,
    // CAPTCHAs), so this works best from a residential IP and is far less
    // reliable than the DuckDuckGo adapter above. Prefer DDG for `site:`
    // queries; this is here for when you specifically want Google.
    {
        name: 'google-search',
        test: (h) => /(^|\.)google\.[a-z.]+$/.test(h),
        rewrite: (u) => {
            if (u.pathname === '/search' && u.searchParams.has('q')) {
                setIfAbsent(u, 'num', '50');   // more results per page
            }
            return u;
        },
        transformLink: (link) => {
            try {
                const u = new URL(link);
                if (/(^|\.)google\.[a-z.]+$/.test(u.hostname)) {
                    // /url?q=<real> (classic) or /url?url=<real>
                    const real = u.searchParams.get('q') || u.searchParams.get('url');
                    if (u.pathname === '/url' && real && /^https?:/.test(real)) return real;
                    return null;   // Google nav / settings / cache links
                }
            } catch {}
            return link;   // already a direct external result
        },
        hints: { minLinks: 8, extraWaitMs: 400 },
    },
];

// ── Public API ───────────────────────────────────────────────────────
function getAdapter(url) {
    let hostname;
    try { hostname = new URL(url).hostname.toLowerCase(); }
    catch { return null; }
    for (const a of ADAPTERS) {
        try { if (a.test(hostname, url)) return a; } catch {}
    }
    return null;
}

// Rewrite a URL into its best-results form. Always returns a usable
// string — on any error it falls back to the original URL untouched.
// Returns { url, adapter, changed }.
function rewriteUrl(url) {
    const adapter = getAdapter(url);
    if (!adapter || typeof adapter.rewrite !== 'function') {
        return { url, adapter: adapter ? adapter.name : null, changed: false };
    }
    try {
        const u = new URL(url);
        const out = adapter.rewrite(u);
        const rewritten = out == null ? url
            : (typeof out === 'string' ? out : out.toString());
        const changed = rewritten !== url;
        if (changed) console.log(`[ADAPTER] ${adapter.name}: rewrote URL\n           ${url}\n        →  ${rewritten}`);
        return { url: rewritten, adapter: adapter.name, changed };
    } catch (e) {
        console.log(`[ADAPTER] ${adapter.name}: rewrite failed (${e.message}) — using original URL`);
        return { url, adapter: adapter.name, changed: false };
    }
}

// Query params that signal "this is a search / listing page" on sites we
// don't have a specific adapter for. Used to auto-enable scroll patience.
const SEARCH_PARAMS = [
    'q', 'query', 'search', 'searchterm', 'keyword', 'keywords',
    'k', 'term', 's', '_nkw', 'text', 'find',
];

// For unknown sites, guess sensible hints from the URL shape so the scraper
// still does the right thing on grocery/shopping/listing pages it has never
// seen. Conservative: only turns on extra scrolling when the URL actually
// looks like a search, so plain article/detail pages stay fast.
function inferHints(url) {
    try {
        const u = new URL(url);
        const looksLikeSearch =
            SEARCH_PARAMS.some(k => u.searchParams.has(k) && u.searchParams.get(k).trim() !== '') ||
            /\/(search|s|sch|shop|browse|catalog|category|categories|products?|listings?|results)(\/|$)/i.test(u.pathname);
        if (looksLikeSearch) {
            return { infiniteScroll: true, maxScrollRounds: 5, extraWaitMs: 600, minLinks: 5 };
        }
    } catch {}
    return {};
}

// Merge an adapter's hints over the defaults. Always returns a complete
// hints object, so callers can read every field without guarding. When no
// adapter matches, URL-shape inference fills in reasonable defaults.
function getScrapeHints(url) {
    const adapter = getAdapter(url);
    const base = adapter && adapter.hints ? adapter.hints : inferHints(url);
    const merged = { ...DEFAULT_HINTS, ...base };
    merged._adapter = adapter ? adapter.name : (Object.keys(base).length ? 'inferred-search' : null);
    return merged;
}

// Return the matched adapter's per-link transformer, or null. The scraper
// runs it over every extracted link: a returned string replaces the URL
// (e.g. unwrap a search-engine redirect to its real destination), and null
// drops the link entirely. Errors fall back to keeping the link unchanged.
function getLinkTransformer(url) {
    const adapter = getAdapter(url);
    if (adapter && typeof adapter.transformLink === 'function') {
        return (link) => {
            try {
                const out = adapter.transformLink(link);
                return out === undefined ? link : out;   // undefined = leave as-is
            } catch { return link; }
        };
    }
    return null;
}

module.exports = {
    rewriteUrl,
    getScrapeHints,
    getLinkTransformer,
    getAdapter,
    DEFAULT_HINTS,
    ADAPTERS,
};
