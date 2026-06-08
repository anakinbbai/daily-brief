# Daily Brief

Internal AI news aggregator. Feeds are fetched **server-side on a schedule** by
GitHub Actions, written to `data.json`, and served as a static site on GitHub
Pages. The page itself just reads `data.json` — no proxies, no CORS, no live
feed requests in the browser.

## Files

| File | What it is |
|------|------------|
| `index.html` | The page. Reads `./data.json` and renders the cards. |
| `sources.json` | **The only file you edit day to day.** The 5 categories + their sources. |
| `build.mjs` | Runs on GitHub's servers: fetch → parse → dedup → write `data.json`. |
| `package.json` | Declares the one dependency (`rss-parser`). |
| `.github/workflows/build-and-deploy.yml` | Schedules the build + deploys to Pages. |
| `data.json` | **The retention store.** Regenerated each run by merging fresh items with the previous `data.json`, then committed back so items persist for 14 days. |

## One-time setup

1. Create a GitHub repo and add these files (a sample `data.json` is included so
   the page renders before the first build).
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. **Actions** tab → *build-and-deploy* → **Run workflow** (manual first run).
4. Open your Pages URL (shown in the deploy step) and confirm cards appear.

After that it refreshes itself every 3 hours.

## Retention (14 days)

Each build merges the freshly-fetched items with the previous `data.json`,
matching by headline so the same article isn't duplicated even if its link
changes. Every item is stamped with a `firstSeen` date the first time it
appears; anything first seen more than **14 days** ago is dropped. This means an
article keeps showing for two weeks even after it falls out of its source feed —
handy for quiet blogs and for the Research tab (arXiv only adds papers on certain
days). To change the window, edit `RETENTION_DAYS` at the top of `build.mjs`.

The build commits the updated `data.json` back to the repo (that committed file
is the memory the next run reads). That commit does **not** start another build:
the workflow's `push` trigger only watches the source files, and `data.json`
isn't one of them.

## Adding a source

Open `sources.json` and add one line to the right category's `sources` array:

- Direct feed:  `{ "type": "rss", "name": "Some Lab", "url": "https://site.com/feed" }`
- News by keyword: `{ "type": "googlenews", "query": "\"Company\" launch OR funding" }`
- Research papers: `{ "type": "arxiv", "cats": ["cs.AI", "cs.DB"] }`

Commit the change — the push retriggers the workflow and the site updates.

## Testing locally (optional)

```bash
npm install
node build.mjs        # writes data.json by fetching the real feeds
npx serve .           # or any static server, then open index.html
```

## Not yet included (later phases)

- **Phase 2:** Claude-generated titles/summaries + relevance scoring
  (needs an `ANTHROPIC_API_KEY` stored as a repo **Actions secret**).
- **Phase 3:** headless-browser scraping for JS-only sites (e.g. Mistral).
