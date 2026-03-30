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

**Not available as search operators:** `min_likes`, `min_retweets`, `min_replies`. Filter engagement post-hoc from `public_metrics`.

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

### Cost (Pay-Per-Use — Updated Feb 2026)

X API uses **pay-per-use pricing** with prepaid credits. No subscriptions, no monthly caps.

**Per-resource costs:**
| Resource | Cost |
|----------|------|
| Post read | $0.005 |
| User lookup | $0.010 |
| Post create | $0.010 |

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

## Media Upload (v1.1)

Uses the v1.1 upload endpoint (not v2). OAuth 1.0a required.

```
POST https://upload.twitter.com/1.1/media/upload.json
Content-Type: application/x-www-form-urlencoded

media_data=<base64-encoded-file>&media_category=tweet_image
```

**Supported types:** JPEG, PNG, GIF (non-animated and animated), WebP
**Max size:** 5MB for images (video requires chunked upload, not implemented)

**Response:**
```json
{
  "media_id": 710511363345354753,
  "media_id_string": "710511363345354753",
  "size": 11065,
  "expires_after_secs": 86400,
  "image": {
    "image_type": "image/jpeg",
    "w": 800,
    "h": 418
  }
}
```

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
