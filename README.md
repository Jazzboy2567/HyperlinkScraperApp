# LinkWatch

A desktop app that schedules link scraping across multiple URLs, tracks new links, and displays results in a clean timeline view.

---

## Setup

### 1. Install Electron dependencies
```bash
cd linkwatch
npm install
```

### 2. Make sure your scraper server works
Your existing `server.js` + `antidetect.js` need their own dependencies installed:
```bash
cd /path/to/your/server/folder
npm install puppeteer-extra puppeteer-extra-plugin-stealth tough-cookie cheerio
```

### 3. Run the app
```bash
npm start
```

---

## First-time Setup

1. Go to **Settings** (gear icon, bottom of sidebar)
2. Set **server.js path** — click Browse and select your `server.js` file
3. Set **Port** (default 3000)
4. Save Settings
5. Click **SERVER OFF** in the top bar to start the server

---

## Adding a URL Source

1. Go to **URL Sources** (globe icon)
2. Click **+ Add URL**
3. Fill in:
   - **Nickname** — optional, e.g. "LinkedIn New Grad"
   - **URL** — the page to scrape
   - **Schedule** — interval in minutes (min 5), start hour, end hour (local time)
   - **Title Filters** — optional keywords to filter link titles (case-insensitive, partial match). Leave empty to collect all links.
4. Use **Run Test** to preview results without affecting memory
5. Click **Save Changes**, then enable the toggle to activate the schedule

---

## Results View

- **Daily** — today's results
- **Weekly** — past 7 days grouped by day
- **Monthly** — past 30 days grouped by day
- **By Date** — all URLs sorted by time
- **By Source** — each URL's results grouped separately
- **↑/↓** — newest first or oldest first
- Use the filter bar to dynamically search displayed links (no impact on data)
- Toggle URL checkboxes to show/hide specific sources

---

## Archive

All-time history of every run. Same filter and URL toggle controls. Use **Clear All History** to wipe results (does not affect seen-links memory).

---

## Seen Links / Memory

- Every found link is stored in `userData/seen_links.json`
- On subsequent runs, already-seen links are skipped
- Go to **Settings → Wipe History** to reset (requires confirmation)
- A test run does NOT affect seen-links memory unless you toggle "Affect seen-links memory" in the test area

---

## Data Location

All data is stored in your OS **userData** folder (shown in Settings):
- `config.json` — app config and URL sources
- `results.json` — all collected results with titles, URLs, timestamps
- `seen_links.json` — deduplication memory

---

## Scheduling Logic

- The app uses your **system timezone** for scheduling
- If the app is closed during a scheduled window, missed runs are skipped
- When you open the app, if you're inside a scheduled window, the most recent interval runs immediately
- Minimum interval: **5 minutes**

---

## Building a distributable

```bash
npm run build:mac   # .dmg
npm run build:win   # .exe installer
npm run build:linux # .AppImage
```
