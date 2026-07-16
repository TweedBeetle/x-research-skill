# Changelog

## v2.5.0 (2026-07-16)

### Mid-2026 X API freshen-up (verified against live docs)

- **Pricing (Apr 16, 2026 update).** All cost figures corrected: post create $0.015, **post containing a URL $0.20 (13x)**, summoned reply $0.010, post read $0.005, owned read $0.001, user lookup $0.010, DM create $0.015, DM read $0.010. Cost constants single-sourced into a `COST` object in `x.ts`; `post`/`reply`/`quote`/`thread-post` detect URLs and warn about the 13x price before posting. (`tweet` read cost corrected from $0.01 → $0.005.)
- **Articles (long-form) support.** New `article-draft` / `article-publish` commands wrapping `POST /2/articles/draft` + `POST /2/articles/{id}/publish` (launched 2026-06-11, Premium account required, no edit/delete endpoints yet). Includes a simple markdown-ish → DraftJS content-state builder (paragraphs, `#`/`##`/`###` headers, `-` lists, `[text](url)` links).
- **Media upload migrated to v2.** `POST /2/media/upload` replaces the sunset (2025-06-09) v1.1 `upload.twitter.com` endpoint. Simple single-request path for images/small GIFs; chunked INIT/APPEND/FINALIZE/STATUS path for **video** (MP4/MOV, up to 512MB) — new capability.
- **Retry/backoff.** The client honors `x-rate-limit-reset` / `Retry-After` on 429 and applies bounded exponential backoff on 5xx. Content-creating POSTs skip 5xx retry (double-post safety) but still retry 429; reads/deletes/engagement retry both.
- **Resumable threads.** `thread-post` persists each posted tweet id to a state file (`<file>.thread-state.json`, or `--state`); a mid-chain failure resumes rather than double-posts. `--fresh` discards prior state.
- **Search modernization (2026-05-04 index migration).** `--min-likes` / `--quality` / new `--min-replies` / `--min-reposts` now emit native `min_likes:` / `min_replies:` / `min_reposts:` operators (server-side, cheaper) instead of post-hoc filtering; `--min-impressions` stays post-hoc (no native operator). Retweets are excluded from keyword search under the new index.
- **Docs.** SKILL.md + references/x-api.md updated (pricing, Articles, v2 media, reply-summon restriction, search operators); added a "Live smoke-test checklist" for the parts that need a real (paid) post to confirm: thread self-chaining under the 2026-02-23 reply-summon restriction, v2 media (esp. video), the Articles draft+publish round trip, and retry behavior.

## v2.4.1 (2026-07-10)

### Docs — Verified auth/credit state + X MCP verdict
Live re-probe after a $5 credit top-up cleared a `402 CreditsDepleted` outage (the whole pay-per-use pool had been empty; console.x.com was also IP-throttling the dashboard for days — unrelated to API usage).

- **Bookmarks work on plain OAuth 1.0a** — the assumed OAuth 2.0 PKCE requirement is relaxed on pay-per-use (verified: `bookmarks` returned real data). Corrected the SKILL.md verified-state block + front-matter, which had claimed bookmarks need PKCE.
- **DMs remain gated** — `403 oauth1-permissions`; fix is a console app-permission bump to "Read, Write, and Direct Messages" + regenerate the OAuth 1.0a access token (NOT PKCE). Parked as reminder `af04e1`.
- **X MCP (`api.x.com/mcp` / `xdevplatform/xmcp`) assessed** — borrow-don't-replace: 200+ endpoints incl. writes, OAuth2-PKCE auto-refresh, but rides the SAME pay-per-use credit pool + dev app + rate limits, so it's an interface swap, not a cost/capability leap. Keep the on-demand CLI (zero standing MCP-memory cost, per-call `$` instrumentation). Verdict block added to SKILL.md.

## v2.4.0 (2026-03-04)

### Fixed — Bearer Token 403 on Pay Per Use Accounts
Pay Per Use X API accounts have a known platform bug where bearer tokens return 403 ("client_id not attached to a Project"). This affected all read operations (search, profile, thread, tweet). Deleted the old Free-tier app (client_id 30672451) that was polluting the bearer token, but the bug persisted even after regeneration.

- **Switched all read operations to OAuth 1.0a** — `apiGet` now uses the same OAuth 1.0a signing as write operations instead of bearer token auth
- **Fixed OAuth signature for GET requests** — `buildOAuthHeader` now includes URL query parameters in the signature base string (required by OAuth 1.0a spec)
- **Updated auth docs** — SKILL.md and README.md reflect that all operations use OAuth 1.0a
- **Removed stale path references** — `~/clawd/drafts/` → `~/.claude/drafts/`, `~/clawd/skills/x-research` → `~/.claude/skills/x-api`, removed `source ~/.config/env/global.env`

## v2.3.0 (2026-02-09)

### Fixed — Remove LLM Hallucinations
Most LLMs have the old X API tier system (Basic/Pro/Enterprise, $200/mo subscriptions) baked into their training data. This caused confusion for users whose agents referenced pricing and access levels that no longer exist. This release updates all skill docs to reflect the current pay-per-use model so your agent has accurate information.

- **Purged all stale tier/subscription references** across 6 files (13 instances of "Basic tier", "current tier", "enterprise-only" etc.)
- **Full-archive search** (`/2/tweets/search/all`) is available on pay-per-use — not enterprise-only as LLMs commonly claim
- **Updated rate limits** — old per-15-min caps replaced by spending limits in Developer Console
- **Clarified 7-day limit** is a skill limitation (using recent search endpoint), not an API restriction
- **Updated query length limits** — 512 chars (recent), 1024 (full-archive), 4096 (enterprise)
- Added per-resource cost breakdown: $0.005/post read, $0.010/user lookup, $0.010/post create
- Added 24-hour deduplication docs, xAI credit bonus tiers, usage monitoring endpoint

### Fixed
- **Tweet truncation bug** — `tweet` and `thread` commands now show full tweet text instead of cutting off at 200 characters. Search results still truncate for readability. (h/t @sergeykarayev)

### Added
- **Security section in README** — Documents bearer token exposure risk when running inside AI coding agents with session logging. Includes recommendations for token handling.

## v2.2.0 (2026-02-08)

### Added
- **`--quick` mode** — Smarter, cheaper searches. Single page, auto noise filtering (`-is:retweet -is:reply`), 1hr cache TTL. Designed for fast pulse checks.
- **`--from <username>`** — Shorthand for `from:username` queries. `search "BNKR" --from voidcider` instead of typing the full operator.
- **`--quality` flag** — Filters out low-engagement tweets (≥10 likes). Applied post-fetch since `min_faves` operator isn't available via the API.
- **Cost display on all searches** — Every search now shows estimated API cost: `📊 N tweets read · est. cost ~$X`

### Changed
- README cleaned up — removed duplicate cost section, added Quick Mode and Cost docs
- Cache supports variable TTL (1hr in quick mode, 15min default)

## v2.1.0 (2026-02-08)

### Added
- **`--since` time filter** — search only recent tweets: `--since 1h`, `--since 3h`, `--since 30m`, `--since 1d`
  - Accepts shorthand (`1h`, `30m`, `2d`) or ISO 8601 timestamps
  - Great for monitoring during catalysts or checking what just dropped
- Minutes support (`30m`, `15m`) in addition to hours and days
- Cache keys now include time filter to prevent stale results across different time ranges

## v2.0.0 (2026-02-08)

### Added
- **`x-search.ts` CLI** — Bun script wrapping the X API. No more inline curl/python one-liners.
  - `search` — query with auto noise filtering, engagement sorting, pagination
  - `profile` — recent tweets from any user
  - `thread` — full conversation thread by tweet ID
  - `tweet` — single tweet lookup
  - `watchlist` — manage accounts to monitor, batch-check recent activity
  - `cache clear` — manage result cache
- **`lib/api.ts`** — Typed X API wrapper with search, thread, profile, tweet lookup, engagement filtering, deduplication
- **`lib/cache.ts`** — File-based cache with 15-minute TTL. Avoids re-fetching identical queries.
- **`lib/format.ts`** — Output formatters for Telegram (mobile-friendly) and markdown (research docs)
- **Watchlist system** — `data/watchlist.json` for monitoring accounts. Useful for heartbeat integration.
- **Auto noise filtering** — `-is:retweet` added by default unless already in query
- **Engagement sorting** — `--sort likes|impressions|retweets|recent`
- **Post-hoc filtering** — `--min-likes N` and `--min-impressions N` (since X API doesn't support these as search operators)
- **Save to file** — `--save` flag auto-saves research to `~/.claude/drafts/`
- **Multiple output formats** — `--json` for raw data, `--markdown` for research docs, default for Telegram

### Changed
- **SKILL.md** rewritten to reference CLI tooling. Research loop instructions preserved and updated.
- **README.md** expanded with full install, setup, usage, and API cost documentation.

### How it compares to v1
- v1 was a prompt-only skill — Claude assembled raw curl commands with inline Python parsers each time
- v2 wraps everything in typed Bun scripts — faster execution, cleaner output, fewer context tokens burned on boilerplate
- Same agentic research loop, same X API, just better tooling underneath

## v1.0.0 (2026-02-08)

### Added
- Initial release
- SKILL.md with agentic research loop (decompose → search → refine → follow threads → deep-dive → synthesize)
- `references/x-api.md` with full X API endpoint reference
- Search operators, pagination, thread following, linked content deep-diving
