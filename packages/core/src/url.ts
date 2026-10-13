const TRACKING_PARAMS = [
  /^utm_/i,
  /^(fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|ref_src|ref_url|_hsenc|_hsmi|mkt_tok)$/i,
];

// One URL per article: https, no www, no tracking params, sorted params, no fragment, no trailing slash.
export function canonicalizeUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${url.protocol}`);
  }
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hash = "";
  const kept = [...url.searchParams]
    .filter(([key]) => !TRACKING_PARAMS.some((re) => re.test(key)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = new URLSearchParams(kept).toString();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export async function documentId(canonicalUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalUrl));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `d_${hex.slice(0, 24)}`;
}
