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

// RETENTION: how many days an item stays in the brief after we FIRST see it.
// Each run we merge freshly-fetched items with the ones already in data.json,
// so an article keeps showing for this many days even after it falls out of its
// source feed. Change this one number to widen/narrow the window.
const RETENTION_DAYS = 14;

// DE-DUPLICATION
//   Tier 1 (always on, see titleKey): strips the " - Publisher" suffix Google
//     News tacks on, drops filler/stopwords, and sorts the remaining words — so
//     a vendor's own headline and a news rewrite of it collapse to one key.
//   Tier 2 (FUZZY_DEDUPE): additionally merges headlines that *mostly* overlap
//     (e.g. "X launches Y" vs "X debuts Y model"), keeping a deterministic
//     winner — a native/vendor RSS item beats a Google News one; ties break by
//     earliest first-seen. Set FUZZY_DEDUPE = false to keep only Tier 1.
const FUZZY_DEDUPE = true;
const FUZZY_THRESHOLD = 0.8; // 0..1 — fraction of words two headlines must share to be treated as one story
const SOURCE_PRIORITY = { rss: 0, arxiv: 1, googlenews: 2 }; // lower number wins a fuzzy tie

// Filler words removed before building a de-dupe key. The launch-verb family
// (launch/release/announce/…) is the important part: it lets "X launches Y" and
// "X unveils Y" match. "model/models" is domain filler in an AI brief. Articles
// and prepositions are dropped as ordinary noise. NOTE: size/variant words
// (mini, large, small, pro, …) are deliberately NOT here — they distinguish
// products, e.g. "GPT-5" vs "GPT-5 mini".
const STOPWORDS = new Set(
  ("a an the and or of to for in on with at by from as is are be this that " +
   "new latest update updates launch launches launched release releases released " +
   "announce announces announced announcing introducing introduces introduce " +
   "unveil unveils unveiled debut debuts now amp model models")
    .split(" ")
);

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
// A source can set { gl, lang } to pick a Google News EDITION:
//   gl   = country edition (US, DE, GB, FR…) — decides which country's stories
//          get prioritised. Defaults to US.
//   lang = language of the results (en, de…). Defaults to en.
// No gl/lang on a source ⇒ US/en, i.e. byte-for-byte the original behaviour.
function googleNewsUrl(query, opts = {}) {
  const gl = opts.gl || "US";
  const lang = opts.lang || "en";
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=${lang}-${gl}&gl=${gl}&ceid=${gl}:${lang}`;
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
  // A source may set its own "max" to keep more (or fewer) items than the
  // global perSource — e.g. a broad Google News query can keep 40 while the
  // native feeds and arXiv stay at the default. Falls back to perSource.
  const cap = source.max || perSource;

  // arXiv: one API call covering all listed categories, newest first.
  if (source.type === "arxiv") {
    const feed = await fetchFeed(arxivUrl(source.cats, cap));
    return (feed.items || []).slice(0, cap).map((it) => ({
      title: clean(it.title),
      summary: trim(stripHtml(it.contentSnippet || it.content || it.summary || ""), 260),
      link: (it.link || it.id || it.guid || "").trim(),
      date: toIso(it.isoDate || it.pubDate),
      src: source.name || "arXiv",
      via: "arxiv",
    }));
  }

  // rss + googlenews both resolve to a single feed URL.
  const url = source.type === "googlenews"
    ? googleNewsUrl(source.query, { gl: source.gl, lang: source.lang })
    : source.url;
  const feed = await fetchFeed(url);

  return (feed.items || []).slice(0, cap).map((it) => ({
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
    via: source.type, // "rss" or "googlenews" — used to pick a fuzzy-dedupe winner
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

  // De-dupe by normalised title (same key logic as v1, now shared with the
  // retention merge so a stored item and a re-fetched one collapse together).
  const seen = new Set();
  all = all.filter((x) => {
    const key = titleKey(x.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Newest-first; items missing a date sink to the bottom.
  all.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  return all;
}

// -------------------------------------------------------------------------
// 4. MAIN  —  read sources.json, fetch fresh items, MERGE with the existing
//    data.json (the retention store), drop anything past the window, write.
// -------------------------------------------------------------------------
async function main() {
  const cfg = JSON.parse(await readFile(new URL("./sources.json", import.meta.url)));
  const perSource = cfg.config?.perSource ?? 20;
  const nowIso = new Date().toISOString();

  // The existing data.json is our memory of past runs. On the very first run
  // (or if it's missing/corrupt) we just start from an empty store.
  const stored = await loadStore();

  // Fetch this run's fresh items for every category in sources.json.
  const fresh = [];
  for (const cat of cfg.categories) {
    console.log(`Fetching "${cat.label}" (${cat.sources.length} source(s))…`);
    const items = await loadCategory(cat, perSource);
    console.log(`  → ${items.length} fetched`);
    fresh.push({ id: cat.id, label: cat.label, items });
  }

  // Merge fresh + stored, stamp first-seen dates, and drop items older than
  // RETENTION_DAYS. sources.json is the source of truth for which categories
  // exist (and their labels); the store only supplies remembered items.
  const categories = mergeWithRetention(stored, fresh, nowIso, RETENTION_DAYS);

  const out = { generatedAt: nowIso, categories };
  await writeFile(
    new URL("./data.json", import.meta.url),
    JSON.stringify(out, null, 2)
  );

  const total = categories.reduce((n, c) => n + c.items.length, 0);
  console.log(`\nWrote data.json — ${total} items kept across ${categories.length} categories (${RETENTION_DAYS}-day retention).`);
}

// Read the previous data.json so we can carry its items forward. Returns the
// array of categories, or [] if the file is missing/empty/unparseable — any of
// which just means "no memory yet", never a crash.
async function loadStore() {
  try {
    const parsed = JSON.parse(await readFile(new URL("./data.json", import.meta.url)));
    return Array.isArray(parsed.categories) ? parsed.categories : [];
  } catch {
    return [];
  }
}

// The retention engine. Pure function (no fetching/IO) so it's easy to reason
// about and test: given the remembered categories and this run's fresh ones,
// return the merged categories with stale items removed.
//
//   • Items are matched by titleKey — now a normalised, stopword-stripped,
//     word-sorted key (Tier 1), stable even when a Google News link or the
//     " - Publisher" suffix changes between fetches.
//   • After the retention cutoff, near-duplicate headlines are collapsed across
//     sources (Tier 2 fuzzy), keeping a vendor feed over a Google News rewrite.
//   • A title we've seen before keeps its ORIGINAL firstSeen, so re-seeing an
//     article does NOT restart its 14-day clock. Its other fields are refreshed
//     from the latest fetch (newer summary/link/date win).
//   • A title with no firstSeen yet (brand new, or migrated from an old
//     data.json that predates this feature) is stamped with `now`.
//   • Anything first seen more than `retentionDays` ago is dropped.
function mergeWithRetention(stored, fresh, nowIso, retentionDays) {
  const cutoff = Date.parse(nowIso) - retentionDays * 24 * 60 * 60 * 1000;
  const storedById = new Map((stored || []).map((c) => [c.id, c]));

  return fresh.map((cat) => {
    const byKey = new Map();

    // 1. Seed with what we remembered for this category last run.
    const prev = storedById.get(cat.id);
    for (const it of prev?.items || []) {
      const key = titleKey(it.title);
      if (key) byKey.set(key, { ...it, firstSeen: it.firstSeen || nowIso });
    }

    // 2. Layer this run's fresh items on top. Refresh content, but keep the
    //    original firstSeen if we'd already seen the title.
    for (const it of cat.items || []) {
      const key = titleKey(it.title);
      if (!key) continue;
      const firstSeen = byKey.get(key)?.firstSeen || nowIso;
      byKey.set(key, { ...it, firstSeen });
    }

    // 3. Drop anything past the retention window (a bad/missing date is kept,
    //    never silently dropped).
    let items = [...byKey.values()].filter((it) => {
      const t = Date.parse(it.firstSeen);
      return Number.isNaN(t) ? true : t >= cutoff;
    });

    // 4. TIER 2 fuzzy collapse of near-duplicate headlines across sources (e.g.
    //    a vendor feed item and a Google News rewrite of the same story). Sort
    //    by key first so clustering is deterministic and retention stays stable.
    items.sort((a, b) => titleKey(a.title).localeCompare(titleKey(b.title)));
    items = collapseFuzzy(items);

    // 5. Newest-first by published date (unchanged behaviour).
    items.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

    return { id: cat.id, label: cat.label, items };
  });
}

// -------------------------------------------------------------------------
// 5. HELPERS  (Node versions of v1's helpers — no DOM available here)
// -------------------------------------------------------------------------
function clean(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
// Drop the " - Publisher" (or " | Publisher") suffix Google News appends, so a
// vendor's own headline and the syndicated news copy normalise the same way.
// Only used for KEYS — the displayed title is never altered.
function stripPublisher(title) {
  const t = (title || "").replace(/\s+[-|]\s+[^-|]{1,40}$/, "").trim();
  return t || (title || "");
}
// The meaningful words of a headline: lowercase, no punctuation, no stopwords,
// no 1-letter tokens.
function significantTokens(title) {
  return stripPublisher(title)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    // keep words of 2+ chars and any all-digit token (version numbers like
    // "4", "5" distinguish products — never drop them), minus stopwords.
    .filter((t) => (t.length > 1 || /^\d+$/.test(t)) && !STOPWORDS.has(t));
}
// TIER 1 de-dupe key: significant words, de-duped and sorted, so word order and
// filler don't matter ("X launches Y" == "Y, by X"). Falls back to a simple
// normalised title if a headline is all filler, so we never drop such an item.
function titleKey(title) {
  const toks = significantTokens(title);
  if (toks.length) return [...new Set(toks)].sort().join(" ");
  return stripPublisher(title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
// Jaccard overlap of two token sets (0 = nothing in common, 1 = identical set).
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
// TIER 2 fuzzy collapse: greedily cluster items whose headlines overlap past
// FUZZY_THRESHOLD, then keep one winner per cluster. Deterministic (items are
// pre-sorted by key by the caller), so the same story resolves the same way
// every run — important for stable retention.
function collapseFuzzy(items) {
  if (!FUZZY_DEDUPE || items.length < 2) return items;
  const clusters = [];
  for (const it of items) {
    const toks = new Set(significantTokens(it.title));
    const hit = clusters.find((c) => jaccard(toks, c.tokens) >= FUZZY_THRESHOLD);
    if (hit) hit.members.push(it);
    else clusters.push({ tokens: toks, members: [it] });
  }
  return clusters.map((c) => pickWinner(c.members));
}
// Choose the representative of a duplicate cluster: prefer a vendor/native feed
// over Google News, then the earliest first-seen, then a stable key tiebreak.
// The winner inherits the EARLIEST first-seen in the cluster so the retention
// clock tracks when the story first appeared, not when the winner did.
function pickWinner(members) {
  if (members.length === 1) return members[0];
  const winner = members.slice().sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.via] ?? 9;
    const pb = SOURCE_PRIORITY[b.via] ?? 9;
    if (pa !== pb) return pa - pb;
    const fa = Date.parse(a.firstSeen) || Infinity;
    const fb = Date.parse(b.firstSeen) || Infinity;
    if (fa !== fb) return fa - fb;
    return titleKey(a.title).localeCompare(titleKey(b.title));
  })[0];
  const earliest = members.reduce((min, m) => {
    const t = Date.parse(m.firstSeen);
    return Number.isNaN(t) ? min : Math.min(min, t);
  }, Infinity);
  return Number.isFinite(earliest)
    ? { ...winner, firstSeen: new Date(earliest).toISOString() }
    : winner;
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
