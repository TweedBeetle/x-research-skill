/**
 * X API wrapper — search, threads, profiles, single tweets, posting, engagement.
 * All operations use OAuth 1.0a: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
 *
 * MIGRATION NOTE (2026-03-04): Bearer token auth was replaced with OAuth 1.0a for reads
 * because Pay Per Use accounts have a known X platform bug where bearer tokens return
 * 403 "client_id not attached to a Project". OAuth 2.0 bearer tokens are simpler (no
 * per-request signing) and should be preferred when the bug is fixed.
 *
 * To check if fixed:
 *   curl -H "Authorization: Bearer $(cat ~/keys/X_BEARER_TOKEN.txt)" \
 *     "https://api.x.com/2/tweets/search/recent?query=test&max_results=10"
 *   If you get 200 instead of 403, bearer tokens work again.
 *
 * To revert to bearer token reads:
 *   1. In apiGet(), replace the OAuth 1.0a block with:
 *        const token = getEnv("X_BEARER_TOKEN");
 *        const res = await fetch(url, {
 *          headers: { Authorization: `Bearer ${token}` },
 *        });
 *   2. Update the file header comment above
 *   3. Update SKILL.md auth section and CHANGELOG.md
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { createHmac, randomBytes } from "crypto";
import { basename, extname } from "path";

const BASE = "https://api.x.com/2";
const RATE_DELAY_MS = 350; // stay under 450 req/15min

// Retry/backoff (added 2026-07-16). 429s honor the reset header; transient 5xx
// get bounded exponential backoff. Content-creating POSTs opt OUT of 5xx retry
// (a lost-response 5xx could double-post) — 429 is still retried for them since
// a 429 means the request was never processed. Reads/deletes/engagement (idempotent)
// retry both. Thread-level double-posting is guarded separately by postThread's resume state.
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_RETRY_WAIT_MS = 15 * 60_000; // never sleep longer than one 15-min window

function readEnvFile(): Record<string, string> {
  const vars: Record<string, string> = {};
  // Try ~/keys/ directory (each file is KEY_NAME.txt containing the value)
  try {
    const keysDir = `${process.env.HOME}/keys`;
    const { readdirSync } = require("fs");
    for (const file of readdirSync(keysDir)) {
      if (file.endsWith(".txt")) {
        const key = file.replace(".txt", "");
        vars[key] = readFileSync(`${keysDir}/${file}`, "utf-8").trim();
      }
    }
  } catch {}
  return vars;
}

const envCache = readEnvFile();

function getEnv(key: string): string | undefined {
  return process.env[key] || envCache[key];
}

function getToken(): string {
  const token = getEnv("X_BEARER_TOKEN");
  if (token) return token;
  throw new Error("X_BEARER_TOKEN not found in env or ~/keys/");
}

interface OAuthCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

function getOAuthCreds(): OAuthCreds {
  const apiKey = getEnv("X_API_KEY");
  const apiSecret = getEnv("X_API_SECRET");
  const accessToken = getEnv("X_ACCESS_TOKEN");
  const accessTokenSecret = getEnv("X_ACCESS_TOKEN_SECRET");

  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
    const missing = [
      !apiKey && "X_API_KEY",
      !apiSecret && "X_API_SECRET",
      !accessToken && "X_ACCESS_TOKEN",
      !accessTokenSecret && "X_ACCESS_TOKEN_SECRET",
    ].filter(Boolean);
    throw new Error(
      `OAuth 1.0a credentials missing: ${missing.join(", ")}. ` +
      `Store in ~/keys/ as .txt files or set as env vars. ` +
      `Generate at https://developer.x.com/en/portal/projects-and-apps`
    );
  }

  return { apiKey, apiSecret, accessToken, accessTokenSecret };
}

function encodeRFC3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function buildOAuthHeader(
  method: string,
  url: string,
  creds: OAuthCreds,
  fullUrl?: string
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  // Include query params in signature (required by OAuth 1.0a)
  const allParams: Record<string, string> = { ...oauthParams };
  const queryUrl = fullUrl || url;
  const qIdx = queryUrl.indexOf("?");
  if (qIdx !== -1) {
    const searchParams = new URLSearchParams(queryUrl.slice(qIdx + 1));
    for (const [k, v] of searchParams) {
      allParams[k] = v;
    }
  }

  // Signature base string: sorted params
  const sortedParams = Object.keys(allParams)
    .sort()
    .map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(allParams[k])}`)
    .join("&");
  const baseUrl = url.split("?")[0];
  const baseString = `${method}&${encodeRFC3986(baseUrl)}&${encodeRFC3986(sortedParams)}`;
  const signingKey = `${encodeRFC3986(creds.apiSecret)}&${encodeRFC3986(creds.accessTokenSecret)}`;
  const signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  oauthParams.oauth_signature = signature;

  const header = Object.keys(oauthParams)
    .sort()
    .map((k) => `${encodeRFC3986(k)}="${encodeRFC3986(oauthParams[k])}"`)
    .join(", ");
  return `OAuth ${header}`;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * fetch() with rate-limit and transient-error handling.
 * - 429: waits for x-rate-limit-reset (epoch secs) or Retry-After (secs), then retries.
 * - 5xx: bounded exponential backoff with jitter, but only when retryOn5xx is set.
 * The initFactory is called fresh per attempt so each retry gets a new OAuth nonce/timestamp.
 * On exhausting retries the last Response is returned so the caller surfaces the real error body.
 */
async function fetchWithRetry(
  url: string,
  initFactory: () => RequestInit,
  opts: { retryOn5xx?: boolean; label?: string } = {}
): Promise<Response> {
  const label = opts.label ? ` (${opts.label})` : "";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, initFactory());
    const isLast = attempt >= MAX_RETRIES;

    if (res.status === 429 && !isLast) {
      const reset = res.headers.get("x-rate-limit-reset");
      const retryAfter = res.headers.get("retry-after");
      let waitMs: number;
      if (reset) waitMs = parseInt(reset) * 1000 - Date.now();
      else if (retryAfter) waitMs = parseInt(retryAfter) * 1000;
      else waitMs = BASE_BACKOFF_MS * 2 ** attempt;
      waitMs = Math.min(Math.max(waitMs, 1000), MAX_RETRY_WAIT_MS);
      console.error(
        `[x-api] 429 rate-limited${label}; waiting ${Math.round(waitMs / 1000)}s then retrying (${attempt + 1}/${MAX_RETRIES})`
      );
      await sleep(waitMs);
      continue;
    }

    if (res.status >= 500 && opts.retryOn5xx && !isLast) {
      const waitMs = Math.min(
        BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 250),
        MAX_RETRY_WAIT_MS
      );
      console.error(
        `[x-api] ${res.status} server error${label}; retrying in ${Math.round(waitMs / 1000)}s (${attempt + 1}/${MAX_RETRIES})`
      );
      await sleep(waitMs);
      continue;
    }

    return res;
  }
}

export interface Tweet {
  id: string;
  text: string;
  author_id: string;
  username: string;
  name: string;
  created_at: string;
  conversation_id: string;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    quotes: number;
    impressions: number;
    bookmarks: number;
  };
  urls: string[];
  mentions: string[];
  hashtags: string[];
  tweet_url: string;
}

interface RawResponse {
  data?: any[];
  includes?: { users?: any[] };
  meta?: { next_token?: string; result_count?: number };
  errors?: any[];
  title?: string;
  detail?: string;
  status?: number;
}

function parseTweets(raw: RawResponse): Tweet[] {
  if (!raw.data) return [];
  const users: Record<string, any> = {};
  for (const u of raw.includes?.users || []) {
    users[u.id] = u;
  }

  return raw.data.map((t: any) => {
    const u = users[t.author_id] || {};
    const m = t.public_metrics || {};
    return {
      id: t.id,
      text: t.text,
      author_id: t.author_id,
      username: u.username || "?",
      name: u.name || "?",
      created_at: t.created_at,
      conversation_id: t.conversation_id,
      metrics: {
        likes: m.like_count || 0,
        retweets: m.retweet_count || 0,
        replies: m.reply_count || 0,
        quotes: m.quote_count || 0,
        impressions: m.impression_count || 0,
        bookmarks: m.bookmark_count || 0,
      },
      urls: (t.entities?.urls || [])
        .map((u: any) => u.expanded_url)
        .filter(Boolean),
      mentions: (t.entities?.mentions || [])
        .map((m: any) => m.username)
        .filter(Boolean),
      hashtags: (t.entities?.hashtags || [])
        .map((h: any) => h.tag)
        .filter(Boolean),
      tweet_url: `https://x.com/${u.username || "?"}/status/${t.id}`,
    };
  });
}

const FIELDS =
  "tweet.fields=created_at,public_metrics,author_id,conversation_id,entities&expansions=author_id&user.fields=username,name,public_metrics";

/**
 * Parse a "since" value into an ISO 8601 timestamp.
 * Accepts: "1h", "2h", "6h", "12h", "1d", "2d", "3d", "7d"
 * Or a raw ISO 8601 string.
 */
function parseSince(since: string): string | null {
  // Check for shorthand like "1h", "3h", "1d"
  const match = since.match(/^(\d+)(m|h|d)$/);
  if (match) {
    const num = parseInt(match[1]);
    const unit = match[2];
    const ms =
      unit === "m" ? num * 60_000 :
      unit === "h" ? num * 3_600_000 :
      num * 86_400_000;
    const startTime = new Date(Date.now() - ms);
    return startTime.toISOString();
  }

  // Check if it's already ISO 8601
  if (since.includes("T") || since.includes("-")) {
    try {
      return new Date(since).toISOString();
    } catch {
      return null;
    }
  }

  return null;
}

async function apiGet(url: string): Promise<RawResponse> {
  // Use OAuth 1.0a for all reads (bearer token broken on Pay Per Use accounts).
  // Reads are idempotent, so 5xx retries are safe. 429s are honored via the reset header.
  const creds = getOAuthCreds();
  const baseUrl = url.split("?")[0];
  const res = await fetchWithRetry(
    url,
    () => ({ headers: { Authorization: buildOAuthHeader("GET", baseUrl, creds, url) } }),
    { retryOn5xx: true, label: "GET" }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X API ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Search tweets. Uses recent search (last 7 days) by default.
 * Pass archive: true for full-archive search (all time, back to March 2006).
 * Full-archive uses /2/tweets/search/all (same pay-per-use credits, max 500 results/page).
 */
export async function search(
  query: string,
  opts: {
    maxResults?: number;
    pages?: number;
    sortOrder?: "relevancy" | "recency";
    since?: string; // ISO 8601 timestamp or shorthand like "1h", "3h", "1d"
    archive?: boolean;
  } = {}
): Promise<Tweet[]> {
  const endpoint = opts.archive ? "tweets/search/all" : "tweets/search/recent";
  const maxPerPage = opts.archive ? 500 : 100;
  const maxResults = Math.max(Math.min(opts.maxResults || maxPerPage, maxPerPage), 10);
  const pages = opts.pages || 1;
  const sort = opts.sortOrder || "relevancy";
  const encoded = encodeURIComponent(query);

  // Build time filter
  let timeFilter = "";
  if (opts.since) {
    const startTime = parseSince(opts.since);
    if (startTime) {
      timeFilter = `&start_time=${startTime}`;
    }
  }

  let allTweets: Tweet[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < pages; page++) {
    const pagination = nextToken
      ? `&pagination_token=${nextToken}`
      : "";
    const url = `${BASE}/${endpoint}?query=${encoded}&max_results=${maxResults}&${FIELDS}&sort_order=${sort}${timeFilter}${pagination}`;

    const raw = await apiGet(url);
    const tweets = parseTweets(raw);
    allTweets.push(...tweets);

    nextToken = raw.meta?.next_token;
    if (!nextToken) break;
    if (page < pages - 1) await sleep(RATE_DELAY_MS);
  }

  return allTweets;
}

/**
 * Fetch a full conversation thread by root tweet ID.
 */
export async function thread(
  conversationId: string,
  opts: { pages?: number } = {}
): Promise<Tweet[]> {
  const query = `conversation_id:${conversationId}`;
  const tweets = await search(query, {
    pages: opts.pages || 2,
    sortOrder: "recency",
  });

  // Also fetch the root tweet
  try {
    const rootUrl = `${BASE}/tweets/${conversationId}?${FIELDS}`;
    const raw = await apiGet(rootUrl);
    const rootTweets = parseTweets({ ...raw, data: raw.data ? [raw.data] : (raw as any).id ? [raw] : [] });
    // Fix: single tweet lookup returns tweet at top level
    if ((raw as any).id) {
      // raw is the tweet itself — need to re-fetch with proper structure
    }
    if (rootTweets.length > 0) {
      tweets.unshift(...rootTweets);
    }
  } catch {
    // Root tweet might be deleted
  }

  return tweets;
}

/**
 * Get recent tweets from a specific user.
 */
export async function profile(
  username: string,
  opts: { count?: number; includeReplies?: boolean } = {}
): Promise<{ user: any; tweets: Tweet[] }> {
  // First, look up user ID
  const userUrl = `${BASE}/users/by/username/${username}?user.fields=public_metrics,description,created_at`;
  const userData = await apiGet(userUrl);
  
  if (!userData.data) {
    throw new Error(`User @${username} not found`);
  }

  const user = (userData as any).data;
  await sleep(RATE_DELAY_MS);

  // Build search query
  const replyFilter = opts.includeReplies ? "" : " -is:reply";
  const query = `from:${username} -is:retweet${replyFilter}`;
  const tweets = await search(query, {
    maxResults: Math.min(opts.count || 20, 100),
    sortOrder: "recency",
  });

  return { user, tweets };
}

/**
 * Fetch a single tweet by ID.
 */
export async function getTweet(tweetId: string): Promise<Tweet | null> {
  const url = `${BASE}/tweets/${tweetId}?${FIELDS}`;
  const raw = await apiGet(url);

  // Single tweet returns { data: {...}, includes: {...} }
  if (raw.data && !Array.isArray(raw.data)) {
    const parsed = parseTweets({ ...raw, data: [raw.data] });
    return parsed[0] || null;
  }
  return null;
}

/**
 * Sort tweets by engagement metric.
 */
export function sortBy(
  tweets: Tweet[],
  metric: "likes" | "impressions" | "retweets" | "replies" = "likes"
): Tweet[] {
  return [...tweets].sort((a, b) => b.metrics[metric] - a.metrics[metric]);
}

/**
 * Filter tweets by minimum engagement.
 */
export function filterEngagement(
  tweets: Tweet[],
  opts: { minLikes?: number; minImpressions?: number }
): Tweet[] {
  return tweets.filter((t) => {
    if (opts.minLikes && t.metrics.likes < opts.minLikes) return false;
    if (opts.minImpressions && t.metrics.impressions < opts.minImpressions)
      return false;
    return true;
  });
}

/**
 * Deduplicate tweets by ID.
 */
export function dedupe(tweets: Tweet[]): Tweet[] {
  const seen = new Set<string>();
  return tweets.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

// --- Write operations (OAuth 1.0a) ---

export interface PostResult {
  id: string;
  text: string;
  tweet_url: string;
}

async function apiPostOAuth(
  url: string,
  body: Record<string, any>,
  opts: { retryOn5xx?: boolean } = {}
): Promise<any> {
  // Default: do NOT retry 5xx for content-creating POSTs (a lost-response 5xx after a
  // successful write would double-post). Callers that are idempotent (like/repost/bookmark/
  // follow) opt in with retryOn5xx. 429 is always retried (request never processed).
  const creds = getOAuthCreds();
  const res = await fetchWithRetry(
    url,
    () => ({
      method: "POST",
      headers: {
        Authorization: buildOAuthHeader("POST", url, creds),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    { retryOn5xx: opts.retryOn5xx ?? false, label: "POST" }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X API ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json();
}

async function apiDeleteOAuth(url: string): Promise<any> {
  // Deletes are idempotent, so retrying transient 5xx is safe.
  const creds = getOAuthCreds();
  const res = await fetchWithRetry(
    url,
    () => ({ method: "DELETE", headers: { Authorization: buildOAuthHeader("DELETE", url, creds) } }),
    { retryOn5xx: true, label: "DELETE" }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X API ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json();
}

/**
 * Post a new tweet. Optionally attach media by passing mediaIds.
 */
export async function createTweet(
  text: string,
  opts?: { mediaIds?: string[] }
): Promise<PostResult> {
  const url = `${BASE}/tweets`;
  const body: Record<string, any> = { text };
  if (opts?.mediaIds?.length) {
    body.media = { media_ids: opts.mediaIds };
  }
  const result = await apiPostOAuth(url, body);
  const id = result.data?.id;
  // Get username for URL (need to look up authenticated user)
  const username = await getAuthenticatedUsername();
  return {
    id,
    text: result.data?.text || text,
    tweet_url: `https://x.com/${username}/status/${id}`,
  };
}

/**
 * Reply to an existing tweet. Optionally attach media.
 */
export async function replyToTweet(
  text: string,
  inReplyToId: string,
  opts?: { mediaIds?: string[] }
): Promise<PostResult> {
  const url = `${BASE}/tweets`;
  const body: Record<string, any> = {
    text,
    reply: { in_reply_to_tweet_id: inReplyToId },
  };
  if (opts?.mediaIds?.length) {
    body.media = { media_ids: opts.mediaIds };
  }
  const result = await apiPostOAuth(url, body);
  const id = result.data?.id;
  const username = await getAuthenticatedUsername();
  return {
    id,
    text: result.data?.text || text,
    tweet_url: `https://x.com/${username}/status/${id}`,
  };
}

/**
 * Quote tweet (retweet with comment). Optionally attach media.
 */
export async function quoteTweet(
  text: string,
  quotedTweetUrl: string,
  opts?: { mediaIds?: string[] }
): Promise<PostResult> {
  const url = `${BASE}/tweets`;
  const body: Record<string, any> = {
    text,
    quote_tweet_id: extractTweetId(quotedTweetUrl),
  };
  if (opts?.mediaIds?.length) {
    body.media = { media_ids: opts.mediaIds };
  }
  const result = await apiPostOAuth(url, body);
  const id = result.data?.id;
  const username = await getAuthenticatedUsername();
  return {
    id,
    text: result.data?.text || text,
    tweet_url: `https://x.com/${username}/status/${id}`,
  };
}

/**
 * Delete a tweet.
 */
export async function deleteTweet(tweetId: string): Promise<boolean> {
  const url = `${BASE}/tweets/${tweetId}`;
  const result = await apiDeleteOAuth(url);
  return result.data?.deleted === true;
}

export function extractTweetId(urlOrId: string): string {
  const match = urlOrId.match(/status\/(\d+)/);
  return match ? match[1] : urlOrId;
}

let _cachedUsername: string | null = null;
let _cachedUserId: string | null = null;

async function apiGetOAuth(url: string): Promise<any> {
  const creds = getOAuthCreds();
  const baseUrl = url.split("?")[0];
  const res = await fetchWithRetry(
    url,
    () => ({ headers: { Authorization: buildOAuthHeader("GET", baseUrl, creds, url) } }),
    { retryOn5xx: true, label: "GET" }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function getAuthenticatedUsername(): Promise<string> {
  if (_cachedUsername) return _cachedUsername;
  const data = await apiGetOAuth(`${BASE}/users/me`).catch(() => null);
  if (!data) return "me";
  _cachedUsername = data.data?.username || "me";
  _cachedUserId = data.data?.id || null;
  return _cachedUsername;
}

async function getAuthenticatedUserId(): Promise<string> {
  if (_cachedUserId) return _cachedUserId;
  const data = await apiGetOAuth(`${BASE}/users/me`);
  _cachedUserId = data.data?.id;
  _cachedUsername = data.data?.username || _cachedUsername;
  if (!_cachedUserId) throw new Error("Could not retrieve authenticated user ID");
  return _cachedUserId;
}

// --- Thread posting ---

export interface ThreadPostState {
  posted: { index: number; id: string; url: string }[];
}

/**
 * Post a multi-tweet thread. The first tweet is posted normally; each subsequent
 * tweet chains as a reply to the previous one.
 *
 * Resumable: pass a stateFile path and each posted tweet's id is persisted as it lands.
 * If a mid-chain post fails, re-running with the same stateFile skips the already-posted
 * tweets and resumes the chain from the last posted id — so a retry never double-posts.
 * Optionally attach media to the first tweet via firstMediaIds.
 */
export async function postThread(
  tweets: string[],
  opts?: {
    firstMediaIds?: string[];
    stateFile?: string;
    onProgress?: (r: PostResult, index: number) => void;
  }
): Promise<PostResult[]> {
  if (tweets.length === 0) throw new Error("No tweets to post");

  // Resume from prior progress if a state file exists.
  let posted: ThreadPostState["posted"] = [];
  if (opts?.stateFile && existsSync(opts.stateFile)) {
    try {
      const state: ThreadPostState = JSON.parse(readFileSync(opts.stateFile, "utf-8"));
      posted = Array.isArray(state.posted) ? state.posted : [];
    } catch {
      posted = [];
    }
  }

  const persist = () => {
    if (opts?.stateFile) {
      writeFileSync(opts.stateFile, JSON.stringify({ posted }, null, 2));
    }
  };

  // Reconstruct results for already-posted tweets (so callers see the full chain).
  const results: PostResult[] = posted.map((p) => ({
    id: p.id,
    text: tweets[p.index] ?? "",
    tweet_url: p.url,
  }));

  const startIndex = posted.length;
  let parentId = posted.length > 0 ? posted[posted.length - 1].id : undefined;

  for (let i = startIndex; i < tweets.length; i++) {
    let r: PostResult;
    if (i === 0 && parentId === undefined) {
      r = await createTweet(tweets[0], { mediaIds: opts?.firstMediaIds });
    } else {
      await sleep(1000); // delay between posts to avoid rate issues
      r = await replyToTweet(tweets[i], parentId!);
    }
    results.push(r);
    posted.push({ index: i, id: r.id, url: r.tweet_url });
    persist();
    parentId = r.id;
    opts?.onProgress?.(r, i);
  }

  return results;
}

// --- Engagement operations ---

/**
 * Like a tweet.
 */
export async function likeTweet(tweetId: string): Promise<void> {
  const userId = await getAuthenticatedUserId();
  const url = `${BASE}/users/${userId}/likes`;
  await apiPostOAuth(url, { tweet_id: tweetId }, { retryOn5xx: true });
}

/**
 * Unlike a tweet.
 */
export async function unlikeTweet(tweetId: string): Promise<void> {
  const userId = await getAuthenticatedUserId();
  const url = `${BASE}/users/${userId}/likes/${tweetId}`;
  await apiDeleteOAuth(url);
}

/**
 * Repost (retweet) a tweet.
 */
export async function repostTweet(tweetId: string): Promise<void> {
  const userId = await getAuthenticatedUserId();
  const url = `${BASE}/users/${userId}/retweets`;
  await apiPostOAuth(url, { tweet_id: tweetId }, { retryOn5xx: true });
}

/**
 * Undo a repost.
 */
export async function unrepostTweet(tweetId: string): Promise<void> {
  const userId = await getAuthenticatedUserId();
  const url = `${BASE}/users/${userId}/retweets/${tweetId}`;
  await apiDeleteOAuth(url);
}

/**
 * Look up a user ID by username. Uses OAuth 1.0a.
 */
export async function getUserId(username: string): Promise<string> {
  const targetData = await apiGetOAuth(`${BASE}/users/by/username/${username}`);
  const targetId = targetData.data?.id;
  if (!targetId) throw new Error(`User @${username} not found`);
  return targetId;
}

/**
 * Follow a user by username.
 */
export async function followUser(username: string): Promise<void> {
  const userId = await getAuthenticatedUserId();
  const targetId = await getUserId(username);
  const url = `${BASE}/users/${userId}/following`;
  await apiPostOAuth(url, { target_user_id: targetId }, { retryOn5xx: true });
}

/**
 * Unfollow a user by username.
 */
export async function unfollowUser(username: string): Promise<void> {
  const userId = await getAuthenticatedUserId();
  const targetId = await getUserId(username);
  const url = `${BASE}/users/${userId}/following/${targetId}`;
  await apiDeleteOAuth(url);
}

// --- Media upload (v2 /2/media/upload, OAuth 1.0a) ---
//
// Migrated 2026-07-16 from the sunset v1.1 endpoint. The legacy
// upload.twitter.com/1.1/media/upload.json was sunset 2025-06-09; all uploads now go
// through POST https://api.x.com/2/media/upload. Images (and small GIFs) use the simple
// single-request path; video (and any file larger than one chunk) uses the chunked
// INIT/APPEND/FINALIZE/STATUS flow, which unlocks video posting.

const V2_MEDIA_UPLOAD = "https://api.x.com/2/media/upload";

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const VIDEO_MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB images / webp
const MAX_GIF_SIZE = 15 * 1024 * 1024; // 15MB GIF
const MAX_VIDEO_SIZE = 512 * 1024 * 1024; // 512MB video
const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB per APPEND segment (under the 5MB per-chunk limit)

export interface MediaUploadResult {
  media_id_string: string;
  media_type: string;
  size: number;
}

function mediaCategoryFor(mimeType: string): string {
  if (mimeType.startsWith("video/")) return "tweet_video";
  if (mimeType === "image/gif") return "tweet_gif";
  return "tweet_image";
}

/** Pull the media id out of a v2 upload response (data.id in v2; media_id_string on the legacy shape). */
function extractMediaId(result: any): string {
  const id =
    result?.data?.id ||
    result?.media_id_string ||
    (result?.media_id != null ? String(result.media_id) : undefined);
  if (!id) {
    throw new Error(`Media upload: no media id in response: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return String(id);
}

async function postMediaForm(url: string, form: FormData, label: string): Promise<any> {
  const creds = getOAuthCreds();
  // multipart body params are excluded from the OAuth 1.0a signature (RFC 5849),
  // so the header only needs oauth_* params; fetch sets the multipart boundary from FormData.
  const res = await fetchWithRetry(
    url,
    () => ({ method: "POST", headers: { Authorization: buildOAuthHeader("POST", url, creds) }, body: form }),
    { retryOn5xx: false, label }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Media upload ${label} ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// JSON (or body-less) POST for the chunked-upload subpath endpoints. JSON bodies, like
// multipart ones, are excluded from the OAuth 1.0a signature.
async function postMediaJson(url: string, body: any | undefined, label: string): Promise<any> {
  const creds = getOAuthCreds();
  const res = await fetchWithRetry(
    url,
    () => ({
      method: "POST",
      headers: {
        Authorization: buildOAuthHeader("POST", url, creds),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { retryOn5xx: false, label }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Media upload ${label} ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Upload a media file for use in tweets.
 * Images/small GIFs: JPEG, PNG, GIF, WebP (max 5MB image, 15MB GIF) via the simple path.
 * Video: MP4, MOV (max 512MB) via the chunked path (also used for any file over one chunk).
 * v2 endpoint POST https://api.x.com/2/media/upload (OAuth 1.0a).
 */
export async function uploadMedia(filePath: string): Promise<MediaUploadResult> {
  const ext = extname(filePath).toLowerCase();
  const imageType = IMAGE_MEDIA_TYPES[ext];
  const videoType = VIDEO_MEDIA_TYPES[ext];
  const mimeType = imageType || videoType;
  if (!mimeType) {
    throw new Error(
      `Unsupported file type: ${ext}. Supported: ${[...Object.keys(IMAGE_MEDIA_TYPES), ...Object.keys(VIDEO_MEDIA_TYPES)].join(", ")}`
    );
  }

  const fileData = readFileSync(filePath);
  const category = mediaCategoryFor(mimeType);

  const maxSize = videoType ? MAX_VIDEO_SIZE : mimeType === "image/gif" ? MAX_GIF_SIZE : MAX_IMAGE_SIZE;
  if (fileData.length > maxSize) {
    throw new Error(
      `File too large: ${(fileData.length / 1024 / 1024).toFixed(1)}MB (max ${(maxSize / 1024 / 1024).toFixed(0)}MB for ${category})`
    );
  }

  // Video (and anything larger than a single chunk) → chunked; images → simple.
  const useChunked = !!videoType || fileData.length > UPLOAD_CHUNK_SIZE;
  const mediaId = useChunked
    ? await uploadMediaChunked(fileData, mimeType, category)
    : await uploadMediaSimple(fileData, mimeType, category);

  return { media_id_string: mediaId, media_type: mimeType, size: fileData.length };
}

async function uploadMediaSimple(fileData: Buffer, mimeType: string, category: string): Promise<string> {
  const form = new FormData();
  form.append("media", new Blob([new Uint8Array(fileData)], { type: mimeType }), "media");
  form.append("media_category", category);
  return extractMediaId(await postMediaForm(V2_MEDIA_UPLOAD, form, "media/upload (simple)"));
}

async function uploadMediaChunked(fileData: Buffer, mimeType: string, category: string): Promise<string> {
  // The chunked flow uses dedicated subpath endpoints. The older command-based multipart
  // flow (command=INIT/APPEND/FINALIZE on the base endpoint) 400s with "Missing media
  // field in JSON" — the base endpoint only serves the simple path now (verified live
  // 2026-07-17; endpoint shapes per docs.x.com/x-api/media/media-upload-initialize etc.).

  // INITIALIZE — JSON body
  const initRes = await postMediaJson(
    `${V2_MEDIA_UPLOAD}/initialize`,
    { media_type: mimeType, total_bytes: fileData.length, media_category: category },
    "media/upload/initialize"
  );
  const mediaId = extractMediaId(initRes);

  // APPEND — 4MB multipart segments on the per-id subpath
  let segmentIndex = 0;
  for (let offset = 0; offset < fileData.length; offset += UPLOAD_CHUNK_SIZE) {
    const chunk = fileData.subarray(offset, Math.min(offset + UPLOAD_CHUNK_SIZE, fileData.length));
    const appendForm = new FormData();
    appendForm.append("segment_index", String(segmentIndex));
    appendForm.append("media", new Blob([new Uint8Array(chunk)], { type: "application/octet-stream" }), "blob");
    await postMediaForm(`${V2_MEDIA_UPLOAD}/${mediaId}/append`, appendForm, `media/upload append ${segmentIndex}`);
    segmentIndex++;
  }

  // FINALIZE — body-less POST on the per-id subpath
  const finalizeRes = await postMediaJson(`${V2_MEDIA_UPLOAD}/${mediaId}/finalize`, undefined, "media/upload finalize");

  // Video is processed asynchronously — poll status until succeeded/failed.
  await waitForMediaProcessing(mediaId, finalizeRes);
  return mediaId;
}

async function waitForMediaProcessing(mediaId: string, lastResponse: any): Promise<void> {
  let info = lastResponse?.data?.processing_info || lastResponse?.processing_info;
  while (info && (info.state === "pending" || info.state === "in_progress")) {
    const waitSec = info.check_after_secs || 2;
    await sleep(waitSec * 1000);
    const status = await apiGetOAuth(`${V2_MEDIA_UPLOAD}?media_id=${mediaId}`);
    info = status?.data?.processing_info || status?.processing_info;
    if (info?.state === "failed") {
      throw new Error(`Media processing failed: ${JSON.stringify(info.error || info).slice(0, 200)}`);
    }
  }
}

// --- Articles (long-form, v2, OAuth 1.0a) ---
//
// Launched 2026-06-11. Two endpoints: POST /2/articles/draft creates a draft, then
// POST /2/articles/{article_id}/publish publishes it. The draft body is a DraftJS
// content state. Authoring Articles requires an X Premium account. There are no edit
// or delete endpoints yet — a draft can only be created and (once) published.

// X's article content_state is DraftJS-flavored but NOT the standard convertToRaw shape.
// Verified live 2026-07-17 by iterative probing (the schema rejects unknown properties):
// - blocks carry ONLY text + type (+ optional snake_case entity_ranges); no key/depth/
//   inlineStyleRanges — standard raw-DraftJS blocks 400.
// - entities is a top-level ARRAY of {key: "<string>", value: {...}} pairs, not a keyed
//   entityMap; value.type and value.mutability are lowercase enums
//   (type: post|link|image|emoji|markdown|divider|latex; mutability: immutable|mutable|segmented).
export interface DraftJSBlock {
  text: string;
  type: string;
  entity_ranges?: { offset: number; length: number; key: number }[];
}

export interface DraftJSContentState {
  blocks: DraftJSBlock[];
  entities: { key: string; value: { type: string; mutability: string; data: Record<string, any> } }[];
}

export interface ArticleResult {
  id: string;
  title: string;
  url?: string;
}

/**
 * Convert a lightweight markdown-ish string into a DraftJS content state.
 * Supported: blank-line-separated paragraphs; ATX headers (#, ##, ###); "- " / "* "
 * unordered list items; inline links [text](url). Intentionally simple — not a full
 * markdown parser. Link display text always survives as plain text, so even if the
 * entity map is ignored the article body is never lost.
 */
export function buildArticleContentState(markdown: string): DraftJSContentState {
  const blocks: DraftJSBlock[] = [];
  const entities: DraftJSContentState["entities"] = [];
  let entityKey = 0;

  const pushBlock = (type: string, text: string) => {
    // Extract inline [text](url) links → plain display text + entity ranges.
    const entityRanges: NonNullable<DraftJSBlock["entity_ranges"]> = [];
    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
    let out = "";
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(text)) !== null) {
      out += text.slice(lastIndex, m.index);
      const offset = out.length;
      out += m[1];
      entities.push({ key: String(entityKey), value: { type: "link", mutability: "mutable", data: { url: m[2] } } });
      entityRanges.push({ offset, length: m[1].length, key: entityKey });
      entityKey++;
      lastIndex = linkRe.lastIndex;
    }
    out += text.slice(lastIndex);
    blocks.push({ text: out, type, ...(entityRanges.length > 0 ? { entity_ranges: entityRanges } : {}) });
  };

  let paragraphBuffer: string[] = [];
  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return;
    pushBlock("unstyled", paragraphBuffer.join(" "));
    paragraphBuffer = [];
  };

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flushParagraph();
      continue;
    }
    const header = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (header) {
      flushParagraph();
      const level = header[1].length;
      const type = level === 1 ? "header-one" : level === 2 ? "header-two" : "header-three";
      pushBlock(type, header[2]);
      continue;
    }
    const listItem = trimmed.match(/^[-*]\s+(.*)$/);
    if (listItem) {
      flushParagraph();
      pushBlock("unordered-list-item", listItem[1]);
      continue;
    }
    paragraphBuffer.push(trimmed);
  }
  flushParagraph();

  if (blocks.length === 0) {
    // At least one block is required.
    blocks.push({ text: "", type: "unstyled" });
  }

  return { blocks, entities };
}

/**
 * Create an Article draft. Returns the article id (needed to publish).
 * `body` is markdown-ish text run through buildArticleContentState; pass a prebuilt
 * content state via opts.contentState to bypass the builder. Requires X Premium.
 */
export async function draftArticle(
  title: string,
  body: string,
  opts?: { contentState?: DraftJSContentState }
): Promise<ArticleResult> {
  const content_state = opts?.contentState || buildArticleContentState(body);
  const result = await apiPostOAuth(`${BASE}/articles/draft`, { title, content_state });
  const id = result.data?.id;
  if (!id) {
    throw new Error(`Article draft: no id in response: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return { id: String(id), title, url: result.data?.url };
}

/** Publish a previously-drafted Article by id. No edit/delete endpoint exists post-publish. */
export async function publishArticle(articleId: string): Promise<ArticleResult> {
  const result = await apiPostOAuth(`${BASE}/articles/${articleId}/publish`, {});
  return {
    id: String(result.data?.id || articleId),
    title: result.data?.title || "",
    url: result.data?.url,
  };
}

// --- Bookmarks (OAuth 1.0a, may require PKCE) ---

/**
 * List bookmarks for the authenticated user.
 */
export async function listBookmarks(
  opts?: { maxResults?: number; paginationToken?: string }
): Promise<Tweet[]> {
  const userId = await getAuthenticatedUserId();
  const maxResults = Math.min(opts?.maxResults || 20, 100);
  let url = `${BASE}/users/${userId}/bookmarks?${FIELDS}&max_results=${maxResults}`;
  if (opts?.paginationToken) {
    url += `&pagination_token=${opts.paginationToken}`;
  }
  const raw = await apiGetOAuth(url);
  return parseTweets(raw);
}

/**
 * Bookmark a tweet.
 */
export async function bookmarkTweet(tweetId: string): Promise<void> {
  const userId = await getAuthenticatedUserId();
  const url = `${BASE}/users/${userId}/bookmarks`;
  await apiPostOAuth(url, { tweet_id: tweetId }, { retryOn5xx: true });
}

/**
 * Remove a bookmark.
 */
export async function unbookmarkTweet(tweetId: string): Promise<void> {
  const userId = await getAuthenticatedUserId();
  const url = `${BASE}/users/${userId}/bookmarks/${tweetId}`;
  await apiDeleteOAuth(url);
}

// --- Direct Messages (OAuth 1.0a, may require PKCE) ---

export interface DMEvent {
  id: string;
  event_type: string;
  text: string;
  sender_id: string;
  sender_username?: string;
  dm_conversation_id: string;
  created_at: string;
}

function parseDMEvents(raw: any): DMEvent[] {
  if (!raw.data) return [];
  const users: Record<string, any> = {};
  for (const u of raw.includes?.users || []) {
    users[u.id] = u;
  }

  return raw.data.map((e: any) => ({
    id: e.id,
    event_type: e.event_type || "MessageCreate",
    text: e.text || "",
    sender_id: e.sender_id || "",
    sender_username: users[e.sender_id]?.username,
    dm_conversation_id: e.dm_conversation_id || "",
    created_at: e.created_at || "",
  }));
}

const DM_FIELDS = "dm_event.fields=id,text,event_type,dm_conversation_id,created_at,sender_id&expansions=sender_id&user.fields=username,name";

/**
 * Send a direct message to a user by their user ID.
 */
export async function sendDM(
  userId: string,
  text: string
): Promise<{ dm_conversation_id: string; dm_event_id: string }> {
  const url = `${BASE}/dm_conversations/with/${userId}/messages`;
  const result = await apiPostOAuth(url, { text });
  return {
    dm_conversation_id: result.data?.dm_conversation_id || "",
    dm_event_id: result.data?.dm_event_id || "",
  };
}

/**
 * List recent DM events across all conversations.
 */
export async function listDMEvents(
  opts?: { maxResults?: number; paginationToken?: string }
): Promise<DMEvent[]> {
  const maxResults = Math.min(opts?.maxResults || 20, 100);
  let url = `${BASE}/dm_events?${DM_FIELDS}&max_results=${maxResults}`;
  if (opts?.paginationToken) {
    url += `&pagination_token=${opts.paginationToken}`;
  }
  const raw = await apiGetOAuth(url);
  return parseDMEvents(raw);
}

/**
 * List DM events for a specific conversation.
 */
export async function listConversationEvents(
  conversationId: string,
  opts?: { maxResults?: number; paginationToken?: string }
): Promise<DMEvent[]> {
  const maxResults = Math.min(opts?.maxResults || 20, 100);
  let url = `${BASE}/dm_conversations/${conversationId}/dm_events?${DM_FIELDS}&max_results=${maxResults}`;
  if (opts?.paginationToken) {
    url += `&pagination_token=${opts.paginationToken}`;
  }
  const raw = await apiGetOAuth(url);
  return parseDMEvents(raw);
}
