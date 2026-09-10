/** Mirrors server/src/types.ts — keep in sync. */
export interface ScrapedProduct {
  id: string;
  title: string;
  originalPrice: number | null;
  dealPrice: number;
  discountPercentage: number | null;
  currency: string;
  sourceSite: string;
  productUrl: string;
  imageUrl: string | null;
}

export type RenderType = 'SSR' | 'CSR';

/** Mirrors server/src/utils/quality.ts — extraction confidence breakdown. */
export interface ExtractionQuality {
  score: number; // 0..1
  productCount: number;
  pctWithRealLink: number;
  pctWithImage: number;
  pctWithOriginalPrice: number;
  claimedTotal: number | null;
  coverage: number | null;
  flags: string[];
}

/** Where discovery first saw a candidate (server: CandidateSource). */
export type CandidateSource =
  | 'root'
  | 'nav'
  | 'hero'
  | 'body'
  | 'footer'
  | 'sitemap'
  | 'probe'
  | 'platform'
  | 'network'
  | 'expanded'
  | 'memo'
  | 'user';

/** A deal-page candidate, pre/post verification (server: DealCandidate). */
export interface DealCandidate {
  url: string;
  source: CandidateSource;
  evidence: string[];
  priorScore: number;
  label?: string | null;
  verified?: VerificationResult;
  finalScore?: number;
}

/** The verification verdict for one candidate (server: VerificationResult). */
export interface VerificationResult {
  productCount: number;
  dealDensity: number;
  medianDiscountPct: number | null;
  quality: ExtractionQuality;
  hasCountdown: boolean;
  renderType: RenderType;
  productFingerprint: string;
  rejectedReason?: string;
}

/** One domain's full discovery story (server: DiscoveryReport). */
export interface DiscoveryReport {
  domain: string;
  platform: string | null;
  candidatesFound: number;
  candidatesVerified: number;
  selected: DealCandidate[];
  rejected: DealCandidate[];
  fetchCount: number;
  durationMs: number;
  fromMemo: boolean;
  budgetExhausted: boolean;
}

/** Per-request discovery knobs (server: DiscoveryRequestOptions). */
export interface DiscoveryRequestOptions {
  enabled?: 'auto' | 'always' | 'never';
  maxScrape?: number;
  minDiscountPercent?: number;
  include?: string[];
  exclude?: string[];
}

export interface SiteReport {
  url: string;
  site: string;
  renderType: RenderType | null;
  status: 'ok' | 'error' | 'blocked';
  productCount: number;
  durationMs: number;
  method?: 'fast-html' | 'browser' | 'browser-clean';
  error?: string;
  blockReason?: string;
  /** Extraction quality of the winning attempt (0..1 + diagnostics). */
  quality?: ExtractionQuality;
  /** Provenance, when this page came out of discovery (D7.4). */
  discoveredFrom?: string;
  candidateScore?: number;
}

export interface ComparisonGroup {
  key: string;
  representativeTitle: string;
  items: ScrapedProduct[];
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
  /** One per domain that went through discovery this run (D7.2). */
  discovery?: DiscoveryReport[];
}

export type SitePhase =
  | 'discovering'
  | 'verifying'
  | 'detecting'
  | 'scraping'
  | 'done'
  | 'error';

export interface SiteStatusEvent {
  url: string;
  site: string;
  phase: SitePhase;
  renderType?: RenderType;
  method?: 'fast-html' | 'browser' | 'browser-clean';
  message: string;
  count?: number;
  durationMs?: number;
  /** Quality score of the final attempt (0..1), present on done. */
  qualityScore?: number;
  qualityFlags?: string[];
  /** Anti-bot challenge answered — present on the blocked done event. */
  blockReason?: string;
}

/* ── Registry (server/src/discovery/registry.ts — keep in sync) ────────── */

export type RegistryStatus =
  | 'candidate'
  | 'active'
  | 'stale'
  | 'parked'
  | 'excluded'
  | 'pinned';

export interface DealPageRecord {
  id: string;
  url: string;
  domain: string;
  site: string;
  status: RegistryStatus;
  source: CandidateSource;
  evidence: string[];
  label: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastVerifiedAt: number | null;
  lastScrapedAt: number | null;
  lastChangedAt: number | null;
  nextCheckAt: number;
  revisitAfter: number | null;
  finalScore: number;
  dealDensity: number;
  avgProductCount: number;
  medianDiscountPct: number | null;
  productFingerprint: string | null;
  checkCount: number;
  successCount: number;
  consecutiveMisses: number;
  changeRate: number;
  seasonHint: number[];
  userPinned: boolean;
  notes: string | null;
}

/** POST /api/registry response (201, or 200 when the URL was already saved). */
export interface RegistryAddResult {
  record: DealPageRecord;
  verification: VerificationResult;
  existed?: boolean;
}

/** POST /api/registry/:id/refresh response. */
export interface RegistryRefreshResult {
  record: DealPageRecord;
  verification: VerificationResult;
  fingerprintChanged: boolean | null;
  scrape: ScrapeResult | null;
}

/** POST /api/registry/refresh (the manual due-set tick) response. */
export interface RegistryTickResult {
  checked: number;
  results: Array<{
    id: string;
    url: string;
    outcome: 'ok' | 'miss' | 'blocked' | 'skipped';
    reason?: string;
    fingerprintChanged?: boolean;
  }>;
}

/** POST /api/registry/import response. */
export interface RegistryImportResult {
  added: number;
  skipped: number;
}
