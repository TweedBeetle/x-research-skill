---
name: x-api
description: >
  Programmatic X/Twitter interaction via API. Search, post, reply, quote-tweet, delete,
  thread-post, publish long-form Articles, like, repost, follow, upload media (image + video),
  bookmarks, DMs, monitor accounts, and research topics.
  Use when: (1) user says "x research", "search x", "search twitter", "post to x",
  "tweet", "reply on x", "check x for", "x search", "/x-api",
  (2) user wants to post tweets, threads, or replies programmatically (with optional images),
  (3) user is doing research where recent X discourse provides useful context,
  (4) user wants to monitor accounts or find conversations to engage with,
  (5) user wants to like, repost, follow, bookmark, or otherwise engage on X,
  (6) user wants to send or read direct messages,
  (7) user wants to upload images for tweets.
  Supports read (search, profile, thread, bookmarks, dms), write (post, reply, quote, delete,
  thread-post, upload, dm), and engagement (like, unlike, repost, unrepost, follow, unfollow,
  bookmark, unbookmark) via OAuth 1.0a.
  Pay-per-use API ($0.015/post, $0.20/post-with-URL — 13x, $0.005/read; Apr 2026 pricing).
  Note: search supports both recent (7 days) and full-archive (all time) via --archive flag.
  Note: bookmarks work on OAuth 1.0a (verified 2026-07-10); only DMs are gated — raise the dev app to include Direct Messages + regenerate the access token (not PKCE).
---

# X Research

General-purpose agentic research over X/Twitter. Decompose any research question into targeted searches, iteratively refine, follow threads, deep-dive linked content, and synthesize into a sourced briefing.

For X API details (endpoints, operators, response format): read `references/x-api.md`.

## CLI Tool

All commands run from this skill directory:

```bash
cd ~/.claude/skills/x-api
```

Keys are auto-loaded from `~/keys/X_*.txt` files (no env sourcing needed).

### Search

```bash
bun run x.ts search "<query>" [options]
```

**Options:**
- `--sort likes|impressions|retweets|recent` -- sort order (default: likes)
- `--since 1h|3h|12h|1d|7d` -- time filter (default: last 7 days). Also accepts minutes (`30m`) or ISO timestamps.
- `--min-likes N` -- filter by minimum likes
- `--min-impressions N` -- filter by minimum impressions
- `--pages N` -- pages to fetch, 1-5 (default: 1, 100 tweets/page, 500/page with --archive)
- `--limit N` -- max results to display (default: 15)
- `--quick` -- quick mode: 1 page, max 10 results, auto noise filter (`-is:retweet -is:reply`), 1hr cache, cost summary
- `--from <username>` -- shorthand for `from:username` in query
- `--quality` -- filter low-engagement tweets (>=10 likes, post-hoc)
- `--archive` -- full-archive search (all time, back to March 2006). Same credits, max 500 results/page, 1024-char query limit.
- `--no-replies` -- exclude replies
- `--save` -- save results to `~/.claude/drafts/x-research-{slug}-{date}.md`
- `--json` -- raw JSON output
- `--markdown` -- markdown output for research docs

Auto-adds `-is:retweet` unless query already includes it. All searches display estimated API cost.

**Examples:**
```bash
bun run x.ts search "BNKR" --sort likes --limit 10
bun run x.ts search "from:frankdegods" --sort recent
bun run x.ts search "(opus 4.6 OR claude) trading" --pages 2 --save
bun run x.ts search "$BNKR (revenue OR fees)" --min-likes 5
bun run x.ts search "BNKR" --quick
bun run x.ts search "BNKR" --from voidcider --quick
bun run x.ts search "AI agents" --quality --quick
bun run x.ts search "potion RSS agents" --archive --pages 2
```

### Profile

```bash
bun run x.ts profile <username> [--count N] [--replies] [--json]
```

Fetches recent tweets from a specific user (excludes replies by default).

### Thread

```bash
bun run x.ts thread <tweet_id> [--pages N]
```

Fetches full conversation thread by root tweet ID.

### Single Tweet

```bash
bun run x.ts tweet <tweet_id> [--json]
```

### Post

```bash
bun run x.ts post "Your tweet text here"
```

Posts a new tweet. Max 25,000 chars (Premium account). Requires OAuth 1.0a credentials (see below).

> ⚠️ **A post that contains a URL costs $0.20 — 13x the $0.015 base** (Apr 2026 pricing). The CLI detects URLs and warns before posting. This gives the "link in the first self-reply, not the hook" pattern a second, economic motivation on top of reach: put the link in ONE self-reply so exactly one post in the thread pays the 13x penalty, while the hook stays cheap ($0.015) AND keeps its distribution (link-free main tweets reach further). Applies to `post`, `reply`, `quote`, and each `thread-post` tweet.

### Reply

```bash
bun run x.ts reply <tweet_id_or_url> "Your reply text"
```

Reply to an existing tweet. Accepts tweet ID or full URL.

### Quote Tweet

```bash
bun run x.ts quote <tweet_url_or_id> "Your comment"
# alias: qt
```

### Delete

```bash
bun run x.ts delete <tweet_id_or_url>
# alias: del
```

### Thread Post

```bash
bun run x.ts thread-post --file <path> [--state <file>] [--fresh]
# alias: tp
```

Post a multi-tweet thread from a file. Parses the file by splitting on `## Tweet N` headers (matching the draft format used in `chronicles/x-thread-draft-*.md`). Falls back to `---` separators, then one tweet per line.

Posts the first tweet, then chains each subsequent tweet as a reply with a 1-second delay between posts. Prints each tweet URL as it's posted.

**Resumable (added 2026-07-16):** each posted tweet's id is persisted as it lands, to `<file>.thread-state.json` by default (override with `--state`). If a mid-chain post fails, re-running the same command resumes from the last posted tweet rather than double-posting the ones that already went out. On full success the state file is removed. Use `--fresh` to discard prior state and start over.

**Example thread file:**
```markdown
## Tweet 1 (Hook)
If you're building with AI agents, here's what I learned this week

## Tweet 2
First insight goes here...

## Tweet 3 (CTA)
Reply if you want to hear more.
```

### Articles (long-form) <!-- added: 2026-07-16 -->

```bash
bun run x.ts article-draft --title "My Title" --file article.md [--publish]
bun run x.ts article-publish <article_id>
```

Create and publish X Articles (long-form, rich-text posts) via the API. Launched **2026-06-11**. Authoring Articles **requires an X Premium account**. There are **no edit or delete endpoints yet** — a draft can only be created and then published once.

`article-draft` takes a markdown-ish body (from `--file` or inline args) and builds a DraftJS content state. Supported markup is intentionally simple: blank-line-separated paragraphs, ATX headers (`#`, `##`, `###`), `-`/`*` unordered list items, and inline `[text](url)` links. It prints the returned `article_id`. Pass `--publish` to draft then publish in one step, or run `article-publish <id>` later.

- `POST /2/articles/draft` body: `{ "title": ..., "content_state": { "blocks": [...], "entityMap": {...} } }`
- `POST /2/articles/{article_id}/publish` — no body.

This makes the **Article + summary-thread hybrid** (write the Article, post a summarized thread as the distribution engine, link the Article at the end) fully automatable end to end. See the x-posting skill.

⚠️ **Needs a live round trip to confirm** — the DraftJS body shape (especially whether X wants `entityMap` vs an `entities` array for links) and the Premium gate were verified against docs, not by an actual draft+publish. See the smoke-test checklist at the end. The link display text always survives as plain text, so a shape mismatch degrades links to plain text rather than dropping content.

### Like / Unlike

```bash
bun run x.ts like <tweet_id_or_url>
bun run x.ts unlike <tweet_id_or_url>
```

### Repost / Unrepost

```bash
bun run x.ts repost <tweet_id_or_url>    # retweet
# alias: rt
bun run x.ts unrepost <tweet_id_or_url>  # undo retweet
# alias: unrt
```

### Follow / Unfollow

```bash
bun run x.ts follow <username>
bun run x.ts unfollow <username>
```

### Upload Media <!-- v2 migration: 2026-07-16 -->

```bash
bun run x.ts upload <filepath>
```

Uploads a media file and prints the `media_id_string` to stdout. Use this to pre-upload media, then pass the ID to tweet creation. Uses the **v2 `POST /2/media/upload`** endpoint (OAuth 1.0a).

- **Images / small GIFs** (JPEG, PNG, GIF, WebP; max 5MB image, 15MB GIF) use the simple single-request path.
- **Video** (MP4, MOV; max 512MB) uses the chunked `INIT`/`APPEND`/`FINALIZE`/`STATUS` flow and polls until X finishes async processing. This is what unlocks video posting.

The v2 response carries the media id in `data.id` (the code also falls back to the legacy `media_id_string` shape). The old v1.1 `upload.twitter.com/1.1/media/upload.json` endpoint was **sunset 2025-06-09** and is no longer used.

### Post / Reply / Quote with Media

```bash
bun run x.ts post "Tweet text" --media /path/to/image.jpg
bun run x.ts reply <tweet_id> "Reply text" --media /path/to/image.png
bun run x.ts quote <tweet_url> "Quote text" --media /path/to/image.gif
```

The `--media` flag uploads the file first, then attaches it to the tweet. Supports images (max 5MB) and video (MP4/MOV, chunked) via the v2 upload path.

### Bookmarks

```bash
bun run x.ts bookmarks [--limit N] [--json]   # List bookmarks (alias: bm)
bun run x.ts bookmark <tweet_id_or_url>        # Bookmark a tweet
bun run x.ts unbookmark <tweet_id_or_url>      # Remove a bookmark
```

**Auth note:** Bookmarks may require OAuth 2.0 PKCE instead of OAuth 1.0a. If you get a 403, this endpoint needs PKCE (not yet implemented). The skill tries OAuth 1.0a first since pay-per-use (Feb 2026) may have relaxed the old restriction.

### Direct Messages

```bash
bun run x.ts dm <username> "Your message"       # Send a DM
bun run x.ts dms [--limit N] [--json]           # List recent DM events
bun run x.ts dms <conversation_id> [--limit N]  # List specific conversation
```

Sends DMs to a user (looks up their user ID first). Lists recent DM events across all conversations, or filters to a specific conversation ID.

**Auth note:** DMs may require OAuth 2.0 PKCE. Same caveat as bookmarks - 403 means PKCE needed.

### Watchlist

```bash
bun run x.ts watchlist                       # Show all
bun run x.ts watchlist add <user> [note]     # Add account
bun run x.ts watchlist remove <user>          # Remove account
bun run x.ts watchlist check                  # Check recent from all
```

Watchlist stored in `data/watchlist.json`. Use for heartbeat integration -- check if key accounts posted anything important.

### Cache

```bash
bun run x.ts cache clear    # Clear all cached results
```

15-minute TTL. Avoids re-fetching identical queries.

## Authentication

**All operations** use OAuth 1.0a user credentials. Bearer token auth was removed because Pay Per Use accounts have a known X platform bug where bearer tokens return 403 ("client not attached to project").

**Note:** Media upload uses the **v2 `POST /2/media/upload`** endpoint (the v1.1 `upload.twitter.com` endpoint was sunset 2025-06-09). Bookmarks and DMs historically required OAuth 2.0 PKCE; verified 2026-07-10 that bookmarks work on plain OAuth 1.0a and only DMs are gated (by app permission level, not PKCE).

**Media upload uses `multipart/form-data`** <!-- updated: 2026-07-16 -->: The v2 media upload endpoint uses multipart/form-data (built via `FormData`, so fetch sets the boundary). With multipart, body params are excluded from the OAuth 1.0a signature per RFC 5849, so `buildOAuthHeader` works with only the `oauth_*` params.

| Key | File | Source |
|-----|------|--------|
| `X_API_KEY` | `~/keys/X_API_KEY.txt` | Console -> Apps -> OAuth 1.0 Keys -> Consumer Key |
| `X_API_SECRET` | `~/keys/X_API_SECRET.txt` | Console -> Apps -> OAuth 1.0 Keys -> Consumer Key Secret |
| `X_ACCESS_TOKEN` | `~/keys/X_ACCESS_TOKEN.txt` | Console -> Apps -> OAuth 1.0 Keys -> Access Token |
| `X_ACCESS_TOKEN_SECRET` | `~/keys/X_ACCESS_TOKEN_SECRET.txt` | Console -> Apps -> OAuth 1.0 Keys -> Access Token Secret |

**Known issue (Mar 31, 2026):** Search endpoint returns 401 while single tweet reads and profile reads work fine. May need key regeneration or be a platform-side regression. Single tweet/thread/profile commands unaffected. <!-- added: 2026-03-31 -->

**402 CreditsDepleted → use the browser path** <!-- added: 2026-05-23 -->: When the pay-per-use project runs out of credits, EVERY call (reads AND writes) returns `402 {"title":"CreditsDepleted"}` — it's project-level, not per-account, so there's no API workaround but a top-up. To post anyway (as the user's real signed-in account), use the `x-browser-post` skill: Claude-in-Chrome drives the live Chrome for text + Post, and a CDP `DOM.setFileInputFiles` script handles video/image attach (CIC's own file_upload is blocked on x.com). Verified 2026-05-23.

**Verified state (2026-06-30): credits depleted + DM/bookmark auth gaps** <!-- added: 2026-06-30 -->: Live probe — `bookmarks` → **402 credits depleted** (the whole pay-per-use pool is empty; reads AND writes are dead until a top-up at https://console.x.com — no code/auth fix possible). `dms` → **403 oauth1-permissions** (`"client app is not configured with the appropriate oauth1 app permissions for this endpoint"`): the DM endpoints do NOT work under the current OAuth 1.0a app permission level (the 403 fires before billing, so it's a real gap independent of the 402). Fix is EITHER (a) raise the dev app to "Read, Write, and Direct Messages" in console.x.com → **regenerate the OAuth 1.0a access token** (the existing token still carries the old scope — changing app permission level without regenerating the token does nothing), OR (b) migrate DMs to OAuth 2.0 PKCE. **Bookmarks**: initially assumed to require OAuth 2.0 PKCE — **FALSE for this pay-per-use account** (see UPDATE below).

**UPDATE — verified live 2026-07-10 (after a $5 top-up)** <!-- added: 2026-07-10 -->: `tweet 20` → 200 (credits live, the 402 is cleared). **`bookmarks` → 200, returned real bookmarks on plain OAuth 1.0a** — the old PKCE requirement is relaxed on pay-per-use, so there is **no bookmarks gap and no PKCE module needed**. `dms` → still **403 oauth1-permissions** — the ONLY remaining gap, and it too needs **no PKCE**: raise `mac-mcp-app` to "Read, Write, and Direct Messages" in console.x.com → **regenerate the OAuth 1.0a access token** (an unregenerated token keeps the old scope). Net verified state: everything works on OAuth 1.0a except DMs, which need a console permission bump, not new auth code. (Probe cost ~$0.02.)

**X MCP (api.x.com/mcp · xdevplatform/xmcp) — borrow, don't replace** <!-- added: 2026-06-30 -->: X shipped an official MCP server — 200+ X API endpoints as MCP tools (incl. writes: `createPosts`, likes, reposts, bookmarks, articles; excludes streaming/webhooks), OAuth 2.0 PKCE with auto-refresh via the `xurl` bridge, `X_API_TOOL_ALLOWLIST` to load a subset. It rides the **same** pay-per-use credit pool + dev app + rate limits as this CLI, so it does NOT fix the 402 and is an interface swap, not a cost/capability leap. Keep this CLI as the daily driver — on-demand (zero standing MCP-memory cost) + per-call `$` instrumentation, which the MCP hides. The auth win once claimed here — "PKCE unlocks bookmarks/DMs" — has largely **evaporated** (verified 2026-07-10: bookmarks work on plain OAuth 1.0a, and DMs need only an app-permission bump, not PKCE), so there's no compelling auth reason to adopt the MCP either. If ever adopting `xmcp`, add it on-demand and `X_API_TOOL_ALLOWLIST`-scoped, not always-on. Does NOT overlap with `/grok` (Grok-native search, no credits), `x-browser-post` (real-account browser writes, the 402 fallback), scrape-creators / Bright Data `web_data_x_*` (no-X-auth scraping), or `x-posting` (writing craft) — keep all of those.

<!-- last-verified: 2026-03-04 -->
**Console**: https://console.x.com/accounts (NOT the old developer.x.com portal)
**App**: mac-mcp-app (Pay Per Use, app ID 32419503)

The app needs **Read and Write** permissions (not just Read). Set under Apps -> mac-mcp-app -> Authentication settings.

**Gotcha**: Consumer Key is server-side masked even when "Show" is clicked. Must click "Regenerate" to see the full value. Same for Access Token - click "Generate" to create with current permissions.

**Bearer token (`X_BEARER_TOKEN`)** is no longer used but the file remains at `~/keys/X_BEARER_TOKEN.txt`. If X fixes the Pay Per Use bearer token bug in the future, reads could be switched back for simpler auth.

## Platform behavior notes (2026) <!-- last-verified: 2026-07-16 -->

**Reply-summon restriction (2026-02-23).** Programmatic replies via `POST /2/tweets` to **someone else's** post now require the original author to have "summoned" the replying account first, by @mentioning it or quoting one of its posts (docs.x.com/changelog, Feb 23 2026). ⚠️ **Self-reply chains are believed exempt** — when you reply to your own post (which is how `thread-post` builds a thread), you ARE the author, so the summon condition does not apply, and the audit + changelog wording both point that way. But this has **NOT been confirmed with a live post** — treat thread self-chaining as needs-live-verification (see the smoke-test checklist). If a self-reply chain ever 403s on the second tweet, this restriction is the first suspect. A **summoned** reply is also cheaper ($0.010 vs $0.015).

**Search modernization (2026-05-04).** The search endpoints migrated to a new index, which (a) added native precision operators `min_likes:`, `min_replies:`, `min_reposts:` (the CLI now emits these server-side for `--min-likes` / `--quality` / `--min-replies` / `--min-reposts` instead of filtering post-hoc — cheaper and more accurate), (b) **excludes retweets from keyword search results** (so the auto-added `-is:retweet` is now mostly a no-op on recent search, kept for `--archive`), and (c) is associated with the resolution of the long-standing intermittent `503`s. `--min-impressions` has no native operator and stays a post-hoc filter.

**Retry & backoff (2026-07-16).** The API client honors `x-rate-limit-reset` / `Retry-After` on `429` (waits then retries, then applies bounded exponential backoff on `5xx`). Retries are capped to keep a persistent failure from looping forever, and the per-wait sleep is capped at one rate-limit window <!-- cap-basis: retry ceiling = bounded-retry safety limit so a persistent failure can't loop forever (spec asked for 2-3 retries); wait cap = X's rate-limit windows are 15 minutes, so sleeping longer than one window is pointless — an external-limit ceiling, not a quality/scope cap. Both live in the MAX_RETRIES / MAX_RETRY_WAIT_MS constants in lib/api.ts -->. Content-creating POSTs (post/reply/quote/DM/article) deliberately do NOT auto-retry `5xx` — a lost-response `5xx` after a successful write could double-post — but they DO retry `429` (a `429` means the request was never processed). Reads, deletes, and idempotent engagement (like/repost/bookmark/follow) retry both. Thread-level double-posting is prevented separately by `thread-post`'s resumable state file.

## Research Loop (Agentic)

When doing deep research (not just a quick search), follow this loop:

### 1. Decompose the Question into Queries

Turn the research question into 3-5 keyword queries using X search operators:

- **Core query**: Direct keywords for the topic
- **Expert voices**: `from:` specific known experts
- **Pain points**: Keywords like `(broken OR bug OR issue OR migration)`
- **Positive signal**: Keywords like `(shipped OR love OR fast OR benchmark)`
- **Links**: `url:github.com` or `url:` specific domains
- **Noise reduction**: `-is:retweet` (auto-added), add `-is:reply` if needed
- **Crypto spam**: Add `-airdrop -giveaway -whitelist` if crypto topics flooding

### 2. Search and Extract

Run each query via CLI. After each, assess:
- Signal or noise? Adjust operators.
- Key voices worth searching `from:` specifically?
- Threads worth following via `thread` command?
- Linked resources worth deep-diving with `web_fetch`?

### 3. Follow Threads

When a tweet has high engagement or is a thread starter:
```bash
bun run x.ts thread <tweet_id>
```

### 4. Deep-Dive Linked Content

When tweets link to GitHub repos, blog posts, or docs, fetch with `web_fetch`. Prioritize links that:
- Multiple tweets reference
- Come from high-engagement tweets
- Point to technical resources directly relevant to the question

### 5. Synthesize

Group findings by theme, not by query:

```
### [Theme/Finding Title]

[1-2 sentence summary]

- @username: "[key quote]" (NL, NI) [Tweet](url)
- @username2: "[another perspective]" (NL, NI) [Tweet](url)

Resources shared:
- [Resource title](url) -- [what it is]
```

### 6. Save

Use `--save` flag or save manually to `~/.claude/drafts/x-research-{topic-slug}-{YYYY-MM-DD}.md`.

## Refinement Heuristics

- **Too much noise?** Add `-is:reply`, use `--sort likes`, narrow keywords
- **Too few results?** Broaden with `OR`, remove restrictive operators
- **Crypto spam?** Add `-$ -airdrop -giveaway -whitelist`
- **Expert takes only?** Use `from:` or `--min-likes 50`
- **Substance over hot takes?** Search with `has:links`
- **Need older data?** Use `--archive` for full-archive search (all time)

## Heartbeat Integration

On heartbeat, can run `watchlist check` to see if key accounts posted anything notable. Flag to Frank only if genuinely interesting/actionable -- don't report routine tweets.

## Cost Reference

X API is pay-per-use. Every command prints its cost to stderr.

**Per-resource rates (Apr 2026 pricing update, verified 2026-07-16):**

| Resource | Cost | Notes |
|----------|------|-------|
| Post create | **$0.015** | a normal post/reply/quote with no URL |
| **Post containing a URL** | **$0.20** | ⚠️ **13x** the base — isolate links to one self-reply |
| Summoned reply | $0.010 | reply to someone else's post after being summoned |
| Post read | $0.005 | read someone else's post |
| Owned read | $0.001 | read your own post |
| User lookup | $0.010 | look up a user |
| DM create | $0.015 | send a DM |
| DM event read | $0.010 | read a DM event |

Source: the docs.x.com/changelog entry dated Apr 16, 2026, and the docs.x.com pricing page (verified live 2026-07-16). X defers per-endpoint rates to the Developer Console for the authoritative figure.

| Command | Typical cost | Notes |
|---------|-------------|-------|
| `search --quick` | ~$0.50 | 1 page, max 100 tweets |
| `search` (1 page) | ~$0.50 | 100 tweets/page |
| `search --archive` (1 page) | ~$2.50 | 500 tweets/page |
| `search --pages 3` | ~$1.50 | Deep research |
| `profile` | ~$0.51 | 1 user lookup + ~100 tweets |
| `thread` (2 pages) | ~$1.01 | Root tweet + conversation search |
| `tweet` | ~$0.005 | Single post read |
| `watchlist check` (N accounts) | ~$0.51 x N | Profile check per account |
| `post` | ~$0.015 | Post create ($0.20 if it contains a URL) |
| `reply` | ~$0.015 | Reply create ($0.20 if it contains a URL) |
| `quote` | ~$0.015 | Quote create ($0.20 if it contains a URL) |
| `delete` | ~$0.015 | Single tweet delete |
| `thread-post` (N tweets) | ~$0.015 x N | +$0.185 for each tweet carrying a URL |
| `article-draft` / `article-publish` | see console | Article pricing not separately published |
| `like` / `unlike` | ~$0.015 | Engagement action |
| `repost` / `unrepost` | ~$0.015 | Engagement action |
| `follow` / `unfollow` | ~$0.025 | User lookup + follow action |
| `upload` | n/a | Media upload not separately metered |
| `post --media` | ~$0.015 | Post cost (upload not separately metered) |
| `bookmarks` | ~$0.10/20 | $0.005/tweet read |
| `bookmark` / `unbookmark` | ~$0.015 | Engagement action |
| `dm` | ~$0.025 | User lookup ($0.01) + DM create ($0.015) |
| `dms` | ~$0.10/10 | $0.010/event read |
| Cached repeat | $0 | 15min TTL (1hr in quick mode) |

**Cost control rules:**
- Default to `--quick` for pulse checks and exploratory searches
- Only use `--pages 2+` when specifically doing deep research
- Use `--from` to target specific users instead of broad searches
- Avoid `watchlist check` with large watchlists unless explicitly requested
- 24-hour dedup at the API level means re-running the same search within a day costs less

**Pricing provenance (last verified: 2026-07-16):**
Rates confirmed against docs.x.com/x-api/getting-started/pricing and the docs.x.com/changelog
entry dated **Apr 16, 2026** (the update that introduced $0.001 owned reads and the $0.20
URL-post price): $0.015/post create, **$0.20/post-with-URL**, $0.010/summoned reply,
$0.005/post read, $0.001/owned read, $0.010/user lookup, $0.015/DM create, $0.010/DM read.
X's docs defer to the Developer Console for the authoritative per-endpoint rate. To re-verify:
log into https://console.x.com and check credits/billing, or re-read the pricing page + changelog.
If rates change, update the table above AND the single-sourced `COST` constant at the top of `x.ts`.

**Official X API docs**: https://developer.x.com/en/docs/x-api

## File Structure

```
skills/x-api/
├── SKILL.md           (this file)
├── x.ts               (CLI entry point)
├── lib/
│   ├── api.ts         (X API wrapper: search, thread, profile, tweet, post, engagement,
│   │                   articles, v2 media upload, retry/backoff, resumable threads)
│   ├── cache.ts       (file-based cache, 15min TTL)
│   └── format.ts      (Telegram + markdown formatters)
├── data/
│   ├── watchlist.json  (accounts to monitor)
│   └── cache/          (auto-managed)
└── references/
    └── x-api.md        (X API endpoint reference)
```

## Live smoke-test checklist (pending, needs Christo's go-ahead — real posts, real cost) <!-- added: 2026-07-16 -->

The 2026-07-16 freshen-up verified every changed request shape against the live docs and by
construction (TypeScript compiles under bun; the DraftJS builder is unit-checked; all no-cost CLI
paths run). But the following need a **real API call that posts content and spends credits**, so
they were deliberately left for a supervised live run. Do these only with Christo's explicit
go-ahead, on the pay-per-use account with credits topped up. Ordered cheapest-risk first:

1. **Retry behavior (cheap, read-only).** Run a normal `search` / `tweet` read and confirm it still
   returns 200. To exercise the 429 path without abuse, watch stderr for the `[x-api] 429
   rate-limited … retrying` line under natural load. No content posted.
2. **v2 media upload — image.** `upload <small.jpg>` → expect a `media_id_string` printed from the v2
   `data.id`. Then `post "test" --media <small.jpg>` and confirm the image attaches. (~$0.015 + a
   throwaway post to delete.)
3. **v2 media upload — video (chunked).** `upload <short.mp4>` → confirm INIT/APPEND/FINALIZE succeed
   and STATUS polls to `succeeded`, then a post attaches the video. This is the genuinely new
   capability; the chunked flow and the simple-upload `media` field name are the highest-uncertainty
   parts.
4. **Thread self-chaining under the summon restriction.** Post a 2–3 tweet `thread-post`. Confirm the
   second and third tweets chain as self-replies WITHOUT a 403. If the second tweet 403s, the
   2026-02-23 reply-summon restriction is NOT exempt for self-replies and the thread strategy needs a
   rethink. Also confirm the resume state file is written per tweet and removed on success (kill it
   mid-way once and re-run to confirm it resumes rather than double-posts).
5. **Articles draft + publish round trip (Premium account required).** `article-draft --title …
   --file …` → confirm a draft id comes back and the DraftJS body is accepted. Then
   `article-publish <id>` → confirm it publishes with the paragraphs/headers/links intact. **The one
   field to watch:** whether X wants `content_state.entityMap` (what we send) or an `entities` array
   for links. If links render as plain text but the body is otherwise correct, flip that field.

Report results back into this file (dates + verified/failed) and drop the "believed / unverified"
hedges on whatever passes.
