/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) throw new RangeError("percentile of an empty array");
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i]!;
}

/** Median (mean of the two middle values for even lengths), rounded. */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor((s.length - 1) / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m]! + s[m + 1]!) / 2);
}

/** p25 / p50 / p75 of a list, rounded. */
export function quartiles(xs: number[]): { low: number; mid: number; high: number } | null {
  if (!xs.length) return null;
  const s = xs.map((x) => Math.round(x)).sort((a, b) => a - b);
  return { low: percentile(s, 25), mid: percentile(s, 50), high: percentile(s, 75) };
}

/** Parse a loosely formatted positive number ("1,250,000", "85 מ״ר"); null when absent or ≤ 0. */
export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}
