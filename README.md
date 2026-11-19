# AdScoop – Meta Ads Intelligence & Extractor

A Manifest V3 Chrome extension (vanilla JS, no frameworks, no paid APIs) that reads the ads you can
already see in the **Meta Ads Library**, analyses the copy locally, and exports everything to CSV.

- Extracts: Ad ID, advertiser, Page ID, original Ad Library link, platforms, status, start/end date,
  primary text (incl. "See more" expansion), headline, description, CTA, landing URL, media type,
  image/video URLs, variations, search keyword, country, extraction time.
- Analyses (locally, rule-based, **no network**): hook + category + strength score, selling proposition,
  benefits, pain points, emotional triggers, persuasive techniques, offer/discount, urgency/scarcity,
  marketing angle, inferred audience, awareness stage, TOFU/MOFU/BOFU, likely objective, CTA strategy, USP.
- Optional: on-device **OCR** of creative images (bundled Tesseract.js, English + Hindi, works offline),
  optional **AI analysis** and optional **video transcription** with *your own* API key.
- Dashboard: card grid, search, filters (advertiser / platform / media type), sorting, multi-select,
  delete, detail drawer, export selected.
- Storage: `chrome.storage.local` (persists after Chrome closes). Duplicates are prevented by Ad ID;
  re-extracting merges into the existing record.

## Install (Developer Mode → Load unpacked)

1. Unzip the download so you have a folder named `adscoop` containing `manifest.json`.
2. Open `chrome://extensions` in Chrome (or Edge/Brave).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the `adscoop` folder (the one with `manifest.json` directly inside).
5. Pin the AdScoop icon from the puzzle-piece menu.

## Use

1. Open <https://www.facebook.com/ads/library/> and search for a business, keyword or competitor.
2. Scroll a little so ads are visible, click the **AdScoop** icon.
3. Choose:
   - **Extract All Visible Ads** – every ad card currently on the page.
   - **Extract New Ads** – only ads not saved yet (use after you scroll / click Meta's *See more results*).
   - **Auto-scroll & extract** – scrolls for you (slowly, with a limit you choose) and extracts as ads load.
4. Open the **Dashboard** to review ads, then **Download CSV** (all / selected / analysis-only / raw-only).
5. Open the CSV in Excel or Google Sheets (UTF-8 with BOM, so ₹, emoji and Hindi display correctly).

Try it without Meta first: Dashboard → **Load sample data**. Sample rows are badged `SAMPLE` and can be
removed with one click; they never mix with real extractions silently.

## CSV details

RFC 4180 escaping, CRLF rows, UTF-8 + BOM, multiline copy preserved inside quoted cells, one ad per row.
Files are named like `Meta_Ads_Intelligence_2026-11-18.csv`, with `_Raw`, `_Analysis`, `_Selected` suffixes
where applicable. Columns are labelled so **extracted** data is never confused with **inferred/AI** analysis.

## Optional integrations (all off by default)

Settings page: Dashboard → Settings.

| Feature | What it needs | Notes |
|---|---|---|
| Local analysis | nothing | Default. Heuristics, clearly labelled as estimates. |
| AI analysis | Your API key (OpenAI-compatible or Anthropic) | Key is stored only in your browser's `chrome.storage.local`, never in the source. Ad text is sent to the provider you choose, only when you click. |
| Video transcription | Your key for a Whisper-style endpoint | Only when the video file URL is publicly fetchable. `blob:` videos (most Meta videos) can't be fetched; the ad is then marked *unavailable*, never "transcribed". Captions visible on the card are captured without any key. |
| OCR | nothing | Bundled; runs locally on the image. |

The extension asks for access to a provider's domain only at the moment you use that feature
(`optional_host_permissions`).

## Permissions (kept minimal)

`storage`, `unlimitedStorage` (large libraries), `downloads` (CSV), `activeTab`, `scripting`, and host access
only to `facebook.com/ads/library/*`. No browsing history, no cookies, no tabs list.

## Project layout

```
manifest.json  popup.html/css/js
background/service-worker.js     storage, badge, downloads, messaging
content/meta-extractor.js        card detection + field extraction
content/dom-observer.js          MutationObserver, lazy-load / scroll handling
content/content.js               extraction modes, progress, messaging
analysis/hook-analyzer.js        hook category/score
analysis/marketing-analyzer.js   copy + strategy analysis
analysis/creative-analyzer.js    OCR + transcription orchestration
analysis/ai-analyzer.js          optional external AI
export/csv-exporter.js           CSV build + download
utils/helpers.js storage.js deduplication.js
dashboard/                       research dashboard + settings
sample-data/sample-ads.json      test data for CSV/dashboard (never real ads)
vendor/tesseract/                bundled OCR (Apache-2.0)
```

## How extraction works (and its limits)

Meta's class names are obfuscated and change constantly, so AdScoop does not depend on them. It finds cards
by the visible **"Library ID: …"** label, grows to the largest ancestor containing exactly one ID, and assigns
fields by position (status/dates → advertiser → primary text → media → headline/description/CTA).

**Honest limits**
- Verified against a **local fixture that reproduces the Ad Library's card structure**, in a real Chromium with
  the extension loaded. It has **not** been run against the live facebook.com site (not reachable from the build
  environment). Meta changes its layout; if a field comes back empty on live pages, see Troubleshooting.
- Page ID is only present when the card links to the advertiser page. Landing URL is only the visible link.
- Most video `src`s are `blob:` URLs; these are not downloadable, and AdScoop says so instead of inventing a URL.
- Audience, angle, funnel stage and scores are **inferred estimates**, not Meta data.
- AdScoop does not log in, solve CAPTCHAs, call Meta's APIs, or bypass anything; it reads the page you are
  viewing. Auto-scroll is slow and capped. Please follow Meta's terms and rate limits.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Manifest file is missing" on load | You selected the wrong folder. Pick the one that directly contains `manifest.json`. |
| Popup says "Not on the Ad Library" | Open a `facebook.com/ads/library/` results page, then reload the tab once (needed after installing). |
| 0 ads detected | Wait for results to finish loading and scroll once; make sure you're on a *results* page, not the landing page. |
| Some fields empty | Open the ad's detail in the dashboard: the **Limitations** list says what wasn't visible. Re-extract after clicking *See more*. |
| Fewer ads than expected | Meta lazy-loads. Use Auto-scroll or scroll, then **Extract New Ads**. |
| CSV shows `â‚¹` in Excel | Use Data → From Text/CSV and choose UTF-8, or import into Google Sheets. |
| Extension stopped working after Chrome update | `chrome://extensions` → reload AdScoop; check **Errors**. |
| Selectors broke after a Meta redesign | Open an issue with a saved copy of one card's HTML; matching logic lives in `content/meta-extractor.js`. |

## Tests

Outside the extension folder (`adscoop-tests/`): 20 unit tests (CSV escaping, analysers, dedup, AI validation) and
33 end-to-end checks that load the unpacked extension in Chromium against the fixture page
(install, detection, extraction, duplicates, scrolling, popup, dashboard, CSV, OCR, persistence after relaunch).

```
cd adscoop-tests && npm install && node unit/core.test.js && node e2e/run.js
```
