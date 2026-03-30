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

import { readFileSync, statSync } from "fs";
import { createHmac, randomBytes } from "crypto";
import { basename, extname } from "path";

const BASE = "https://api.x.com/2";
const RATE_DELAY_MS = 350; // stay under 450 req/15min

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
  // Use OAuth 1.0a for all reads (bearer token broken on Pay Per Use accounts)
  const creds = getOAuthCreds();
  const authHeader = buildOAuthHeader("GET", url.split("?")[0], creds, url);
  const res = await fetch(url, {
    headers: { Authorization: authHeader },
  });

  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    const waitSec = reset
      ? Math.max(parseInt(reset) - Math.floor(Date.now() / 1000), 1)
      : 60;
    throw new Error(`Rate limited. Resets in ${waitSec}s`);
  }

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
  body: Record<string, any>
): Promise<any> {
  const creds = getOAuthCreds();
  const authHeader = buildOAuthHeader("POST", url, creds);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X API ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json();
}

async function apiDeleteOAuth(url: string): Promise<any> {
  const creds = getOAuthCreds();
  const authHeader = buildOAuthHeader("DELETE", url, creds);

  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: authHeader },
  });

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
  const authHeader = buildOAuthHeader("GET", url, creds);
  const res = await fetch(url, {
    headers: { Authorization: authHeader },
  });
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

/**
 * Post a multi-tweet thread. First tweet is posted normally,
 * subsequent tweets are chained as replies.
 * Optionally attach media to the first tweet via firstMediaIds.
 */
export async function postThread(
  tweets: string[],
  opts?: { firstMediaIds?: string[] }
): Promise<PostResult[]> {
  if (tweets.length === 0) throw new Error("No tweets to post");

  const results: PostResult[] = [];
  const first = await createTweet(tweets[0], { mediaIds: opts?.firstMediaIds });
  results.push(first);

  for (let i = 1; i < tweets.length; i++) {
    await sleep(1000); // delay between posts to avoid rate issues
    const reply = await replyToTweet(tweets[i], results[i - 1].id);
    results.push(reply);
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
  await apiPostOAuth(url, { tweet_id: tweetId });
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
  await apiPostOAuth(url, { tweet_id: tweetId });
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
  await apiPostOAuth(url, { target_user_id: targetId });
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

// --- Media upload (v1.1 endpoint, OAuth 1.0a) ---

const UPLOAD_BASE = "https://upload.twitter.com/1.1";

const ALLOWED_MEDIA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_MEDIA_SIZE = 5 * 1024 * 1024; // 5MB

export interface MediaUploadResult {
  media_id_string: string;
  media_type: string;
  size: number;
}

/**
 * Upload an image file for use in tweets.
 * Supports JPEG, PNG, GIF, WebP. Max 5MB.
 * Uses v1.1 media upload endpoint with base64 encoding.
 */
export async function uploadMedia(filePath: string): Promise<MediaUploadResult> {
  const ext = extname(filePath).toLowerCase();
  const mimeType = ALLOWED_MEDIA_TYPES[ext];
  if (!mimeType) {
    throw new Error(
      `Unsupported file type: ${ext}. Supported: ${Object.keys(ALLOWED_MEDIA_TYPES).join(", ")}`
    );
  }

  const fileData = readFileSync(filePath);
  if (fileData.length > MAX_MEDIA_SIZE) {
    throw new Error(
      `File too large: ${(fileData.length / 1024 / 1024).toFixed(1)}MB (max 5MB)`
    );
  }

  const base64Data = fileData.toString("base64");
  const url = `${UPLOAD_BASE}/media/upload.json`;

  const creds = getOAuthCreds();
  const authHeader = buildOAuthHeader("POST", url, creds);

  // Use multipart/form-data for v1.1 media upload.
  // Per Twitter docs and RFC 5849: multipart body params are excluded from
  // OAuth signature base string, so buildOAuthHeader needs only oauth_* params.
  const boundary = `----NodeFormBoundary${randomBytes(16).toString("hex")}`;
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="media_data"\r\n\r\n${base64Data}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="media_category"\r\n\r\ntweet_image\r\n`,
    `--${boundary}--\r\n`,
  ];
  const multipartBody = parts.join("");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Media upload ${res.status}: ${text.slice(0, 300)}`);
  }

  const result = await res.json();
  return {
    media_id_string: result.media_id_string,
    media_type: mimeType,
    size: fileData.length,
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
  await apiPostOAuth(url, { tweet_id: tweetId });
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
