// Combine per-source estimates into one figure.
import type { Band, Estimate, SourceId } from "../types.js";

export interface WeightedEstimate {
  source: SourceId;
  estimate: Estimate;
}

/** Comps beyond this count stop adding weight, so one dense source cannot drown the other. */
const WEIGHT_CAP = 30;

const weighted = (parts: { band: Band; w: number }[]): Band => {
  const total = parts.reduce((s, p) => s + p.w, 0);
  const pick = (k: keyof Band) => Math.round(parts.reduce((s, p) => s + p.band[k] * p.w, 0) / total);
  return { low: pick("low"), mid: pick("mid"), high: pick("high") };
};

/**
 * Comp-count-weighted average of the sources' bands (each capped at {@link WEIGHT_CAP}). Bands are
 * blended per unit: ₪/m² with ₪/m², whole-property values with whole-property values.
 */
export function blendEstimates(parts: WeightedEstimate[]): (Estimate & { sources: SourceId[] }) | null {
  if (!parts.length) return null;
  if (parts.length === 1) return { ...parts[0]!.estimate, sources: [parts[0]!.source] };
  const w = (e: Estimate) => Math.max(1, Math.min(e.count, WEIGHT_CAP));
  const perSqm = parts.filter((p) => p.estimate.perSqm).map((p) => ({ band: p.estimate.perSqm!, w: w(p.estimate) }));
  const value = parts.filter((p) => p.estimate.value).map((p) => ({ band: p.estimate.value!, w: w(p.estimate) }));
  return {
    perSqm: perSqm.length ? weighted(perSqm) : null,
    value: value.length ? weighted(value) : null,
    count: parts.reduce((s, p) => s + p.estimate.count, 0),
    method: `comp-weighted blend of ${parts.map((p) => `${p.source} (${p.estimate.count})`).join(" + ")}`,
    sources: parts.map((p) => p.source),
  };
}
