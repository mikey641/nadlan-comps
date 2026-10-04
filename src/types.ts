// Public types for nadlan-comps.

/** The kind of asset being valued. Drives which sources run and which comps count. */
export type AssetType =
  | "apartment"
  | "house"
  | "office"
  | "retail"
  | "warehouse"
  | "industrial"
  | "commercial";

/** Which side of the market to value. */
export type DealKind = "sale" | "rent";

/** The four data sources this package knows how to read. */
export type SourceId = "govmap" | "nadlan-gov" | "madlan" | "yad2";

/** The single asset to value. Hebrew input is preferred; English addresses are geocoded via GovMap. */
export interface AssetInput {
  /** City / settlement, e.g. "תל אביב - יפו", "Petah Tikva". Required. */
  city: string;
  /** Street and house number, e.g. "רוטשילד 10" or "Rothschild 10". Strongly recommended. */
  address?: string;
  /** Neighborhood name, used to pick the nadlan.gov.il neighborhood median when available. */
  neighborhood?: string;
  /** Asset type. Residential types use dwelling comps; the rest use commercial comps. */
  type: AssetType;
  /** Area in m². Without it you get ₪/m² bands but no whole-property value. */
  areaSqm?: number;
  /** Room count (Israeli convention, 3.5 etc.). Used to bucket rent comps. */
  rooms?: number;
  /** Floor number. Informational; reported back on the normalized asset. */
  floor?: number;
  /** WGS84 coordinates. Optional — resolved from the address via GovMap when missing. */
  location?: { lat: number; lng: number };
}

/** A minimal browser handle. Pass your own, or let the package launch patchright/playwright. */
export interface BrowserLike {
  newContext(options?: Record<string, unknown>): Promise<BrowserContextLike>;
  close(): Promise<void>;
}
export interface BrowserContextLike {
  newPage(): Promise<any>;
  close(): Promise<void>;
}

export interface Logger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
}

export interface ValueAssetOptions {
  /** Which deals to value. Default: both sale and rent. */
  deals?: DealKind[];
  /** Restrict to a subset of sources. Default: every source applicable to the asset type. */
  sources?: SourceId[];
  /**
   * Browser for Madlan and Yad2 (both sit behind bot protection and need a real browser).
   *  - `"auto"` (default): launch headless patchright, else playwright, if installed; otherwise skip.
   *  - `false`: never launch a browser; browser-only sources are reported as skipped.
   *  - a Browser instance (patchright / playwright / puppeteer-compatible `newContext`).
   */
  browser?: "auto" | false | BrowserLike;
  /** Launch options when `browser` is "auto". */
  browserLaunch?: { headless?: boolean; executablePath?: string; proxy?: string };
  /**
   * Optional Yad2 relay (see relay/cloudflare-yad2). When set, Yad2 is read over plain HTTP
   * through the relay instead of a browser — useful on servers whose IPs Yad2 blocks.
   */
  yad2Relay?: { url: string; token?: string };
  /** Recency window, months, for the primary comp band. Default 36. */
  monthsBack?: number;
  /** Per-source timeout, ms. Default 90 000. */
  sourceTimeoutMs?: number;
  /** Abort the whole valuation. */
  signal?: AbortSignal;
  /** Include each source's raw comps on the report. Default true. */
  includeComps?: boolean;
  /** Progress logging. Default: silent. */
  logger?: Logger;
  /** Override `fetch` (testing, proxies). */
  fetch?: typeof fetch;
}

/** A normalized comparable — a closed deal (GovMap/Madlan) or an asking-price listing (Yad2/Madlan). */
export interface Comp {
  source: SourceId;
  kind: "deal" | "listing";
  deal: DealKind;
  id: string;
  /** Deal date (YYYY-MM-DD) for closed deals; null for live listings. */
  date: string | null;
  /** ₪ for sales, ₪/month for rent. */
  price: number | null;
  areaSqm: number | null;
  /** ₪/m² for sales, ₪/m²/month for rent. */
  pricePerSqm: number | null;
  rooms: number | null;
  floor: string | null;
  propertyType: string | null;
  street: string | null;
  houseNumber: string | null;
  neighborhood: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  /** Distance from the subject, meters, when both points are known. */
  distanceM: number | null;
  url: string | null;
}

/** A low / mid / high band. Values are ₪ (sale) or ₪/month (rent). */
export interface Band {
  low: number;
  mid: number;
  high: number;
}

export interface Estimate {
  /** Whole-property value; null when the area is unknown and the source only yields ₪/m². */
  value: Band | null;
  /** ₪/m² (sale) or ₪/m²/month (rent); null when the source only yields whole-property medians. */
  perSqm: Band | null;
  /** How many comps fed this estimate. */
  count: number;
  /** One-line human-readable provenance. */
  method: string;
}

export type SourceStatus = "ok" | "no-data" | "blocked" | "skipped" | "error";

export interface SourceResult {
  source: SourceId;
  deal: DealKind;
  status: SourceStatus;
  /** Why the source was skipped, blocked, empty or failed. */
  reason?: string;
  estimate: Estimate | null;
  comps: Comp[];
  durationMs: number;
}

export interface DealValuation {
  /** The blended estimate across sources; null when no source produced one. */
  estimate: (Estimate & { sources: SourceId[] }) | null;
  sources: SourceResult[];
}

export interface ResolvedAsset extends AssetInput {
  /** Canonical Hebrew address as GovMap knows it ("רוטשילד 10 פתח תקווה"). */
  canonicalAddress: string | null;
  /** CBS settlement code (סמל יישוב), used by nadlan.gov.il. */
  settlementCode: string | null;
  segment: "residential" | "commercial";
}

export interface ValuationReport {
  asset: ResolvedAsset;
  sale: DealValuation | null;
  rent: DealValuation | null;
  /** Non-fatal notes: geocoding fallbacks, blocked sources, assumptions. */
  warnings: string[];
  generatedAt: string;
  durationMs: number;
}
