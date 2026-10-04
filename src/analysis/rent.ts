// Rent listings → a monthly-rent estimate.
//
// Israel has no rent registry (leases are not reported to the Tax Authority), so rent comes from
// ASKING rents on the listing boards. Residential rents are bucketed by room count, the way the
// market quotes them; commercial rents are priced per m².
import type { AssetType, Comp, Estimate } from "../types.js";
import { quartiles } from "../util/stats.js";

export type RoomBucket = "1-2" | "3" | "4" | "5+";

export function roomBucket(rooms: number | null | undefined): RoomBucket | null {
  if (rooms == null || !Number.isFinite(rooms) || rooms <= 0) return null;
  if (rooms < 2.5) return "1-2";
  if (rooms < 3.5) return "3";
  if (rooms < 4.5) return "4";
  return "5+";
}

/** The same flat is often listed on both boards — keep one. */
export function dedupeListings(comps: Comp[]): Comp[] {
  const seen = new Set<string>();
  const out: Comp[] = [];
  for (const c of comps) {
    const key = [c.price, c.areaSqm, c.rooms, c.street, c.houseNumber, c.floor].join("|");
    const strong = c.street && c.areaSqm;
    if (strong && seen.has(key)) continue;
    if (strong) seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Plausible monthly asking rents only. Boards carry placeholder prices (₪1, ₪100), per-m² prices
 * typed into the total field, and annual figures; any of them would drag a thin pool.
 */
export function isSaneRent(c: Comp): boolean {
  if (c.price == null || c.price < 500 || c.price > 500_000) return false;
  return c.pricePerSqm == null || (c.pricePerSqm >= 15 && c.pricePerSqm <= 600);
}

export interface RentOptions {
  type: AssetType;
  areaSqm?: number | null;
  rooms?: number | null;
  /** Keep listings within this distance when distances are known. Default 2 km / 3 km commercial. */
  maxDistanceM?: number;
  /** Minimum listings for an estimate. Default 5. */
  minListings?: number;
  sourceLabel: string;
}

/**
 * Residential: the median asking rent of the subject's room bucket (p25–p75 as the band),
 * widened to every bucket when the bucket is thin, and narrowed to similar-size flats when
 * enough remain. Commercial: the ₪/m²/month quartiles × area.
 */
export function rentEstimate(listings: Comp[], opts: RentOptions): Estimate | null {
  const residential = opts.type === "apartment" || opts.type === "house";
  const minListings = opts.minListings ?? 5;
  const maxDistanceM = opts.maxDistanceM ?? (residential ? 2_000 : 3_000);
  const area = opts.areaSqm && opts.areaSqm > 0 ? opts.areaSqm : null;

  let pool = listings.filter(isSaneRent);
  const near = pool.filter((c) => c.distanceM == null || c.distanceM <= maxDistanceM);
  if (near.length >= minListings) pool = near;
  if (!pool.length) return null;

  if (!residential) {
    const priced = pool.filter((c) => c.pricePerSqm && c.pricePerSqm > 0);
    let candidates = priced;
    if (area) {
      const similar = priced.filter((c) => (c.areaSqm as number) / area <= 4 && area / (c.areaSqm as number) <= 4);
      if (similar.length >= minListings) candidates = similar;
    }
    if (candidates.length < Math.min(minListings, 3)) return null;
    const q = quartiles(candidates.map((c) => c.pricePerSqm as number))!;
    return {
      perSqm: q,
      value: area ? { low: Math.round(q.low * area), mid: Math.round(q.mid * area), high: Math.round(q.high * area) } : null,
      count: candidates.length,
      method: `${candidates.length} commercial asking rents, ₪/m² × area · ${opts.sourceLabel}`,
    };
  }

  // A residential listing with neither rooms nor area says nothing about comparability.
  pool = pool.filter((c) => c.rooms != null || c.areaSqm != null);
  if (!pool.length) return null;

  const bucket = roomBucket(opts.rooms);
  let candidates = bucket ? pool.filter((c) => roomBucket(c.rooms) === bucket) : pool;
  let label = bucket ? `${bucket}-room` : "all-size";
  if (candidates.length < minListings) {
    candidates = pool;
    label = bucket ? `all-size (thin ${bucket}-room bucket)` : label;
  }
  if (area) {
    const similar = candidates.filter((c) => c.areaSqm && c.areaSqm / area <= 1.5 && area / c.areaSqm <= 1.5);
    if (similar.length >= minListings) {
      candidates = similar;
      label += ", similar size";
    }
  }
  if (candidates.length < Math.min(minListings, 3)) return null;
  const q = quartiles(candidates.map((c) => c.price as number))!;
  const ppm = quartiles(candidates.map((c) => c.pricePerSqm).filter((v): v is number => v != null && v > 0));
  return {
    value: q,
    perSqm: ppm,
    count: candidates.length,
    method: `${candidates.length} ${label} asking rents · ${opts.sourceLabel}`,
  };
}

/** Gross annual yields used to derive commercial rent from value when no listings exist. */
export const COMMERCIAL_GROSS_YIELD = { low: 0.06, mid: 0.07, high: 0.08 } as const;

/** Income-approach rent: sale ₪/m² × gross yield ÷ 12. */
export function rentFromSaleBand(sale: Estimate, areaSqm: number | null | undefined): Estimate | null {
  if (!sale.perSqm) return null;
  const perSqm = {
    low: Math.round(((sale.perSqm.low * COMMERCIAL_GROSS_YIELD.low) / 12) * 10) / 10,
    mid: Math.round(((sale.perSqm.mid * COMMERCIAL_GROSS_YIELD.mid) / 12) * 10) / 10,
    high: Math.round(((sale.perSqm.high * COMMERCIAL_GROSS_YIELD.high) / 12) * 10) / 10,
  };
  const area = areaSqm && areaSqm > 0 ? areaSqm : null;
  return {
    perSqm,
    value: area ? { low: Math.round(perSqm.low * area), mid: Math.round(perSqm.mid * area), high: Math.round(perSqm.high * area) } : null,
    count: sale.count,
    method: `derived from the sale band at 6–8% gross yield (no rent listings)`,
  };
}
