---
name: x-api
description: >
  Programmatic X/Twitter interaction via API. Search, post, reply, quote-tweet, delete,
  thread-post, like, repost, follow, monitor accounts, and research topics.
  Use when: (1) user says "x research", "search x", "search twitter", "post to x",
  "tweet", "reply on x", "check x for", "x search", "/x-api",
  (2) user wants to post tweets, threads, or replies programmatically,
  (3) user is doing research where recent X discourse provides useful context,
  (4) user wants to monitor accounts or find conversations to engage with,
  (5) user wants to like, repost, follow, or otherwise engage on X.
  Supports read (search, profile, thread), write (post, reply, quote, delete, thread-post),
  and engagement (like, unlike, repost, unrepost, follow, unfollow) via OAuth 1.0a.
  Pay-per-use API ($0.01/post, $0.005/read).
  Note: search supports both recent (7 days) and full-archive (all time) via --archive flag.
---

# X Research

General-purpose agentic research over X/Twitter. Decompose any research question into targeted searches, iteratively refine, follow threads, deep-dive linked content, and synthesize into a sourced briefing.

For X API details (endpoints, operators, response format): read `references/x-api.md`.

## CLI Tool

All commands run from this skill directory:

```bash
cd ~/clawd/skills/x-research
source ~/.config/env/global.env
```

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
- `--save` -- save results to `~/clawd/drafts/x-research-{slug}-{date}.md`
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
bun run x.ts thread-post --file <path>
# alias: tp
```

Post a multi-tweet thread from a file. Parses the file by splitting on `## Tweet N` headers (matching the draft format used in `chronicles/x-thread-draft-*.md`). Falls back to `---` separators, then one tweet per line.

Posts the first tweet, then chains each subsequent tweet as a reply with a 1-second delay between posts. Prints each tweet URL as it's posted.

**Example thread file:**
```markdown
## Tweet 1 (Hook)
If you're building with AI agents, here's what I learned this week

## Tweet 2
First insight goes here...

## Tweet 3 (CTA)
Reply if you want to hear more.
```

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

**Read operations** (search, profile, thread, tweet) use `X_BEARER_TOKEN` (app-level, read-only).

**Write and engagement operations** (post, reply, quote, delete, thread-post, like, unlike, repost, unrepost, follow, unfollow) require OAuth 1.0a user credentials:

| Key | File | Source |
|-----|------|--------|
| `X_API_KEY` | `~/keys/X_API_KEY.txt` | Console -> Apps -> OAuth 1.0 Keys -> Consumer Key |
| `X_API_SECRET` | `~/keys/X_API_SECRET.txt` | Console -> Apps -> OAuth 1.0 Keys -> Consumer Key Secret |
| `X_ACCESS_TOKEN` | `~/keys/X_ACCESS_TOKEN.txt` | Console -> Apps -> OAuth 1.0 Keys -> Access Token |
| `X_ACCESS_TOKEN_SECRET` | `~/keys/X_ACCESS_TOKEN_SECRET.txt` | Console -> Apps -> OAuth 1.0 Keys -> Access Token Secret |

<!-- last-verified: 2026-02-17 -->
**Console**: https://console.x.com/accounts (NOT the old developer.x.com portal)
**App**: mac-mcp-app (Pay Per Use, app ID 32419503)

The app needs **Read and Write** permissions (not just Read). Set under Apps -> mac-mcp-app -> Authentication settings.

**Gotcha**: Consumer Key is server-side masked even when "Show" is clicked. Must click "Regenerate" to see the full value. Same for Access Token - click "Generate" to create with current permissions.

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

Use `--save` flag or save manually to `~/clawd/drafts/x-research-{topic-slug}-{YYYY-MM-DD}.md`.

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

X API is pay-per-use ($0.005/tweet read, $0.01/user lookup). Every command prints its cost to stderr.

| Command | Typical cost | Notes |
|---------|-------------|-------|
| `search --quick` | ~$0.50 | 1 page, max 100 tweets |
| `search` (1 page) | ~$0.50 | 100 tweets/page |
| `search --archive` (1 page) | ~$2.50 | 500 tweets/page |
| `search --pages 3` | ~$1.50 | Deep research |
| `profile` | ~$0.51 | 1 user lookup + ~100 tweets |
| `thread` (2 pages) | ~$1.01 | Root tweet + conversation search |
| `tweet` | ~$0.005 | Single tweet |
| `watchlist check` (N accounts) | ~$0.51 x N | Profile check per account |
| `post` | ~$0.01 | Single tweet create |
| `reply` | ~$0.01 | Single reply create |
| `quote` | ~$0.01 | Quote tweet create |
| `delete` | ~$0.01 | Single tweet delete |
| `thread-post` (N tweets) | ~$0.01 x N | Thread posting |
| `like` / `unlike` | ~$0.01 | Engagement action |
| `repost` / `unrepost` | ~$0.01 | Engagement action |
| `follow` / `unfollow` | ~$0.02 | User lookup + follow action |
| Cached repeat | $0 | 15min TTL (1hr in quick mode) |

**Cost control rules:**
- Default to `--quick` for pulse checks and exploratory searches
- Only use `--pages 2+` when specifically doing deep research
- Use `--from` to target specific users instead of broad searches
- Avoid `watchlist check` with large watchlists unless explicitly requested
- 24-hour dedup at the API level means re-running the same search within a day costs less

**Pricing provenance (last verified: 2026-02-15):**
Rates confirmed: $0.005/post read, $0.01/user lookup, $0.01/post create
([Medianama, Feb 2026](https://www.medianama.com/2026/02/223-x-developer-api-pricing-pay-per-use-model/)).
X's official docs defer to the Developer Console for per-endpoint rates rather than publishing
them on docs.x.com. To re-verify: log into https://console.x.com and check credits/billing,
or search for recent coverage of X API pricing changes. If rates change, update the table
above AND the cost calculations in `x.ts` (search for `0.005` and `0.01`).

**Official X API docs**: https://developer.x.com/en/docs/x-api

## File Structure

```
skills/x-api/
├── SKILL.md           (this file)
├── x.ts               (CLI entry point)
├── lib/
│   ├── api.ts         (X API wrapper: search, thread, profile, tweet, post, engagement)
│   ├── cache.ts       (file-based cache, 15min TTL)
│   └── format.ts      (Telegram + markdown formatters)
├── data/
│   ├── watchlist.json  (accounts to monitor)
│   └── cache/          (auto-managed)
└── references/
    └── x-api.md        (X API endpoint reference)
```
