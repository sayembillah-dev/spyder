/**
 * Block / challenge-page detection.
 *
 * A Cloudflare interstitial rendering "Checking your browser" yields zero
 * products and is otherwise INDISTINGUISHABLE from a page with no deals.
 * Without this signal you cannot tell "site has nothing" from "we got
 * walled" — and Phase 4's strategy cache must never learn from a block.
 */

const BLOCK_SIGNALS = new RegExp(
  [
    'just a moment',
    'checking your browser',
    'attention required',
    'access denied',
    'verify you are human',
    'unusual traffic',
    'captcha',
    'cf-browser-verification',
    'are you a robot',
    'request blocked',
  ].join('|'),
  'i',
);

/**
 * Returns a human-readable reason when the response looks like a bot wall,
 * else null. `status` is the HTTP status when the server gave one.
 */
export function detectBlock(html: string, status?: number): string | null {
  if (status === 403 || status === 429) return `HTTP ${status}`;
  // challenge banners always render near the top — no need to scan megabytes
  const head = html.slice(0, 20_000);
  const m = head.match(BLOCK_SIGNALS);
  return m ? `challenge page ("${m[0]}")` : null;
}
