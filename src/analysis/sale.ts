// Sale comps → a ₪/m² band and a whole-property value.
import { indexAt, type IndexPoint } from "../sources/cbs.js";
import { natureClass, type NatureClass } from "../sources/govmap.js";
import type { AssetType, Comp, Estimate } from "../types.js";
import { quartiles } from "../util/stats.js";

const COMMERCIAL: NatureClass[] = ["office", "retail", "warehouse", "industrial", "hotel"];

/**
 * Comp pools to try, most specific first. Every recency window of the exact class is tried
 * before widening to any commercial class — five-year-old office deals beat fresh warehouse deals.
 */
export function poolsFor(type: AssetType): { classes: NatureClass[]; label: string }[] {
  switch (type) {
    case "apartment":
    case "house":
      // Registry rows without a nature are overwhelmingly dwellings.
      return [{ classes: ["residential", "unknown"], label: "residential" }];
    case "office":
      return [{ classes: ["office"], label: "office" }, { classes: COMMERCIAL, label: "commercial (widened)" }];
    case "retail":
      return [{ classes: ["retail"], label: "retail" }, { classes: COMMERCIAL, label: "commercial (widened)" }];
    case "warehouse":
      return [{ classes: ["warehouse"], label: "warehouse" }, { classes: COMMERCIAL, label: "commercial (widened)" }];
    case "industrial":
      return [
        { classes: ["industrial", "warehouse"], label: "industrial" },
        { classes: COMMERCIAL, label: "commercial (widened)" },
      ];
    case "commercial":
      return [{ classes: COMMERCIAL, label: "commercial" }];
  }
}

/** Madlan deals are residential by construction; GovMap deals carry their own nature. */
const classOf = (c: Comp): NatureClass => (c.source === "madlan" ? "residential" : natureClass(c.propertyType));

/**
 * Plausible whole-asset transactions only. The registry holds ₪370k "deals" on 1 m² (parking
 * spots, sub-parcel artifacts) whose ₪/m² would poison every percentile.
 */
export function isSaneSale(c: Comp): boolean {
  return (
    c.pricePerSqm != null &&
    (c.price ?? 0) >= 100_000 &&
    (c.areaSqm ?? 0) >= 8 &&
    c.pricePerSqm >= 2_000 &&
    c.pricePerSqm <= 200_000
  );
}

/** Sane, exact-class deals within `months` — the "do we have enough yet?" test for radius widening. */
export function exactClassCount(comps: Comp[], type: AssetType, months: number, now = new Date()): number {
  const classes = poolsFor(type)[0]!.classes;
  const cutoff = monthsAgo(now, months);
  return comps.filter((c) => isSaneSale(c) && classes.includes(classOf(c)) && c.date && c.date >= cutoff).length;
}

const monthsAgo = (now: Date, months: number): string => {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
};

export interface SaleBandOptions {
  type: AssetType;
  areaSqm?: number | null;
  /** Primary recency window; then 2× that, then all history. Default 36. */
  monthsBack?: number;
  /** Minimum comps for a band. Default 5 residential / 4 commercial. */
  minComps?: number;
  /** CBS dwellings price index — restates each deal's ₪/m² at today's level. */
  index?: IndexPoint[];
  now?: Date;
  sourceLabel: string;
}

/**
 * A p25 / p50 / p75 ₪/m² band from comparable deals of the asset's class, scaled by area.
 *
 * Comparability beyond class and recency:
 *  • time — with `index`, a deal's ₪/m² is multiplied by index(latest) / index(deal month), so a
 *    thin market that reaches back years does not compare 2012 shekels with today's. For
 *    commercial classes the dwellings index is a proxy (Israel publishes no commercial index).
 *  • size — when the subject's area is known and enough comps remain, deals more than 6× larger
 *    or smaller are dropped: a 1,200 m² anchor store is not a comp for a 60 m² shop.
 */
export function saleBand(comps: Comp[], opts: SaleBandOptions): Estimate | null {
  const months = opts.monthsBack ?? 36;
  const residential = opts.type === "apartment" || opts.type === "house";
  const minComps = opts.minComps ?? (residential ? 5 : 4);
  const area = opts.areaSqm && opts.areaSqm > 0 ? opts.areaSqm : null;
  const now = opts.now ?? new Date();
  const sane = comps.filter(isSaneSale);

  const idx = [...(opts.index ?? [])].sort((a, b) => (a.month < b.month ? -1 : 1));
  const latest = idx.length ? idx[idx.length - 1]! : null;
  const restated = (c: Comp): number => {
    const ppm = c.pricePerSqm as number;
    if (!latest || !c.date) return ppm;
    const at = indexAt(idx, `${c.date.slice(0, 7)}-01`);
    return at && at > 0 ? ppm * (latest.value / at) : ppm;
  };

  for (const pool of poolsFor(opts.type)) {
    const inClass = sane.filter((c) => pool.classes.includes(classOf(c)));
    for (const window of [months, months * 2, null] as (number | null)[]) {
      let candidates = window == null ? inClass : inClass.filter((c) => c.date && c.date >= monthsAgo(now, window));
      if (area) {
        const similar = candidates.filter((c) => {
          const s = c.areaSqm as number;
          return s / area <= 6 && area / s <= 6;
        });
        if (similar.length >= minComps) candidates = similar;
      }
      if (candidates.length < minComps) continue;
      const q = quartiles(candidates.map(restated))!;
      const parts = [
        `${candidates.length} ${pool.label} deals`,
        window ? `last ${window} mo` : "all history",
        latest ? `restated to ${latest.month.slice(0, 7)} by CBS index` : null,
        opts.sourceLabel,
      ];
      return {
        perSqm: q,
        value: area ? { low: Math.round(q.low * area), mid: Math.round(q.mid * area), high: Math.round(q.high * area) } : null,
        count: candidates.length,
        method: parts.filter(Boolean).join(" · "),
      };
    }
  }
  return null;
}
