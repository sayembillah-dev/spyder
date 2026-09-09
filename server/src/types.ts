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

export interface SiteReport {
  url: string;
  site: string;
  renderType: RenderType | null;
  status: 'ok' | 'error';
  productCount: number;
  durationMs: number;
  error?: string;
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
  method?: 'fast-html' | 'browser';
  message: string;
  count?: number;
  durationMs?: number;
}
