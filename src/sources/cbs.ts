// Israel Central Bureau of Statistics (הלשכה המרכזית לסטטיסטיקה) price indices.
//   40010  מדד מחירי דירות      — dwellings price index (transaction based, monthly)
//   120460 מדד מחירי שכר דירה   — dwelling-rent price index
// Used to restate old deals at today's price level and to roll the frozen nadlan.gov medians forward.
import { getJson, type HttpContext } from "../util/http.js";

export interface IndexPoint {
  /** YYYY-MM-01 */
  month: string;
  value: number;
}

export const CBS_SERIES = { homePrices: 40010, rent: 120460 } as const;

const url = (id: number, months: number) =>
  `https://api.cbs.gov.il/index/data/price?id=${id}&format=json&download=false&last=${months}`;

interface RawPoint {
  month: string;
  year: number;
  value: number;
  baseDesc: string;
}

/**
 * CBS rebases its indices periodically ("2024 average = 100"), which breaks a raw series into
 * discontinuous segments. Chain every older base onto the latest one so any two months can be
 * compared with a plain ratio: the link factor from base k to base k+1 is
 * 100 / mean(base-k values during base k+1's reference year).
 */
export function chainToLatestBase(rows: RawPoint[]): IndexPoint[] {
  if (!rows.length) return [];
  const groups: { refYear: number; items: RawPoint[] }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (!last || last.items[0]!.baseDesc !== r.baseDesc) groups.push({ refYear: parseInt(r.baseDesc, 10), items: [r] });
    else last.items.push(r);
  }
  const factor = new Array<number>(groups.length).fill(1);
  for (let k = groups.length - 2; k >= 0; k--) {
    const refYear = groups[k + 1]!.refYear;
    const ref = groups[k]!.items.filter((x) => x.year === refYear).map((x) => x.value);
    const step = ref.length ? 100 / (ref.reduce((a, b) => a + b, 0) / ref.length) : 1;
    factor[k] = factor[k + 1]! * step;
  }
  return groups.flatMap((g, gi) =>
    g.items.map((it) => ({ month: it.month, value: Math.round(it.value * factor[gi]! * 10000) / 10000 })),
  );
}

/** Fetch the last `months` readings of a CBS price index, chained onto one continuous base. */
export async function fetchCbsIndex(ctx: HttpContext, seriesId: number, months = 240): Promise<IndexPoint[]> {
  const json = await getJson<any>(ctx, "cbs", url(seriesId, months));
  const dates: any[] = json?.month?.[0]?.date ?? [];
  const raw: RawPoint[] = dates
    .filter((d) => d?.currBase?.value != null && d?.year && d?.month)
    .map((d) => ({
      month: `${d.year}-${String(d.month).padStart(2, "0")}-01`,
      year: Number(d.year),
      value: Number(d.currBase.value),
      baseDesc: String(d.currBase.baseDesc ?? ""),
    }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
  return chainToLatestBase(raw);
}

/** Index value in force at `month` (the latest point at or before it; the earliest point before the series starts). */
export function indexAt(sorted: IndexPoint[], month: string): number | null {
  let v: number | null = null;
  for (const p of sorted) {
    if (p.month <= month) v = p.value;
    else break;
  }
  return v ?? (sorted.length ? sorted[0]!.value : null);
}

/** Restate `amount` measured at `fromMonth` at the index's latest level. Null when it cannot. */
export function escalate(
  amount: number,
  fromMonth: string | null,
  series: IndexPoint[],
): { value: number; factor: number; fromMonth: string; toMonth: string } | null {
  if (!(amount > 0) || !series.length) return null;
  const sorted = [...series].sort((a, b) => (a.month < b.month ? -1 : 1));
  const from = fromMonth ? indexAt(sorted, fromMonth) : sorted[0]!.value;
  const latest = sorted[sorted.length - 1]!;
  if (!from || from <= 0) return null;
  const factor = latest.value / from;
  return { value: Math.round(amount * factor), factor, fromMonth: fromMonth ?? sorted[0]!.month, toMonth: latest.month };
}
