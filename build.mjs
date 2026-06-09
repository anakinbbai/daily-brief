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

// =========================================================================
// PHASE 2 — AI ENRICHMENT  (clean title + 1–2 sentence summary + a type tag +
// keep/drop relevance + one allowed re-route "Move 1").
//
// Cost stays tiny because ONLY brand-new items are ever sent to the API. Every
// judgment is cached in data.json under "judgments" (keyed by titleKey) and
// re-applied for FREE on later runs — so a recurring junk headline is judged
// once, not every 3 hours. If ANTHROPIC_API_KEY is missing or ENRICH is false,
// the build still works end-to-end; it just shows each source's own title and
// summary (exactly like before Phase 2). Nothing here can crash the build.
// =========================================================================
const ENRICH = true;
// Fast + cheap, and plenty for "clean a title, write two sentences, classify".
// Override with the ENRICH_MODEL env var; bump to "claude-sonnet-4-6" if the
// drop/move calls ever feel off.
const ENRICH_MODEL = process.env.ENRICH_MODEL || "claude-haiku-4-5";
const ENRICH_BATCH = 10;          // items per Claude call
const ENRICH_CONCURRENCY = 3;     // how many Claude calls run at once (be polite)
const ENRICH_TIMEOUT_MS = 60000;  // hard cap per API call
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_VERSION = "2023-06-01";

// Move 1 is the ONLY re-route allowed in v1: a "What's new in AI" item that is a
// business/strategy move (NOT a product launch) may move to "More on AI".
// Anything else the model proposes is ignored — see buildDisplay().
const MOVE_FROM = "ai";
const MOVE_TO = "industry";

// Fallback tag vocabulary, used only if sources.json doesn't define config.tags.
const DEFAULT_TAGS = [
  "product-launch", "product-update", "funding-or-MA",
  "business-strategy", "research", "regulation-legal", "other",
];

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

  // Memory of past runs: the raw retention store + the AI judgment cache.
  const stored = await loadStore();
  const judgments = await loadJudgments();

  // Fetch this run's fresh items for every category in sources.json.
  const fresh = [];
  for (const cat of cfg.categories) {
    console.log(`Fetching "${cat.label}" (${cat.sources.length} source(s))…`);
    const items = await loadCategory(cat, perSource);
    console.log(`  → ${items.length} fetched`);
    fresh.push({ id: cat.id, label: cat.label, items });
  }

  // RAW retention store: merge fresh + stored, stamp first-seen, drop stale.
  // Titles stay raw here, so titleKey identity is stable run-to-run. (Engine
  // unchanged from Phase 1 — this is exactly the same call as before.)
  const retention = mergeWithRetention(stored, fresh, nowIso, RETENTION_DAYS);

  // PHASE 2: judge only the NEW items (those with no cached judgment yet), then
  // prune the cache to what's still retained so it can never grow unbounded.
  await enrichNewItems(retention, judgments, cfg);
  pruneJudgments(retention, judgments);

  // Reader-facing view, rebuilt every run from retention + cached judgments:
  // drop the clutter, swap in clean titles/summaries, apply Move 1. The page
  // reads this `categories` array exactly as it always has.
  const categories = buildDisplay(retention, judgments, cfg);

  const out = { generatedAt: nowIso, categories, retention, judgments };
  await writeFile(
    new URL("./data.json", import.meta.url),
    JSON.stringify(out, null, 2)
  );

  const shown = categories.reduce((n, c) => n + c.items.length, 0);
  const dropped = Object.values(judgments).filter((j) => j && j.keep === false).length;
  console.log(
    `\nWrote data.json — ${shown} items shown across ${categories.length} categories ` +
    `(${RETENTION_DAYS}-day retention; ${Object.keys(judgments).length} judged, ${dropped} dropped as clutter).`
  );
}

// Read the previous data.json so we can carry its items forward. We now prefer
// the RAW `retention` store (raw titles = stable identity), and fall back to the
// reader-facing `categories` the FIRST time we run after the Phase 2 upgrade, so
// the existing 14 days of memory isn't thrown away. Returns [] on any problem.
async function loadStore() {
  try {
    const parsed = JSON.parse(await readFile(new URL("./data.json", import.meta.url)));
    if (Array.isArray(parsed.retention)) return parsed.retention;       // normal path
    return Array.isArray(parsed.categories) ? parsed.categories : [];   // first-run migration
  } catch {
    return [];
  }
}

// The cache of past AI judgments, keyed by titleKey. Invisible to the reader.
// {} on any problem (missing file / pre-Phase-2 data) — just means "judge fresh".
async function loadJudgments() {
  try {
    const parsed = JSON.parse(await readFile(new URL("./data.json", import.meta.url)));
    return parsed.judgments && typeof parsed.judgments === "object" ? parsed.judgments : {};
  } catch {
    return {};
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

// =========================================================================
// 6. PHASE 2 FUNCTIONS  (all fail-safe: any error leaves items un-enriched,
//    so the build always finishes and the page still renders.)
// =========================================================================

// Judge every item we haven't judged before. Mutates `judgments` in place.
async function enrichNewItems(retention, judgments, cfg) {
  if (!ENRICH) return;
  if (!ANTHROPIC_API_KEY) {
    console.warn("  ! ANTHROPIC_API_KEY not set — skipping AI enrichment (showing the sources' own titles/summaries).");
    return;
  }

  // Collect items with no cached judgment yet (keyed by the SAME titleKey the
  // retention engine uses, so a story is judged once across all runs).
  const todo = [];
  for (const cat of retention) {
    for (const it of cat.items || []) {
      const key = titleKey(it.title);
      if (key && !(key in judgments)) todo.push({ key, catId: cat.id, item: it });
    }
  }
  if (!todo.length) {
    console.log("  AI enrichment: nothing new to judge.");
    return;
  }
  console.log(`  AI enrichment: judging ${todo.length} new item(s) in batches of ${ENRICH_BATCH} with ${ENRICH_MODEL}…`);

  const batches = [];
  for (let i = 0; i < todo.length; i += ENRICH_BATCH) batches.push(todo.slice(i, i + ENRICH_BATCH));

  const tags = Array.isArray(cfg.config?.tags) && cfg.config.tags.length ? cfg.config.tags : DEFAULT_TAGS;
  const catInfo = cfg.categories.map((c) => ({ id: c.id, label: c.label, description: c.description || c.label }));

  const results = await mapLimit(batches, ENRICH_CONCURRENCY, (batch) => callClaudeBatch(batch, catInfo, tags));

  results.forEach((r, bi) => {
    if (r.error) {
      console.warn(`  ! enrichment batch ${bi} failed: ${r.error.message || r.error} — those items keep their source title/summary and are retried next run.`);
      return;
    }
    const byIndex = r.value; // Map: position in batch -> verdict object
    batches[bi].forEach((entry, idx) => {
      const v = byIndex.get(idx);
      if (!v) return; // garbled/missing for this item — leave unjudged, retry next run
      judgments[entry.key] = {
        title: (v.title && String(v.title).trim()) || entry.item.title,
        summary: v.summary != null ? String(v.summary).trim() : entry.item.summary,
        tag: tags.includes(v.tag) ? v.tag : "other",
        keep: v.keep !== false,                 // default to keep unless explicitly false
        category: v.category || entry.catId,    // validated later in buildDisplay()
      };
    });
  });
}

// One Claude call for a batch of items. Returns Map(indexInBatch -> verdict).
async function callClaudeBatch(batch, catInfo, tags) {
  const system =
    "You are the editor of an internal AI-industry news brief. For each item you receive, return a cleaned headline, a short factual summary, one tag, a keep/drop decision, and the best-fit category id.\n\n" +
    "CATEGORIES (refer to them by id):\n" +
    catInfo.map((c) => `- ${c.id}: ${c.label} — ${c.description}`).join("\n") +
    "\n\nTAGS (choose exactly one): " + tags.join(", ") +
    "\n\nRULES:\n" +
    "- title: concise and factual. Fix mangled or glued-together text and remove any trailing ' - Publisher' suffix. Never invent facts not present in the input.\n" +
    "- summary: 1-2 sentences, built only from the given title/summary. If there isn't enough, paraphrase the title. No marketing language.\n" +
    "- keep: default true. Set false ONLY for clutter — items that are off-topic, not really about AI, pure SEO/listicle spam, or an obvious rehash of the same story.\n" +
    `- category: normally return the item's current category id unchanged. The ONLY permitted change: an item whose current category is "${MOVE_FROM}" that is a business/strategy/funding/hardware/personnel/legal story (NOT a product or model launch) should be returned as "${MOVE_TO}". Never reassign any other item.\n` +
    '- Respond with ONLY a JSON array — no prose, no markdown code fences. One object per item: {"i": <number from the input>, "title": <string>, "summary": <string>, "tag": <string>, "keep": <boolean>, "category": <id>}.';

  const items = batch.map((e, i) => ({
    i,
    current_category: e.catId,
    title: e.item.title,
    summary: trim(e.item.summary || "", 300),
  }));

  const body = {
    model: ENRICH_MODEL,
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: "Items:\n" + JSON.stringify(items) }],
  };

  const text = await anthropicMessage(body);
  return parseVerdicts(text);
}

// POST to the Messages API with a hard timeout and one retry on 429/5xx.
async function anthropicMessage(body, attempt = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ENRICH_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} (transient)`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    // A response is a list of content blocks; concatenate the text ones.
    return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  } catch (err) {
    if (attempt < 1) {
      await new Promise((r) => setTimeout(r, 1500));
      return anthropicMessage(body, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Parse the model's JSON array defensively (tolerates stray text / code fences).
function parseVerdicts(text) {
  const map = new Map();
  if (!text) return map;
  let s = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a !== -1 && b !== -1 && b > a) s = s.slice(a, b + 1); // grab the outermost [ ... ]
  let arr;
  try { arr = JSON.parse(s); } catch { return map; }
  if (!Array.isArray(arr)) return map;
  for (const o of arr) if (o && typeof o.i === "number") map.set(o.i, o);
  return map;
}

// Build the reader-facing categories from the raw retention store + judgments.
// Drops clutter, swaps in clean title/summary, attaches the (hidden) tag, and
// applies Move 1. The retention store itself is never mutated here.
function buildDisplay(retention, judgments, cfg) {
  const order = cfg.categories.map((c) => ({ id: c.id, label: c.label }));
  const validIds = new Set(order.map((c) => c.id));
  const out = new Map(order.map((c) => [c.id, { id: c.id, label: c.label, items: [] }]));
  const seen = new Map(order.map((c) => [c.id, new Set()])); // de-dupe per destination category

  for (const cat of retention) {
    if (!out.has(cat.id)) continue; // a stored category no longer in sources.json — ignore
    for (const it of cat.items || []) {
      const key = titleKey(it.title);
      const j = key ? judgments[key] : null;
      if (j && j.keep === false) continue; // clutter — remembered in the cache, just not shown

      // Destination: honor ONLY the one allowed move (ai -> industry).
      let dest = cat.id;
      if (j && j.category && validIds.has(j.category) && cat.id === MOVE_FROM && j.category === MOVE_TO) {
        dest = MOVE_TO;
      }

      const seenHere = seen.get(dest);
      if (key && seenHere.has(key)) continue; // same story already placed here (e.g. a move collided)
      if (key) seenHere.add(key);

      const display = {
        title: (j && j.title) || it.title,
        summary: j && j.summary != null ? j.summary : it.summary,
        link: it.link,
        date: it.date,
        src: it.src,
      };
      if (j && j.tag) display.tag = j.tag; // stored for later; the v1 reader ignores it
      out.get(dest).items.push(display);
    }
  }

  // Newest-first within each category (same ordering the page expects).
  for (const c of out.values()) {
    c.items.sort((x, y) => (Date.parse(y.date) || 0) - (Date.parse(x.date) || 0));
  }
  return [...out.values()];
}

// Keep the judgment cache bounded: forget any key that's no longer retained.
function pruneJudgments(retention, judgments) {
  const live = new Set();
  for (const cat of retention) for (const it of cat.items || []) {
    const k = titleKey(it.title);
    if (k) live.add(k);
  }
  for (const k of Object.keys(judgments)) if (!live.has(k)) delete judgments[k];
}

main().catch((err) => {
  console.error("BUILD FAILED:", err);
  process.exit(1);
});
