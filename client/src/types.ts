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
}

export type SitePhase = 'detecting' | 'scraping' | 'done' | 'error';

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
