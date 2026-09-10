/** Uniform product shape returned by every scraper, regardless of source site. */
export interface ScrapedProduct {
  id: string;
  title: string;
  originalPrice: number | null;
  dealPrice: number;
  discountPercentage: number | null;
  currency: string; // ISO-ish: 'BDT' | 'USD' | ...
  sourceSite: string; // e.g. 'Chaldal', 'Pickaboo'
  productUrl: string;
  imageUrl: string | null;
}

export type RenderType = 'SSR' | 'CSR';

/** Which rung of the universal strategy ladder produced the result. */
export type ScrapeMethod = 'fast-html' | 'browser' | 'browser-clean';

export interface SiteReport {
  url: string;
  site: string;
  renderType: RenderType | null;
  /** 'blocked' = a bot wall/challenge page answered — NOT the same as
   *  "no deals"; see utils/block.ts. A block must never poison caches. */
  status: 'ok' | 'error' | 'blocked';
  productCount: number;
  durationMs: number;
  /** Winning strategy of the universal ladder (present on ok results). */
  method?: ScrapeMethod;
  error?: string;
  /** Why we believe we were blocked (present on blocked results). */
  blockReason?: string;
  /** Extraction quality of the winning attempt (0..1 + diagnostics). */
  quality?: import('./utils/quality').ExtractionQuality;
  /** Discovery provenance (D7.4): the domain whose discovery run produced
   *  this target, and the candidate's blended finalScore. */
  discoveredFrom?: string;
  candidateScore?: number;
}

export interface ComparisonGroup {
  key: string;
  representativeTitle: string;
  items: ScrapedProduct[]; // sorted cheapest first
  bestPrice: number;
  worstPrice: number;
  savings: number;
  savingsPercent: number;
}

export interface ScrapeResult {
  products: ScrapedProduct[];
  comparisons: ComparisonGroup[];
  report: SiteReport[];
  totalDurationMs: number;
  /** One report per domain that went through deal-page discovery (D7.4). */
  discovery?: DiscoveryReport[];
}

/* ── Deal-page discovery (DISCOVERY_PLAN D0.1) ─────────────────────────
 * A candidate is a HYPOTHESIS until verified: keyword match earns a fetch,
 * only measured deal density earns a full crawl. */

export type CandidateSource =
  | 'root' // the domain itself — sometimes the homepage IS the sale page
  | 'nav' // header / mega-menu anchor
  | 'hero' // above-the-fold banner link
  | 'body' // in-content anchor
  | 'footer'
  | 'sitemap'
  | 'probe' // conventional path guess
  | 'platform' // platform-specific known route (Shopify collections, …)
  | 'network' // campaign endpoint seen during a browser render
  | 'expanded' // found on a page that itself verified as a deal hub
  | 'memo' // remembered from a previous run
  | 'user'; // pinned by hand via the API — a user fact, not a machine guess

export interface DealCandidate {
  url: string; // canonical form (D1.2)
  source: CandidateSource;
  /** Human-readable justification — shown in the UI, invaluable in tests. */
  evidence: string[];
  priorScore: number; // 0..1, pre-fetch (D2)
  /** The merchant's OWN label for the link ("Eid Flash Sale") — becomes the
   *  registry record's label (D6.1). */
  label?: string | null;
  verified?: VerificationResult;
  finalScore?: number; // 0..1, blended (D4.3)
}

export interface VerificationResult {
  productCount: number;
  /** Fraction of products carrying an originalPrice or discountPercentage. */
  dealDensity: number;
  medianDiscountPct: number | null;
  quality: import('./utils/quality').ExtractionQuality;
  hasCountdown: boolean; // structural flash-sale tell
  renderType: RenderType;
  /** Hash of the top-N normalized titles — collapses duplicate listings. */
  productFingerprint: string;
  rejectedReason?: string;
}

export interface DiscoveryReport {
  domain: string;
  platform: string | null;
  candidatesFound: number;
  candidatesVerified: number;
  selected: DealCandidate[]; // what actually got scraped
  rejected: DealCandidate[]; // with reasons — the debugging surface
  fetchCount: number;
  durationMs: number;
  fromMemo: boolean;
  budgetExhausted: boolean;
}

/** D7.1 — per-request discovery options on POST /api/scrape. */
export interface DiscoveryRequestOptions {
  /** 'auto' = discover for bare domains / site roots (default); 'always' =
   *  discover even for deep paths (the explicit path still scrapes too);
   *  'never' = old behavior — every target is scraped exactly as given. */
  enabled?: 'auto' | 'always' | 'never';
  /** Cap on verified deal pages scraped per domain (default: config). */
  maxScrape?: number;
  /** Post-filter: keep only products at least this discounted. */
  minDiscountPercent?: number;
  /** User pins — exact URLs/paths or `*` globs. Skip scoring, still
   *  verified, never skipped by tier early-exits. */
  include?: string[];
  /** User exclusions — same pattern language; matched URLs are never
   *  fetched and show up in the report's rejected list. */
  exclude?: string[];
}

export type SitePhase = 'discovering' | 'verifying' | 'detecting' | 'scraping' | 'done' | 'error';

export interface SiteStatusEvent {
  url: string;
  site: string;
  phase: SitePhase;
  renderType?: RenderType;
  method?: ScrapeMethod;
  message: string;
  count?: number;
  durationMs?: number;
  /** Quality score of the final attempt (0..1), present on done. */
  qualityScore?: number;
  qualityFlags?: string[];
  /** Anti-bot challenge answered — present on the blocked done event. */
  blockReason?: string;
}
