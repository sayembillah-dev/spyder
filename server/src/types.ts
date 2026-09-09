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
}

export type SitePhase = 'detecting' | 'scraping' | 'done' | 'error';

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
