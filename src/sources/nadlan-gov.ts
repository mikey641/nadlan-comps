// nadlan.gov.il published medians.
//
// The site's per-deal API is behind reCAPTCHA Enterprise, but it publishes city and neighborhood
// median prices — to buy and to rent, per room count — as open static JSON on data.nadlan.gov.il.
// These are whole-property medians (not ₪/m²), and the rent series has been frozen since ~2021,
// so callers roll them forward with the CBS indices (see cbs.ts).
import { getJson, type HttpContext } from "../util/http.js";
import { placeKey } from "../util/text.js";

const BASE = "https://data.nadlan.gov.il/api/pages";

export interface NadlanGovMedian {
  low: number;
  mid: number;
  high: number;
  /** Median per room bucket ("3", "4", "5"), as published. */
  perRoom: Record<string, number>;
  /** Month of the latest data point, YYYY-MM-01. */
  asOf: string | null;
  scope: "neighborhood" | "settlement";
  /** Place name as nadlan.gov.il labels it. */
  label: string;
  url: string;
}

export interface NadlanGovPage {
  settlementName?: string;
  neighborhoodName?: string;
  otherNeighborhoods?: { title: string; id: number }[];
  trends?: { rooms?: { numRooms: string | number; graphData?: Record<string, number>[] }[] };
}

/** Collapse the per-room median series into a low / mid / high whole-property band. */
export function medianFromPage(
  page: NadlanGovPage,
  field: "settlementPrice" | "neighborhoodPrice",
): Omit<NadlanGovMedian, "scope" | "label" | "url"> | null {
  const rooms = page?.trends?.rooms ?? [];
  const latestPoint = (s: (typeof rooms)[number] | undefined) => {
    const g = (s?.graphData ?? []).filter((x) => x[field] != null);
    return g.length ? g[g.length - 1]! : null;
  };
  const value = (s: (typeof rooms)[number] | undefined) => {
    const p = latestPoint(s);
    const v = p ? Number(p[field]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const monthOf = (s: (typeof rooms)[number] | undefined) => {
    const p = latestPoint(s);
    return p?.year && p?.month ? `${p.year}-${String(p.month).padStart(2, "0")}-01` : null;
  };

  const all = rooms.find((s) => String(s.numRooms).toLowerCase() === "all");
  const perRoom: Record<string, number> = {};
  for (const s of rooms) {
    if (s === all) continue;
    const v = value(s);
    const key = String(s.numRooms ?? "").trim();
    if (key && v != null) perRoom[key] = v;
  }
  const allMid = value(all);
  const values = [...Object.values(perRoom), ...(allMid != null ? [allMid] : [])];
  if (!values.length) return null;
  // The weighted "all rooms" median is the representative mid; room buckets bracket it.
  const sorted = [...values].sort((a, b) => a - b);
  const mid = allMid ?? sorted[Math.floor((sorted.length - 1) / 2)]!;
  return {
    low: sorted[0]!,
    mid,
    high: sorted[sorted.length - 1]!,
    perRoom,
    asOf: monthOf(all) ?? monthOf(rooms.find((s) => value(s) != null)),
  };
}

/** The published room bucket closest to `rooms` ("3", "4", "5"). */
export function roomBucketValue(perRoom: Record<string, number>, rooms: number | null | undefined): number | null {
  if (rooms == null || !Number.isFinite(rooms)) return null;
  const keys = Object.keys(perRoom)
    .map((k) => [k, Number(k)] as const)
    .filter(([, n]) => Number.isFinite(n));
  if (!keys.length) return null;
  const [best] = keys.reduce((a, b) => (Math.abs(b[1] - rooms) < Math.abs(a[1] - rooms) ? b : a));
  return perRoom[best] ?? null;
}

/**
 * The most precise published median for a place: the neighborhood file when `neighborhood`
 * matches one of the settlement's neighborhoods, otherwise the city file.
 */
export async function nadlanGovMedian(
  ctx: HttpContext,
  kind: "buy" | "rent",
  settlementCode: string,
  neighborhood?: string | null,
): Promise<NadlanGovMedian | null> {
  const cityUrl = `${BASE}/settlement/${kind}/${settlementCode}.json`;
  const city = await getJson<NadlanGovPage>(ctx, "nadlan.gov.il", cityUrl);

  const want = placeKey(neighborhood);
  const match = want
    ? (city.otherNeighborhoods ?? []).find((n) => placeKey(n.title) === want) ??
      (city.otherNeighborhoods ?? []).find((n) => placeKey(n.title).includes(want) || want.includes(placeKey(n.title)))
    : undefined;
  if (match) {
    const url = `${BASE}/neighborhood/${kind}/${match.id}.json`;
    try {
      const page = await getJson<NadlanGovPage>(ctx, "nadlan.gov.il", url);
      const m = medianFromPage(page, "neighborhoodPrice");
      if (m) return { ...m, scope: "neighborhood", label: `${page.neighborhoodName ?? match.title}, ${page.settlementName ?? ""}`.replace(/, $/, ""), url };
    } catch {
      // A missing neighborhood file falls back to the city median below.
    }
  }

  const m = medianFromPage(city, "settlementPrice");
  return m ? { ...m, scope: "settlement", label: city.settlementName ?? settlementCode, url: cityUrl } : null;
}
