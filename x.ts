#!/usr/bin/env bun
/**
 * x — CLI for X/Twitter research, posting, and engagement.
 *
 * Commands:
 *   search <query> [options]    Search tweets (recent or full-archive)
 *   thread <tweet_id>           Fetch full conversation thread
 *   profile <username>          Recent tweets from a user
 *   tweet <tweet_id>            Fetch a single tweet
 *   watchlist                   Show watchlist
 *   watchlist add <user>        Add user to watchlist
 *   watchlist remove <user>     Remove user from watchlist
 *   watchlist check             Check recent tweets from all watchlist accounts
 *   cache clear                 Clear search cache
 *   post <text>                 Post a new tweet
 *   reply <tweet_id> <text>     Reply to a tweet
 *   quote <tweet_url> <text>    Quote tweet
 *   delete <tweet_id>           Delete a tweet
 *   thread-post --file <path>   Post a multi-tweet thread (resumable)
 *   article-draft --title T --file P [--publish]  Draft/publish a long-form Article
 *   article-publish <id>        Publish a previously-drafted Article
 *   like <tweet_id>             Like a tweet
 *   unlike <tweet_id>           Unlike a tweet
 *   repost <tweet_id>           Repost (retweet) a tweet
 *   unrepost <tweet_id>         Undo a repost
 *   follow <username>           Follow a user
 *   unfollow <username>         Unfollow a user
 *   upload <filepath>           Upload media, print media_id
 *   bookmarks [--limit N]       List bookmarks (alias: bm)
 *   bookmark <tweet_id>         Bookmark a tweet
 *   unbookmark <tweet_id>       Remove a bookmark
 *   dm <username> <text>        Send a direct message
 *   dms [--limit N]             List recent DM events
 *   dms <conversation_id>       List events in a conversation
 *
 * Search options:
 *   --sort likes|impressions|retweets|recent   Sort order (default: likes)
 *   --min-likes N              Filter by minimum likes
 *   --min-impressions N        Filter by minimum impressions
 *   --pages N                  Number of pages to fetch (default: 1, max 5)
 *   --no-replies               Exclude replies
 *   --no-retweets              Exclude retweets (added by default)
 *   --limit N                  Max results to display (default: 15)
 *   --quick                    Quick mode: 1 page, noise filter, 1hr cache
 *   --from <username>          Shorthand for from:username in query
 *   --quality                  Pre-filter low-engagement (min_faves:10)
 *   --archive                  Use full-archive search (all time, back to 2006)
 *   --save                     Save results to ~/.claude/drafts/
 *   --json                     Output raw JSON
 *   --markdown                 Output as markdown (for research docs)
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import * as api from "./lib/api";
import * as cache from "./lib/cache";
import * as fmt from "./lib/format";

const SKILL_DIR = import.meta.dir;
const WATCHLIST_PATH = join(SKILL_DIR, "data", "watchlist.json");
const DRAFTS_DIR = join(process.env.HOME!, ".claude", "drafts");

// --- Pricing (X API pay-per-use, updated 2026-04-16) ---
// ⚠️ A post that CONTAINS A URL costs $0.20 — 13x the $0.015 base. See postCost().
const COST = {
  postCreate: 0.015, // create a post/reply/quote (no URL)
  postWithUrl: 0.2, // create a post that contains a URL — 13x the base
  summonedReply: 0.01, // reply to someone else's post after being summoned
  postRead: 0.005, // read someone else's post
  ownedRead: 0.001, // read your own post
  userLookup: 0.01, // look up a user
  dmCreate: 0.015, // send a DM
  dmRead: 0.01, // read a DM event
};

function hasUrl(text: string): boolean {
  return /https?:\/\/\S+/i.test(text);
}

/** Create-cost for a post, accounting for the 13x URL surcharge. */
function postCost(text: string): number {
  return hasUrl(text) ? COST.postWithUrl : COST.postCreate;
}

// --- Arg parsing ---

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): boolean {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0) {
    args.splice(idx, 1);
    return true;
  }
  return false;
}

function getOpt(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) {
    const val = args[idx + 1];
    args.splice(idx, 2);
    return val;
  }
  return undefined;
}

// --- Watchlist ---

interface Watchlist {
  accounts: { username: string; note?: string; addedAt: string }[];
}

function loadWatchlist(): Watchlist {
  if (!existsSync(WATCHLIST_PATH))
    return { accounts: [] };
  return JSON.parse(readFileSync(WATCHLIST_PATH, "utf-8"));
}

function saveWatchlist(wl: Watchlist) {
  writeFileSync(WATCHLIST_PATH, JSON.stringify(wl, null, 2));
}

// --- Commands ---

async function cmdSearch() {
  // Parse new flags first (before getOpt consumes positional args)
  const quick = getFlag("quick");
  const quality = getFlag("quality");
  const archive = getFlag("archive");
  const fromUser = getOpt("from");

  const sortOpt = getOpt("sort") || "likes";
  const minLikes = parseInt(getOpt("min-likes") || "0");
  const minReplies = parseInt(getOpt("min-replies") || "0");
  const minReposts = parseInt(getOpt("min-reposts") || "0");
  const minImpressions = parseInt(getOpt("min-impressions") || "0");
  let pages = Math.min(parseInt(getOpt("pages") || "1"), 5);
  let limit = parseInt(getOpt("limit") || "15");
  const since = getOpt("since");
  const noReplies = getFlag("no-replies");
  const noRetweets = getFlag("no-retweets");
  const save = getFlag("save");
  const asJson = getFlag("json");
  const asMarkdown = getFlag("markdown");

  // Quick mode overrides
  if (quick) {
    pages = 1;
    limit = Math.min(limit, 10);
  }

  // Everything after "search" that isn't a flag is the query
  const queryParts = args.slice(1).filter((a) => !a.startsWith("--"));
  let query = queryParts.join(" ");

  if (!query) {
    console.error("Usage: x.ts search <query> [options]");
    process.exit(1);
  }

  // --from shorthand: add from:username if not already in query
  if (fromUser && !query.toLowerCase().includes("from:")) {
    query += ` from:${fromUser.replace(/^@/, "")}`;
  }

  // Auto-add noise filters unless already present.
  // Note: since the 2026-05-04 index migration, retweets are no longer returned in
  // keyword search anyway, so -is:retweet is mostly a no-op on recent search (kept for
  // --archive and for explicit is:retweet queries).
  if (!query.includes("is:retweet") && !noRetweets) {
    query += " -is:retweet";
  }
  if (quick && !query.includes("is:reply")) {
    query += " -is:reply";
  } else if (noReplies && !query.includes("is:reply")) {
    query += " -is:reply";
  }

  // Native precision operators (added by the 2026-05-04 search index migration).
  // Prefer server-side filtering over post-hoc: it is both more accurate AND cheaper
  // (fewer post reads billed). There is no native operator for impressions, so that
  // one stays post-hoc below.
  if (minLikes > 0 && !/\bmin_likes:/.test(query)) query += ` min_likes:${minLikes}`;
  if (quality && !/\bmin_likes:/.test(query)) query += " min_likes:10";
  if (minReplies > 0 && !/\bmin_replies:/.test(query)) query += ` min_replies:${minReplies}`;
  if (minReposts > 0 && !/\bmin_reposts:/.test(query)) query += ` min_reposts:${minReposts}`;

  // Cache TTL: 1hr for quick mode, 15min default
  const cacheTtlMs = quick ? 3_600_000 : 900_000;

  // Check cache (cache key does NOT include quick flag — shared between modes)
  const cacheParams = `sort=${sortOpt}&pages=${pages}&since=${since || "7d"}`;
  const cached = cache.get(query, cacheParams, cacheTtlMs);
  let tweets: api.Tweet[];

  if (cached) {
    tweets = cached;
    console.error(`(cached — ${tweets.length} tweets)`);
  } else {
    tweets = await api.search(query, {
      pages,
      sortOrder: sortOpt === "recent" ? "recency" : "relevancy",
      since: since || undefined,
      archive,
    });
    cache.set(query, cacheParams, tweets);
  }

  // Track raw count for cost (API charges per tweet read, regardless of post-hoc filters)
  const rawTweetCount = tweets.length;

  // Post-hoc filter only for impressions (no native operator exists). min-likes,
  // --quality, min-replies and min-reposts are applied server-side as native operators above.
  if (minImpressions > 0) {
    tweets = api.filterEngagement(tweets, { minImpressions });
  }

  // Sort
  if (sortOpt !== "recent") {
    const metric = sortOpt as "likes" | "impressions" | "retweets";
    tweets = api.sortBy(tweets, metric);
  }

  tweets = api.dedupe(tweets);

  // Output
  if (asJson) {
    console.log(JSON.stringify(tweets.slice(0, limit), null, 2));
  } else if (asMarkdown) {
    const md = fmt.formatResearchMarkdown(query, tweets, {
      queries: [query],
    });
    console.log(md);
  } else {
    console.log(fmt.formatResultsTelegram(tweets, { query, limit }));
  }

  // Save
  if (save) {
    const slug = query
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .toLowerCase();
    const date = new Date().toISOString().split("T")[0];
    const path = join(DRAFTS_DIR, `x-research-${slug}-${date}.md`);
    const md = fmt.formatResearchMarkdown(query, tweets, {
      queries: [query],
    });
    writeFileSync(path, md);
    console.error(`\nSaved to ${path}`);
  }

  // Cost display (based on raw API reads, not post-filter count)
  const cost = (rawTweetCount * COST.postRead).toFixed(2);
  if (quick) {
    console.error(`\n⚡ quick mode · ${rawTweetCount} tweets read (~$${cost})`);
  } else {
    console.error(`\n📊 ${rawTweetCount} tweets read · est. cost ~$${cost}`);
  }

  // Stats to stderr
  const filtered = rawTweetCount !== tweets.length ? ` → ${tweets.length} after filters` : "";
  const sinceLabel = since ? ` | since ${since}` : "";
  console.error(
    `${rawTweetCount} tweets${filtered} | sorted by ${sortOpt} | ${pages} page(s)${sinceLabel}`
  );
}

async function cmdThread() {
  const tweetId = args[1];
  if (!tweetId) {
    console.error("Usage: x.ts thread <tweet_id>");
    process.exit(1);
  }

  const pages = Math.min(parseInt(getOpt("pages") || "2"), 5);
  const tweets = await api.thread(tweetId, { pages });

  if (tweets.length === 0) {
    console.log("No tweets found in thread.");
    return;
  }

  console.log(`🧵 Thread (${tweets.length} tweets)\n`);
  for (const t of tweets) {
    console.log(fmt.formatTweetTelegram(t, undefined, { full: true }));
    console.log();
  }

  // Cost: root tweet lookup + search pages, all billed as post reads ($0.005 each)
  const cost = ((tweets.length + 1) * COST.postRead).toFixed(2);
  console.error(`\n📊 ${tweets.length} tweets read · est. cost ~$${cost}`);
}

async function cmdProfile() {
  const username = args[1]?.replace(/^@/, "");
  if (!username) {
    console.error("Usage: x.ts profile <username>");
    process.exit(1);
  }

  const count = parseInt(getOpt("count") || "20");
  const includeReplies = getFlag("replies");
  const asJson = getFlag("json");

  const { user, tweets } = await api.profile(username, {
    count,
    includeReplies,
  });

  if (asJson) {
    console.log(JSON.stringify({ user, tweets }, null, 2));
  } else {
    console.log(fmt.formatProfileTelegram(user, tweets));
  }

  // Cost: 1 user lookup ($0.01) + tweet reads ($0.005 each)
  const cost = (COST.userLookup + tweets.length * COST.postRead).toFixed(2);
  console.error(`\n📊 1 user + ${tweets.length} tweets read · est. cost ~$${cost}`);
}

async function cmdTweet() {
  const tweetId = args[1];
  if (!tweetId) {
    console.error("Usage: x.ts tweet <tweet_id>");
    process.exit(1);
  }

  const tweet = await api.getTweet(tweetId);
  if (!tweet) {
    console.log("Tweet not found.");
    return;
  }

  const asJson = getFlag("json");
  if (asJson) {
    console.log(JSON.stringify(tweet, null, 2));
  } else {
    console.log(fmt.formatTweetTelegram(tweet, undefined, { full: true }));
  }

  console.error(`\n📊 1 tweet read · est. cost ~$${COST.postRead.toFixed(3)}`);
}

async function cmdWatchlist() {
  const sub = args[1];
  const wl = loadWatchlist();

  if (sub === "add") {
    const username = args[2]?.replace(/^@/, "");
    const note = args.slice(3).join(" ") || undefined;
    if (!username) {
      console.error("Usage: x.ts watchlist add <username> [note]");
      process.exit(1);
    }
    if (wl.accounts.find((a) => a.username.toLowerCase() === username.toLowerCase())) {
      console.log(`@${username} already on watchlist.`);
      return;
    }
    wl.accounts.push({
      username,
      note,
      addedAt: new Date().toISOString(),
    });
    saveWatchlist(wl);
    console.log(`Added @${username} to watchlist.${note ? ` (${note})` : ""}`);
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const username = args[2]?.replace(/^@/, "");
    if (!username) {
      console.error("Usage: x.ts watchlist remove <username>");
      process.exit(1);
    }
    const before = wl.accounts.length;
    wl.accounts = wl.accounts.filter(
      (a) => a.username.toLowerCase() !== username.toLowerCase()
    );
    saveWatchlist(wl);
    console.log(
      wl.accounts.length < before
        ? `Removed @${username} from watchlist.`
        : `@${username} not found on watchlist.`
    );
    return;
  }

  if (sub === "check") {
    if (wl.accounts.length === 0) {
      console.log("Watchlist is empty. Add accounts with: watchlist add <username>");
      return;
    }
    console.log(`Checking ${wl.accounts.length} watchlist accounts...\n`);
    let totalTweets = 0;
    for (const acct of wl.accounts) {
      try {
        const { user, tweets } = await api.profile(acct.username, { count: 5 });
        totalTweets += tweets.length;
        const label = acct.note ? ` (${acct.note})` : "";
        console.log(`\n--- @${acct.username}${label} ---`);
        if (tweets.length === 0) {
          console.log("  No recent tweets.");
        } else {
          for (const t of tweets.slice(0, 3)) {
            console.log(fmt.formatTweetTelegram(t));
            console.log();
          }
        }
      } catch (e: any) {
        console.error(`  Error checking @${acct.username}: ${e.message}`);
      }
    }
    // Cost: 1 user lookup ($0.01) + tweets per account
    const cost = (wl.accounts.length * COST.userLookup + totalTweets * COST.postRead).toFixed(2);
    console.error(`\n📊 ${wl.accounts.length} accounts, ${totalTweets} tweets read · est. cost ~$${cost}`);
    return;
  }

  // Default: show watchlist
  if (wl.accounts.length === 0) {
    console.log("Watchlist is empty. Add accounts with: watchlist add <username>");
    return;
  }
  console.log(`📋 Watchlist (${wl.accounts.length} accounts)\n`);
  for (const acct of wl.accounts) {
    const note = acct.note ? ` — ${acct.note}` : "";
    console.log(`  @${acct.username}${note} (added ${acct.addedAt.split("T")[0]})`);
  }
}

async function cmdPost() {
  const mediaPath = getOpt("media");
  const text = args.slice(1).join(" ");
  if (!text) {
    console.error("Usage: x.ts post <text> [--media <filepath>]");
    process.exit(1);
  }
  if (text.length > 25000) {
    console.error(`Tweet is ${text.length} chars (max 25,000). Trim it.`);
    process.exit(1);
  }

  if (hasUrl(text)) {
    console.error(`⚠️ This post contains a URL → it costs $0.20 (13x the $0.015 base). To keep the hook cheap and high-reach, put the link in a self-reply instead.`);
  }

  let mediaIds: string[] | undefined;
  if (mediaPath) {
    console.error(`Uploading ${mediaPath}...`);
    const upload = await api.uploadMedia(mediaPath);
    mediaIds = [upload.media_id_string];
    console.error(`Uploaded: ${upload.media_id_string} (${(upload.size / 1024).toFixed(0)}KB ${upload.media_type})`);
  }

  const result = await api.createTweet(text, { mediaIds });
  console.log(`Posted: ${result.tweet_url}`);
  const warn = hasUrl(text) ? "  ⚠️ URL post (13x)" : "";
  console.error(`\n📊 1 tweet created${mediaPath ? " with media" : ""} · est. cost ~$${postCost(text).toFixed(3)}${warn}`);
}

async function cmdReply() {
  const mediaPath = getOpt("media");
  const tweetId = args[1];
  const text = args.slice(2).join(" ");
  if (!tweetId || !text) {
    console.error("Usage: x.ts reply <tweet_id_or_url> <text> [--media <filepath>]");
    process.exit(1);
  }
  if (text.length > 25000) {
    console.error(`Reply is ${text.length} chars (max 25,000). Trim it.`);
    process.exit(1);
  }

  if (hasUrl(text)) {
    console.error(`⚠️ This reply contains a URL → it costs $0.20 (13x the $0.015 base).`);
  }

  let mediaIds: string[] | undefined;
  if (mediaPath) {
    console.error(`Uploading ${mediaPath}...`);
    const upload = await api.uploadMedia(mediaPath);
    mediaIds = [upload.media_id_string];
    console.error(`Uploaded: ${upload.media_id_string} (${(upload.size / 1024).toFixed(0)}KB ${upload.media_type})`);
  }

  // Extract tweet ID from URL if needed
  const id = api.extractTweetId(tweetId);
  const result = await api.replyToTweet(text, id, { mediaIds });
  console.log(`Replied: ${result.tweet_url}`);
  const warn = hasUrl(text) ? "  ⚠️ URL post (13x)" : "";
  console.error(`\n📊 1 reply created${mediaPath ? " with media" : ""} · est. cost ~$${postCost(text).toFixed(3)}${warn}`);
}

async function cmdQuote() {
  const mediaPath = getOpt("media");
  const tweetUrlOrId = args[1];
  const text = args.slice(2).join(" ");
  if (!tweetUrlOrId || !text) {
    console.error("Usage: x.ts quote <tweet_url_or_id> <text> [--media <filepath>]");
    process.exit(1);
  }
  if (text.length > 25000) {
    console.error(`Quote is ${text.length} chars (max 25,000). Trim it.`);
    process.exit(1);
  }

  if (hasUrl(text)) {
    console.error(`⚠️ This quote contains a URL → it costs $0.20 (13x the $0.015 base).`);
  }

  let mediaIds: string[] | undefined;
  if (mediaPath) {
    console.error(`Uploading ${mediaPath}...`);
    const upload = await api.uploadMedia(mediaPath);
    mediaIds = [upload.media_id_string];
    console.error(`Uploaded: ${upload.media_id_string} (${(upload.size / 1024).toFixed(0)}KB ${upload.media_type})`);
  }

  const result = await api.quoteTweet(text, tweetUrlOrId, { mediaIds });
  console.log(`Quoted: ${result.tweet_url}`);
  const warn = hasUrl(text) ? "  ⚠️ URL post (13x)" : "";
  console.error(`\n📊 1 quote tweet created${mediaPath ? " with media" : ""} · est. cost ~$${postCost(text).toFixed(3)}${warn}`);
}

async function cmdDelete() {
  const tweetId = args[1];
  if (!tweetId) {
    console.error("Usage: x.ts delete <tweet_id>");
    process.exit(1);
  }

  const id = tweetId.match(/status\/(\d+)/)?.[1] || tweetId;
  const deleted = await api.deleteTweet(id);
  if (deleted) {
    console.log(`Deleted tweet ${id}`);
  } else {
    console.error(`Failed to delete tweet ${id}`);
    process.exit(1);
  }
}

async function cmdThreadPost() {
  const filePath = getOpt("file");
  const stateOpt = getOpt("state");
  const fresh = getFlag("fresh");
  let content: string;

  if (filePath) {
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    content = readFileSync(filePath, "utf-8");
  } else {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    content = Buffer.concat(chunks).toString("utf-8");
  }

  if (!content.trim()) {
    console.error("Usage: x.ts thread-post --file <path>");
    console.error("  or pipe content: echo '...' | x.ts thread-post");
    process.exit(1);
  }

  // Parse thread: split on ## Tweet N headers (matching draft format)
  // First section (before any ## Tweet header) is preamble — skip it
  const tweetTexts: string[] = [];
  const sections = content.split(/^## Tweet \d+.*$/m);
  for (let i = 0; i < sections.length; i++) {
    if (i === 0) continue; // skip preamble (title, metadata, etc.)
    const trimmed = sections[i].trim();
    if (trimmed) tweetTexts.push(trimmed);
  }

  // Fallback: if no ## Tweet headers found, split on --- separator
  if (tweetTexts.length <= 1 && content.includes("---")) {
    tweetTexts.length = 0;
    for (const section of content.split(/^---$/m)) {
      const trimmed = section.trim();
      if (trimmed) tweetTexts.push(trimmed);
    }
  }

  // Final fallback: one tweet per non-empty line
  if (tweetTexts.length <= 1 && !content.includes("## Tweet")) {
    tweetTexts.length = 0;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) tweetTexts.push(trimmed);
    }
  }

  if (tweetTexts.length === 0) {
    console.error("No tweets found in input.");
    process.exit(1);
  }

  // Resumable state: a mid-chain failure can be resumed (no double-posting) by re-running
  // the same command. State defaults to <file>.thread-state.json; --state overrides;
  // --fresh discards any prior state and starts over.
  const stateFile =
    stateOpt || (filePath ? `${filePath}.thread-state.json` : join(DRAFTS_DIR, "x-thread-state.json"));
  if (fresh && existsSync(stateFile)) unlinkSync(stateFile);

  const resuming = existsSync(stateFile);
  if (resuming) {
    console.error(`Resuming from ${stateFile} (already-posted tweets will be skipped)...`);
  }

  const urlTweets = tweetTexts.filter(hasUrl).length;
  if (urlTweets > 0) {
    console.error(`⚠️ ${urlTweets} of ${tweetTexts.length} tweets contain a URL → $0.20 each (13x). Isolate links to a single self-reply to pay the penalty only once.`);
  }
  console.error(`Posting thread (${tweetTexts.length} tweets)...`);

  const results = await api.postThread(tweetTexts, {
    stateFile,
    onProgress: (r) => console.log(`${r.tweet_url}`),
  });

  // Full success — remove the resume file so a later re-run doesn't think it's done.
  if (existsSync(stateFile)) unlinkSync(stateFile);

  const cost = tweetTexts.reduce((sum, t) => sum + postCost(t), 0).toFixed(3);
  console.error(`\n📊 ${results.length} tweets posted · est. cost ~$${cost}`);
}

async function cmdLike() {
  const tweetId = args[1];
  if (!tweetId) {
    console.error("Usage: x.ts like <tweet_id_or_url>");
    process.exit(1);
  }
  const id = tweetId.match(/status\/(\d+)/)?.[1] || tweetId;
  await api.likeTweet(id);
  console.log(`Liked tweet ${id}`);
}

async function cmdUnlike() {
  const tweetId = args[1];
  if (!tweetId) {
    console.error("Usage: x.ts unlike <tweet_id_or_url>");
    process.exit(1);
  }
  const id = tweetId.match(/status\/(\d+)/)?.[1] || tweetId;
  await api.unlikeTweet(id);
  console.log(`Unliked tweet ${id}`);
}

async function cmdRepost() {
  const tweetId = args[1];
  if (!tweetId) {
    console.error("Usage: x.ts repost <tweet_id_or_url>");
    process.exit(1);
  }
  const id = tweetId.match(/status\/(\d+)/)?.[1] || tweetId;
  await api.repostTweet(id);
  console.log(`Reposted tweet ${id}`);
}

async function cmdUnrepost() {
  const tweetId = args[1];
  if (!tweetId) {
    console.error("Usage: x.ts unrepost <tweet_id_or_url>");
    process.exit(1);
  }
  const id = tweetId.match(/status\/(\d+)/)?.[1] || tweetId;
  await api.unrepostTweet(id);
  console.log(`Unreposted tweet ${id}`);
}

async function cmdFollow() {
  const username = args[1]?.replace(/^@/, "");
  if (!username) {
    console.error("Usage: x.ts follow <username>");
    process.exit(1);
  }
  await api.followUser(username);
  console.log(`Followed @${username}`);
}

async function cmdUnfollow() {
  const username = args[1]?.replace(/^@/, "");
  if (!username) {
    console.error("Usage: x.ts unfollow <username>");
    process.exit(1);
  }
  await api.unfollowUser(username);
  console.log(`Unfollowed @${username}`);
}

async function cmdUpload() {
  const filePath = args[1];
  if (!filePath) {
    console.error("Usage: x.ts upload <filepath>   (images JPEG/PNG/GIF/WebP, video MP4/MOV)");
    process.exit(1);
  }
  const result = await api.uploadMedia(filePath);
  // Print media_id to stdout (for piping)
  console.log(result.media_id_string);
  console.error(
    `\n📊 Uploaded: ${(result.size / 1024).toFixed(0)}KB ${result.media_type} (media upload is not separately metered in the pay-per-use pricing table)`
  );
}

async function cmdBookmarks() {
  const limit = parseInt(getOpt("limit") || "20");
  const asJson = getFlag("json");

  const tweets = await api.listBookmarks({ maxResults: limit });

  if (asJson) {
    console.log(JSON.stringify(tweets, null, 2));
  } else if (tweets.length === 0) {
    console.log("No bookmarks found.");
  } else {
    console.log(`📑 Bookmarks (${tweets.length})\n`);
    console.log(fmt.formatResultsTelegram(tweets, { limit }));
  }

  const cost = (tweets.length * COST.postRead).toFixed(2);
  console.error(`\n📊 ${tweets.length} bookmarks read · est. cost ~$${cost}`);
}

async function cmdBookmark() {
  const tweetId = args[1];
  if (!tweetId) {
    console.error("Usage: x.ts bookmark <tweet_id_or_url>");
    process.exit(1);
  }
  const id = api.extractTweetId(tweetId);
  await api.bookmarkTweet(id);
  console.log(`Bookmarked tweet ${id}`);
  console.error(`\n📊 1 bookmark action · est. cost ~$0.01`);
}

async function cmdUnbookmark() {
  const tweetId = args[1];
  if (!tweetId) {
    console.error("Usage: x.ts unbookmark <tweet_id_or_url>");
    process.exit(1);
  }
  const id = api.extractTweetId(tweetId);
  await api.unbookmarkTweet(id);
  console.log(`Unbookmarked tweet ${id}`);
  console.error(`\n📊 1 unbookmark action · est. cost ~$0.01`);
}

async function cmdDM() {
  const username = args[1]?.replace(/^@/, "");
  const text = args.slice(2).join(" ");
  if (!username || !text) {
    console.error("Usage: x.ts dm <username> <text>");
    process.exit(1);
  }

  console.error(`Looking up @${username}...`);
  const userId = await api.getUserId(username);
  const result = await api.sendDM(userId, text);
  console.log(`DM sent to @${username} (conversation: ${result.dm_conversation_id})`);
  console.error(`\n📊 1 user lookup + 1 DM sent · est. cost ~$${(COST.userLookup + COST.dmCreate).toFixed(3)}`);
}

async function cmdDMs() {
  const limit = parseInt(getOpt("limit") || "20");
  const asJson = getFlag("json");
  const conversationId = args[1]; // optional: specific conversation

  let events: api.DMEvent[];
  if (conversationId && !conversationId.startsWith("--")) {
    events = await api.listConversationEvents(conversationId, { maxResults: limit });
  } else {
    events = await api.listDMEvents({ maxResults: limit });
  }

  if (asJson) {
    console.log(JSON.stringify(events, null, 2));
  } else {
    console.log(fmt.formatDMEventsList(events));
  }

  const cost = (events.length * COST.dmRead).toFixed(2);
  console.error(`\n📊 ${events.length} DM events read · est. cost ~$${cost}`);
}

async function cmdArticleDraft() {
  const filePath = getOpt("file");
  const title = getOpt("title");
  const publish = getFlag("publish");

  let bodyText: string;
  if (filePath) {
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    bodyText = readFileSync(filePath, "utf-8");
  } else {
    bodyText = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  }

  if (!title) {
    console.error('Usage: x.ts article-draft --title "..." --file <path.md> [--publish]');
    console.error("  Requires an X Premium account. Body is markdown-ish (paragraphs, # headers, - lists, [links](url)).");
    process.exit(1);
  }
  if (!bodyText.trim()) {
    console.error("Article body is empty. Pass --file <path.md> or inline text.");
    process.exit(1);
  }

  const draft = await api.draftArticle(title, bodyText);
  console.log(`Drafted article ${draft.id}${draft.url ? `: ${draft.url}` : ""}`);
  console.error(`\n📊 1 article draft created (article pricing is not separately published; check the console)`);

  if (publish) {
    const pub = await api.publishArticle(draft.id);
    console.log(`Published: ${pub.url || pub.id}`);
    console.error(`📊 1 article published`);
  }
}

async function cmdArticlePublish() {
  const articleId = args[1];
  if (!articleId || articleId.startsWith("--")) {
    console.error("Usage: x.ts article-publish <article_id>");
    process.exit(1);
  }
  const pub = await api.publishArticle(articleId);
  console.log(`Published: ${pub.url || pub.id}`);
  console.error(`\n📊 1 article published`);
}

async function cmdCache() {
  const sub = args[1];
  if (sub === "clear") {
    const removed = cache.clear();
    console.log(`Cleared ${removed} cached entries.`);
  } else {
    const removed = cache.prune();
    console.log(`Pruned ${removed} expired entries.`);
  }
}

function usage() {
  console.log(`x — X/Twitter research, posting, engagement, media, bookmarks & DMs

Commands:
  search <query> [options]    Search tweets (recent or full-archive)
  thread <tweet_id>           Fetch full conversation thread
  profile <username>          Recent tweets from a user
  tweet <tweet_id>            Fetch a single tweet
  post <text> [--media path]  Post a new tweet (optionally with image/video)
  reply <id> <text> [--media] Reply to a tweet
  quote <url> <text> [--media] Quote tweet
  delete <tweet_id>           Delete a tweet
  thread-post --file <path>   Post a multi-tweet thread (resumable; --state <f>, --fresh)
  article-draft --title T --file P [--publish]  Draft (+publish) a long-form Article (Premium)
  article-publish <id>        Publish a previously-drafted Article
  upload <filepath>           Upload image or video, print media_id
  like <tweet_id>             Like a tweet
  unlike <tweet_id>           Unlike a tweet
  repost <tweet_id>           Repost (retweet) a tweet
  unrepost <tweet_id>         Undo a repost
  follow <username>           Follow a user
  unfollow <username>         Unfollow a user
  bookmarks [--limit N]       List bookmarks (alias: bm)
  bookmark <tweet_id>         Bookmark a tweet
  unbookmark <tweet_id>       Remove a bookmark
  dm <username> <text>        Send a direct message
  dms [--limit N]             List recent DM events
  dms <conversation_id>       List events in a conversation
  watchlist                   Show watchlist
  watchlist add <user> [note] Add user to watchlist
  watchlist remove <user>     Remove user from watchlist
  watchlist check             Check recent from all watchlist accounts
  cache clear                 Clear search cache

Search options:
  --sort likes|impressions|retweets|recent   (default: likes)
  --since 1h|3h|12h|1d|7d   Time filter (default: last 7 days)
  --min-likes N              Native min_likes: operator (server-side)
  --min-replies N            Native min_replies: operator (server-side)
  --min-reposts N            Native min_reposts: operator (server-side)
  --min-impressions N        Filter minimum impressions (post-hoc; no native operator)
  --pages N                  Pages to fetch, 1-5 (default: 1)
  --limit N                  Results to display (default: 15)
  --quick                    Quick mode: 1 page, max 10 results, auto noise
                             filter, 1hr cache TTL, cost summary
  --from <username>          Shorthand for from:username in query
  --quality                  Pre-filter low-engagement tweets (min_faves:10)
  --archive                  Full-archive search (all time, back to 2006)
  --no-replies               Exclude replies
  --save                     Save to ~/.claude/drafts/
  --json                     Raw JSON output
  --markdown                 Markdown output

Media: --media <filepath> on post/reply/quote. Images (JPEG/PNG/GIF/WebP, max 5MB) and
       video (MP4/MOV, chunked) via the v2 /2/media/upload endpoint.
⚠️ Posts containing a URL cost $0.20 (13x the $0.015 base). Isolate links to a self-reply.
DMs: need a console app-permission bump ("Read, Write, and Direct Messages") + token regen.

Write/engagement commands require OAuth 1.0a creds in ~/keys/:
  X_API_KEY.txt, X_API_SECRET.txt, X_ACCESS_TOKEN.txt, X_ACCESS_TOKEN_SECRET.txt`);
}

// --- Main ---

async function main() {
  switch (command) {
    case "search":
    case "s":
      await cmdSearch();
      break;
    case "thread":
    case "t":
      await cmdThread();
      break;
    case "profile":
    case "p":
      await cmdProfile();
      break;
    case "tweet":
      await cmdTweet();
      break;
    case "post":
      await cmdPost();
      break;
    case "reply":
      await cmdReply();
      break;
    case "quote":
    case "qt":
      await cmdQuote();
      break;
    case "delete":
    case "del":
      await cmdDelete();
      break;
    case "thread-post":
    case "tp":
      await cmdThreadPost();
      break;
    case "like":
      await cmdLike();
      break;
    case "unlike":
      await cmdUnlike();
      break;
    case "repost":
    case "rt":
      await cmdRepost();
      break;
    case "unrepost":
    case "unrt":
      await cmdUnrepost();
      break;
    case "follow":
      await cmdFollow();
      break;
    case "unfollow":
      await cmdUnfollow();
      break;
    case "upload":
      await cmdUpload();
      break;
    case "bookmarks":
    case "bm":
      await cmdBookmarks();
      break;
    case "bookmark":
      await cmdBookmark();
      break;
    case "unbookmark":
      await cmdUnbookmark();
      break;
    case "dm":
      await cmdDM();
      break;
    case "dms":
      await cmdDMs();
      break;
    case "article-draft":
      await cmdArticleDraft();
      break;
    case "article-publish":
      await cmdArticlePublish();
      break;
    case "watchlist":
    case "wl":
      await cmdWatchlist();
      break;
    case "cache":
      await cmdCache();
      break;
    default:
      usage();
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
