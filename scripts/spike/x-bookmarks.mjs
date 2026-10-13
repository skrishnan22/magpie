// M0 spike: fetch one page of X bookmarks using OAuth 1.0a user context.
// Usage: node scripts/spike/x-bookmarks.mjs [max_results] [--expansions]
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function loadDevVars() {
  const vars = {};
  for (const line of readFileSync(join(root, ".dev.vars"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return vars;
}

// RFC 3986 percent-encoding, as OAuth 1.0a requires.
const enc = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function oauthHeader(method, url, query, creds) {
  const oauth = {
    oauth_consumer_key: creds.X_CONSUMER_KEY,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.X_ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  const params = Object.entries({ ...query, ...oauth })
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method, enc(url), enc(params)].join("&");
  const key = `${enc(creds.X_CONSUMER_SECRET)}&${enc(creds.X_ACCESS_TOKEN_SECRET)}`;
  oauth.oauth_signature = createHmac("sha1", key).update(base).digest("base64");
  return "OAuth " + Object.entries(oauth).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(", ");
}

const creds = loadDevVars();
for (const k of ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]) {
  if (!creds[k]) throw new Error(`missing ${k} in .dev.vars`);
}

// OAuth 1.0a access tokens are "<user_id>-<random>".
const userId = creds.X_ACCESS_TOKEN.split("-")[0];
const maxResults = process.argv.find((a) => /^\d+$/.test(a)) ?? "10";
const withExpansions = process.argv.includes("--expansions");

const url = `https://api.x.com/2/users/${userId}/bookmarks`;
const query = {
  max_results: maxResults,
  "tweet.fields": "created_at,author_id,conversation_id,entities,note_tweet,public_metrics,attachments",
  ...(withExpansions && {
    expansions: "author_id,referenced_tweets.id,attachments.media_keys",
    "user.fields": "username,name",
    "media.fields": "type,url,preview_image_url,alt_text",
  }),
};

const res = await fetch(`${url}?${new URLSearchParams(query)}`, {
  headers: { Authorization: oauthHeader("GET", url, query, creds) },
});
const body = await res.json();

console.log(`HTTP ${res.status}  user_id=${userId}  max_results=${maxResults}  expansions=${withExpansions}`);
for (const h of ["x-rate-limit-limit", "x-rate-limit-remaining", "x-rate-limit-reset"]) {
  if (res.headers.get(h)) console.log(`${h}: ${res.headers.get(h)}`);
}

if (!res.ok) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(1);
}

const outDir = join(root, "scripts/spike/out");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `bookmarks-${withExpansions ? "exp" : "plain"}-${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify(body, null, 2));

const tweets = body.data ?? [];
console.log(`returned ${tweets.length} posts, meta=${JSON.stringify(body.meta)}`);
console.log(`includes: ${Object.entries(body.includes ?? {}).map(([k, v]) => `${k}=${v.length}`).join(", ") || "none"}`);
for (const t of tweets) {
  const long = t.note_tweet ? ` [note_tweet ${t.note_tweet.text.length} chars]` : "";
  const urls = (t.entities?.urls ?? []).map((u) => u.expanded_url).filter((u) => !u.includes("x.com/") && !u.includes("twitter.com/"));
  console.log(`- ${t.id} ${t.created_at}${long}  ${t.text.slice(0, 80).replace(/\s+/g, " ")}${urls.length ? `  → ${urls.join(" ")}` : ""}`);
}
console.log(`saved raw response → ${outFile}`);
