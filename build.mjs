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

// rss-parser handles RSS 2.0 and Atom. We add a custom field so we can read
// the <source> element Google News puts on each item (the publisher name).
const parser = new Parser({
  timeout: 20000,
  headers: { "User-Agent": "DailyBrief/1.0 (+github actions)" },
  customFields: { item: [["source", "source"]] },
});

// -------------------------------------------------------------------------
// 1. BUILD FEED URLS  (one per source type) — same logic as v1's buildUrl,
//    except arXiv now uses the simpler per-category RSS endpoint
//    (rss.arxiv.org/rss/cs.AI) instead of the Atom export API.
// -------------------------------------------------------------------------
function googleNewsUrl(query) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}
function arxivUrl(cat) {
  return `https://rss.arxiv.org/rss/${cat}`;
}

// -------------------------------------------------------------------------
// 2. FETCH + PARSE one source  →  array of {title, summary, link, date, src}
// -------------------------------------------------------------------------
async function fetchSource(source, perSource) {
  // arXiv: a source can list several categories; fetch each feed and merge.
  if (source.type === "arxiv") {
    const cats = source.cats || [];
    const lists = await Promise.allSettled(
      cats.map(async (cat) => {
        const feed = await parser.parseURL(arxivUrl(cat));
        return (feed.items || []).slice(0, perSource).map((it) => ({
          title: clean(it.title),
          summary: trim(stripHtml(it.contentSnippet || it.content || it.summary), 260),
          link: (it.link || it.guid || "").trim(),
          date: toIso(it.isoDate || it.pubDate),
          src: source.name || "arXiv",
        }));
      })
    );
    return lists.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  // rss + googlenews both resolve to a single feed URL that rss-parser reads.
  const url = source.type === "googlenews" ? googleNewsUrl(source.query) : source.url;
  const feed = await parser.parseURL(url);

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
  const results = await Promise.allSettled(
    cat.sources.map((s) => fetchSource(s, perSource))
  );

  let all = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      all = all.concat(r.value);
    } else {
      // Log and keep going — one dead feed shouldn't sink the category.
      console.warn(`  ! source ${i} in "${cat.id}" failed: ${r.reason?.message || r.reason}`);
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
