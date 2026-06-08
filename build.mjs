// =========================================================================
// build.mjs  —  runs on GitHub's servers (not in the browser).
//
// This replaces what the browser used to do in daily-brief.html:
//   fetch every source  →  parse  →  de-duplicate  →  sort newest-first.
//
// Two big differences from the old browser version:
//   1. NO PROXIES. A server has no CORS restriction, so Node's built-in
//      fetch() can read feeds directly. The whole PROXIES / fetchViaProxy
//      block is gone.
//   2. NO DOMParser. Node has no DOMParser, so we use the 'rss-parser'
//      library to turn feed XML into plain JS objects.
//
// Output: data.json  — the file the page reads instead of fetching live.
// =========================================================================

import { readFile, writeFile } from "node:fs/promises";
import Parser from "rss-parser";

// rss-parser turns feed XML (RSS 2.0 or Atom) into plain JS objects. We add a
// custom field so we can read the <source> element Google News puts on items.
const parser = new Parser({ customFields: { item: [["source", "source"]] } });

// How long any single feed request may take before we give up on it, and how
// many feeds we fetch at the same time. CONCURRENCY matters because Google News
// throttles a machine that fires dozens of requests at once (which is what made
// the build hang). Fetching a handful at a time stays polite and reliable, no
// matter how many competitors you add.
const TIMEOUT_MS = 15000;
const CONCURRENCY = 5;

// Fetch a URL as text with a HARD timeout. Unlike rss-parser's own timeout, an
// AbortController guarantees the request is cancelled, so one slow/hung feed can
// never stall the whole build. We then hand the text to parser.parseString().
async function fetchFeed(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "DailyBrief/1.0 (+github actions)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parser.parseString(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

// Run async tasks a few at a time (not all at once). Returns one result per
// item, in order; failures are returned as { error } rather than thrown.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { error: err };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

// -------------------------------------------------------------------------
// 1. BUILD FEED URLS  (one per source type).
// -------------------------------------------------------------------------
function googleNewsUrl(query) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}
function arxivUrl(cats, max) {
  // Use arXiv's query API (Atom) rather than the rss.arxiv.org feed. The RSS
  // feed only lists papers ANNOUNCED that day and is empty on weekends / off
  // hours; the query API always returns the latest papers, sorted by date.
  const q = (cats || []).map((c) => `cat:${c}`).join("+OR+");
  return (
    `https://export.arxiv.org/api/query?search_query=${q}` +
    `&sortBy=submittedDate&sortOrder=descending&start=0&max_results=${max}`
  );
}

// -------------------------------------------------------------------------
// 2. FETCH + PARSE one source  →  array of {title, summary, link, date, src}
// -------------------------------------------------------------------------
async function fetchSource(source, perSource) {
  // arXiv: one API call covering all listed categories, newest first.
  if (source.type === "arxiv") {
    const feed = await fetchFeed(arxivUrl(source.cats, perSource));
    return (feed.items || []).slice(0, perSource).map((it) => ({
      title: clean(it.title),
      summary: trim(stripHtml(it.contentSnippet || it.content || it.summary || ""), 260),
      link: (it.link || it.id || it.guid || "").trim(),
      date: toIso(it.isoDate || it.pubDate),
      src: source.name || "arXiv",
    }));
  }

  // rss + googlenews both resolve to a single feed URL.
  const url = source.type === "googlenews" ? googleNewsUrl(source.query) : source.url;
  const feed = await fetchFeed(url);

  return (feed.items || []).slice(0, perSource).map((it) => ({
    title: clean(it.title),
    summary: trim(stripHtml(it.contentSnippet || it.content || it.summary || ""), 220),
    link: (it.link || it.guid || "").trim(),
    date: toIso(it.isoDate || it.pubDate),
    // Source label priority: explicit name → Google News publisher → feed title → host.
    src:
      source.name ||
      asText(it.source) ||
      clean(feed.title) ||
      hostname(url) ||
      "News",
  }));
}

// -------------------------------------------------------------------------
// 3. LOAD ONE CATEGORY  —  fetch all its sources, merge, de-dup, sort.
//    (Same shape as v1's loadCategory, minus the throw-on-empty: a server
//    just writes an empty list and the page shows a friendly empty state.)
// -------------------------------------------------------------------------
async function loadCategory(cat, perSource) {
  // Fetch this category's sources a few at a time (CONCURRENCY), so a long
  // competitor list doesn't hammer Google News all at once.
  const results = await mapLimit(cat.sources, CONCURRENCY, (s) =>
    fetchSource(s, perSource)
  );

  let all = [];
  results.forEach((r, i) => {
    if (r.error) {
      // Log and keep going — one dead/slow feed shouldn't sink the category.
      console.warn(`  ! source ${i} in "${cat.id}" failed: ${r.error.message || r.error}`);
    } else {
      all = all.concat(r.value);
    }
  });

  // De-dupe by normalised title (same key logic as v1).
  const seen = new Set();
  all = all.filter((x) => {
    const key = (x.title || "").toLowerCase().replace(/\W+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Newest-first; items missing a date sink to the bottom.
  all.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  return all;
}

// -------------------------------------------------------------------------
// 4. MAIN  —  read sources.json, build every category, write data.json.
// -------------------------------------------------------------------------
async function main() {
  const cfg = JSON.parse(await readFile(new URL("./sources.json", import.meta.url)));
  const perSource = cfg.config?.perSource ?? 20;

  const categories = [];
  for (const cat of cfg.categories) {
    console.log(`Fetching "${cat.label}" (${cat.sources.length} source(s))…`);
    const items = await loadCategory(cat, perSource);
    console.log(`  → ${items.length} items`);
    categories.push({ id: cat.id, label: cat.label, items });
  }

  const out = { generatedAt: new Date().toISOString(), categories };
  await writeFile(
    new URL("./data.json", import.meta.url),
    JSON.stringify(out, null, 2)
  );

  const total = categories.reduce((n, c) => n + c.items.length, 0);
  console.log(`\nWrote data.json — ${total} items across ${categories.length} categories.`);
}

// -------------------------------------------------------------------------
// 5. HELPERS  (Node versions of v1's helpers — no DOM available here)
// -------------------------------------------------------------------------
function clean(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
function trim(s, n) {
  return s && s.length > n ? s.slice(0, n).trim() + "…" : s || "";
}
function stripHtml(s) {
  return clean((s || "").replace(/<[^>]*>/g, " "));
}
function asText(v) {
  // Google News <source> can parse as a string or an object {_:"Name", ...}.
  if (!v) return "";
  if (typeof v === "string") return clean(v);
  return clean(v._ || v["#"] || "");
}
function hostname(u) {
  try {
    return new URL(u).hostname.replace("www.", "");
  } catch {
    return "";
  }
}
function toIso(d) {
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

main().catch((err) => {
  console.error("BUILD FAILED:", err);
  process.exit(1);
});
