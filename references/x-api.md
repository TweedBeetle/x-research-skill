# X API Reference

**Official docs**: https://developer.x.com/en/docs/x-api

## Authentication

Bearer token from env var `X_BEARER_TOKEN`.

```
-H "Authorization: Bearer $X_BEARER_TOKEN"
```

## Search Endpoints

### Recent Search (last 7 days)
```
GET https://api.x.com/2/tweets/search/recent
```
Covers last 7 days. Max 100 results per request. Available to all developers.

### Full-Archive Search (all time, back to March 2006)
```
GET https://api.x.com/2/tweets/search/all
```
Searches the complete Post archive. Max 500 results per request. Available on **pay-per-use** (same credits as recent search) and Enterprise. Same query operators, same response format. 1,024-char query length (vs 512 for recent).

**Note:** Use `--archive` flag to switch to full-archive search. Available on the same pay-per-use plan, no enterprise access required.

### Standard Query Params

```
tweet.fields=created_at,public_metrics,author_id,conversation_id,entities
expansions=author_id
user.fields=username,name,public_metrics
max_results=100
```

Add `sort_order=relevancy` for relevance ranking (default is recency).

Paginate with `next_token` from response `meta.next_token`.

### Search Operators

| Operator | Example | Notes |
|----------|---------|-------|
| keyword | `bun 2.0` | Implicit AND |
| `OR` | `bun OR deno` | Must be uppercase |
| `-` | `-is:retweet` | Negation |
| `()` | `(fast OR perf)` | Grouping |
| `from:` | `from:elonmusk` | Posts by user |
| `to:` | `to:elonmusk` | Replies to user |
| `#` | `#buildinpublic` | Hashtag |
| `$` | `$AAPL` | Cashtag |
| `lang:` | `lang:en` | BCP-47 language code |
| `is:retweet` | `-is:retweet` | Filter retweets |
| `is:reply` | `-is:reply` | Filter replies |
| `is:quote` | `is:quote` | Quote tweets |
| `has:media` | `has:media` | Contains media |
| `has:links` | `has:links` | Contains links |
| `url:` | `url:github.com` | Links to domain |
| `conversation_id:` | `conversation_id:123` | Thread by root tweet ID |
| `place_country:` | `place_country:US` | Country filter |
| `min_likes:` | `min_likes:10` | Min likes (native, added 2026-05-04) |
| `min_replies:` | `min_replies:5` | Min replies (native, added 2026-05-04) |
| `min_reposts:` | `min_reposts:5` | Min reposts (native, added 2026-05-04) |

**Engagement operators (`min_likes:` / `min_replies:` / `min_reposts:`) became native with the 2026-05-04 search index migration** — filter server-side rather than post-hoc. There is no native operator for impressions; filter that one post-hoc from `public_metrics`. The same migration **excludes retweets from keyword search results** (an explicit `-is:retweet` is now largely redundant on recent search).

**Limits:** Max query length 512 chars for recent search, 1,024 for full-archive (4,096 for Enterprise).

### Response Structure

```json
{
  "data": [{
    "id": "tweet_id",
    "text": "...",
    "author_id": "user_id",
    "created_at": "2026-...",
    "conversation_id": "root_tweet_id",
    "public_metrics": {
      "retweet_count": 0,
      "reply_count": 0,
      "like_count": 0,
      "quote_count": 0,
      "bookmark_count": 0,
      "impression_count": 0
    },
    "entities": {
      "urls": [{"expanded_url": "https://..."}],
      "mentions": [{"username": "..."}],
      "hashtags": [{"tag": "..."}]
    }
  }],
  "includes": {
    "users": [{"id": "user_id", "username": "handle", "name": "Display Name", "public_metrics": {...}}]
  },
  "meta": {"next_token": "...", "result_count": 100}
}
```

### Constructing Tweet URLs

```
https://x.com/{username}/status/{tweet_id}
```

Both values available from response data + user expansions.

### Linked Content

External URLs from tweets are in `entities.urls[].expanded_url`. Use WebFetch to deep-dive into linked pages (GitHub READMEs, blog posts, docs, etc.).

### Rate Limits

With pay-per-use pricing (Feb 2026+), rate limits are primarily controlled by spending limits you set in the Developer Console, not fixed per-window caps. The old 450/300 requests-per-15-min limits from the subscription model may no longer apply. If you hit a 429 error, the `x-rate-limit-reset` header tells you when to retry.

The skill uses a 350ms delay between requests as a safety buffer.

### Cost (Pay-Per-Use — Updated Apr 2026, verified 2026-07-16)

X API uses **pay-per-use pricing** with prepaid credits. No subscriptions, no monthly caps.

**Per-resource costs (Apr 16, 2026 pricing update):**
| Resource | Cost |
|----------|------|
| Post create | $0.015 |
| **Post containing a URL** | **$0.20** (⚠️ 13x) |
| Summoned reply | $0.010 |
| Post read | $0.005 |
| Owned read | $0.001 |
| User lookup | $0.010 |
| DM create | $0.015 |
| DM event read | $0.010 |

⚠️ **A post that contains a URL costs $0.20 — 13x the $0.015 base.** Isolate links to a single self-reply so only one post in a thread pays the penalty (and the hook keeps both its low cost and its reach).

A typical research session: 5 queries × 100 tweets = 500 post reads = ~$2.50.

**24-hour deduplication:** Same post requested multiple times within a UTC day = 1 charge. Re-running the same search within 24h costs significantly less.

**Billing details:**
- Purchase credits upfront at [console.x.com](https://console.x.com)
- Set auto-recharge (trigger amount + threshold) to avoid interruptions
- Set spending limits per billing cycle
- Failed requests are not billed
- Streaming (Filtered Stream): each unique post delivered counts, with 24h dedup

**Usage monitoring endpoint:**
```
GET https://api.x.com/2/usage/tweets
Authorization: Bearer $BEARER_TOKEN
```
Returns daily post consumption counts per app. Use for budget tracking and alerts.

**xAI credit bonus:**
| Cumulative spend (per cycle) | xAI credit rate |
|------------------------------|-----------------|
| $0 – $199 | 0% |
| $200 – $499 | 10% |
| $500 – $999 | 15% |
| $1,000+ | 20% |

Credits are rolling — order/size of purchases doesn't affect total rewards.

**Tracked endpoints (all count toward usage):**
- Post lookup, Recent search, Full-archive search
- Filtered stream, Filtered stream webhooks
- User posts/mentions timelines
- Liked posts, Bookmarks, List posts, Spaces lookup

## Single Tweet Lookup

```
GET https://api.x.com/2/tweets/{id}
```

Same fields/expansions params. Use for fetching specific tweets by ID.

## Engagement Endpoints

All require OAuth 1.0a authentication and the authenticated user's ID (from `GET /2/users/me`).

### Likes

```
POST   https://api.x.com/2/users/{user_id}/likes          body: {"tweet_id": "..."}
DELETE https://api.x.com/2/users/{user_id}/likes/{tweet_id}
```

### Reposts (Retweets)

```
POST   https://api.x.com/2/users/{user_id}/retweets          body: {"tweet_id": "..."}
DELETE https://api.x.com/2/users/{user_id}/retweets/{tweet_id}
```

### Follows

```
POST   https://api.x.com/2/users/{user_id}/following          body: {"target_user_id": "..."}
DELETE https://api.x.com/2/users/{user_id}/following/{target_user_id}
```

Requires looking up the target user ID first via `GET /2/users/by/username/{username}`.

## Media Upload (v2)

Uses the **v2 `POST /2/media/upload`** endpoint. OAuth 1.0a required. The legacy v1.1
`upload.twitter.com/1.1/media/upload.json` endpoint was **sunset 2025-06-09**.

**Simple (single-request) — images and small GIFs:**
```
POST https://api.x.com/2/media/upload
Content-Type: multipart/form-data

media=<binary file>
media_category=tweet_image   (or tweet_gif)
```

**Chunked — video (and any large file), passing `command` as a multipart field:**
```
INIT      command=INIT  media_type=video/mp4  total_bytes=<n>  media_category=tweet_video
APPEND    command=APPEND  media_id=<id>  segment_index=<i>  media=<chunk>   (repeat, 4MB chunks)
FINALIZE  command=FINALIZE  media_id=<id>
STATUS    GET ?command=STATUS&media_id=<id>   (poll processing_info.state until succeeded/failed)
```

**Supported types:** images JPEG/PNG/GIF/WebP (max 5MB, 15MB GIF), video MP4/MOV (max 512MB, chunked).

**Response** (both paths — the media id is in `data.id`):
```json
{
  "data": {
    "id": "710511363345354753",
    "media_key": "...",
    "expires_after_secs": 86400,
    "processing_info": { "state": "succeeded" }
  }
}
```

The code falls back to a legacy top-level `media_id_string` if present.

**Attaching to tweets:** Include `media_id_string` in the tweet creation body:
```json
{
  "text": "Tweet with image",
  "media": {
    "media_ids": ["710511363345354753"]
  }
}
```

Media IDs expire after 24 hours if not attached to a tweet.

**OAuth note:** For multipart/form-data uploads, OAuth signature excludes body params (only signs the URL + OAuth params). For `application/x-www-form-urlencoded`, same rule applies with base64-encoded data.

## Bookmarks

All require OAuth 1.0a (or OAuth 2.0 PKCE - historically PKCE-only, may have changed with pay-per-use).

### List Bookmarks

```
GET https://api.x.com/2/users/{user_id}/bookmarks
```

Standard tweet fields/expansions params. Returns bookmarked tweets for the authenticated user.

### Add Bookmark

```
POST https://api.x.com/2/users/{user_id}/bookmarks
body: {"tweet_id": "..."}
```

### Remove Bookmark

```
DELETE https://api.x.com/2/users/{user_id}/bookmarks/{tweet_id}
```

## Articles (long-form)

Launched **2026-06-11**. Authoring requires an X **Premium** account. No edit/delete endpoints yet.

### Create Draft

```
POST https://api.x.com/2/articles/draft
body: { "title": "...", "content_state": { "blocks": [...], "entityMap": {...} } }
```

`content_state` is a DraftJS content state. Block `type` values used by the CLI's builder:
`unstyled` (paragraph), `header-one` / `header-two` / `header-three`, `unordered-list-item`.
Inline links are DraftJS entities (`entityRanges` on the block referencing `entityMap` keys).
Response carries the new article id in `data.id`.

### Publish

```
POST https://api.x.com/2/articles/{article_id}/publish
(no body)
```

⚠️ The exact `content_state` shape for links (keyed `entityMap` vs an `entities` array) is
verified against docs but not yet by a live round trip — see the SKILL.md smoke-test checklist.

## Reply-Summon Restriction (2026-02-23)

Programmatic replies via `POST /2/tweets` to **another account's** post require the original
author to have summoned the replier (by @mentioning it or quoting one of its posts). Self-reply
chains (a thread on your own posts) are believed exempt but unverified.

## Direct Messages

All require OAuth 1.0a (or OAuth 2.0 PKCE - historically PKCE-only).

### Send DM

```
POST https://api.x.com/2/dm_conversations/with/{participant_user_id}/messages
body: {"text": "Hello!"}
```

Creates a new conversation with the user (or sends in existing 1-on-1 conversation).

**Response:**
```json
{
  "data": {
    "dm_conversation_id": "...",
    "dm_event_id": "..."
  }
}
```

### List DM Events

```
GET https://api.x.com/2/dm_events
dm_event.fields=id,text,event_type,dm_conversation_id,created_at,sender_id
expansions=sender_id
user.fields=username,name
max_results=20
```

Returns DM events across all conversations for the authenticated user.

### List Conversation Events

```
GET https://api.x.com/2/dm_conversations/{dm_conversation_id}/dm_events
```

Same fields/expansions as above. Returns events for a specific conversation.

### DM Event Types

- `MessageCreate` - a text message
- `ParticipantsJoin` - user(s) joined a group conversation
- `ParticipantsLeave` - user(s) left a group conversation

### User Lookup

```
GET https://api.x.com/2/users/by/username/{username}
```

Returns user ID and profile info. Used by DM and follow commands to resolve `@username` to a user ID.
