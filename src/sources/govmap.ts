// GovMap — the national mapping portal — serves the Israel Tax Authority (רשות המסים) real-estate
// transaction registry as plain JSON. nadlan.gov.il shows the same deals behind reCAPTCHA; GovMap
// does not gate them, so this runs with plain HTTP from any residential or cloud IP it accepts.
//
//   POST /search-service/autocomplete                address text → point (EPSG:3857)
//   GET  /real-estate/deals/{x},{y}/{radiusM}         point → building polygons in radius
//   GET  /real-estate/street-deals/{polygonId}        deals in that building / street segment
//   GET  /real-estate/neighborhood-deals/{polygonId}  deals across the polygon's neighborhood
//
// The deal endpoints must be called WITHOUT query parameters; extra params currently return 500.
import { isBlocked } from "../errors.js";
import { mercatorToWgs84 } from "../util/geo.js";
import { getJson, type HttpContext } from "../util/http.js";
import { num } from "../util/stats.js";
import { clean, hasHebrew } from "../util/text.js";
import type { Comp } from "../types.js";

const BASE = "https://www.govmap.gov.il/api";

/** One Tax Authority transaction as GovMap returns it, normalized. */
export interface GovmapDeal {
  dealId: string;
  dealDate: string | null;
  price: number | null;
  sizeSqm: number | null;
  pricePerSqm: number | null;
  rooms: number | null;
  floor: string | null;
  /** סוג עסקה / נכס, e.g. "דירה בבית קומות", "חנות", "משרדים". */
  nature: string | null;
  street: string | null;
  houseNum: string | null;
  neighborhood: string | null;
  city: string | null;
  settlementId: string | null;
  gush: string | null;
  parcel: string | null;
  polygonId: string | null;
}

/** Fine-grained property class. An office and a shop trade at very different ₪/m², so bands never mix them. */
export type NatureClass =
  | "residential"
  | "office"
  | "retail"
  | "warehouse"
  | "industrial"
  | "hotel"
  | "land"
  | "parking"
  | "unknown";

export function natureClass(nature: string | null | undefined): NatureClass {
  const s = (nature || "").replace(/\s+/g, "");
  if (!s) return "unknown";
  if (/משרד/.test(s)) return "office";
  if (/חנות|חנוי|מסחר|עסק/.test(s)) return "retail";
  if (/מחסן|מחסנ/.test(s)) return "warehouse"; // final and medial nun: מחסן / מחסנים
  if (/תעשיי?ה|מלאכה/.test(s)) return "industrial";
  if (/מלונ|מלון/.test(s)) return "hotel";
  if (/קרקע|מגרש|ללאתיכנון|ללאתכנון|קומבינציה/.test(s)) return "land";
  if (/חני/.test(s)) return "parking";
  if (/דירה|פנטהאוז|ביתפרטי|דירתגן|קוטג|דו-?משפחתי|מגורים|צמודקרקע|וילה/.test(s)) return "residential";
  return "unknown";
}

export function toGovmapDeal(d: any): GovmapDeal | null {
  if (d?.dealId == null) return null;
  const price = num(d.dealAmount);
  const sizeSqm = num(d.assetArea);
  return {
    dealId: String(d.dealId),
    dealDate: d.dealDate ? String(d.dealDate).slice(0, 10) : null,
    price,
    sizeSqm,
    pricePerSqm: price && sizeSqm ? Math.round(price / sizeSqm) : null,
    rooms: num(d.assetRoomNum),
    floor: d.floorNo != null ? String(d.floorNo) : null,
    nature: d.dealNatureDescription ?? d.propertyTypeDescription ?? null,
    street: d.streetNameHeb ?? null,
    houseNum: d.houseNum != null ? String(d.houseNum).replace(/\.0$/, "") : null,
    neighborhood: d.neighborhood ?? null,
    city: d.settlementNameHeb ?? null,
    settlementId: d.settlementId != null ? String(d.settlementId) : null,
    gush: d.gushNum != null ? String(d.gushNum) : null,
    parcel: d.parcelNum != null ? String(d.parcelNum) : null,
    polygonId: d.polygonId != null ? String(d.polygonId) : null,
  };
}

export interface GeocodeResult {
  /** EPSG:3857 meters, as GovMap's real-estate endpoints expect. */
  x: number;
  y: number;
  lat: number;
  lng: number;
  /** The address text GovMap matched. */
  matched: string;
}

/**
 * Address → point via GovMap's public autocomplete. Hebrew is searched in Hebrew; anything else is
 * tried in English and then Hebrew. Returns null when GovMap answered but does not know the place;
 * throws SourceBlockedError when GovMap did not answer.
 */
export async function geocode(ctx: HttpContext, text: string): Promise<GeocodeResult | null> {
  const languages = hasHebrew(text) ? ["he"] : ["en", "he"];
  for (const language of languages) {
    const data = await getJson<any>(ctx, "govmap", `${BASE}/search-service/autocomplete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ searchText: text, language, isAccurate: false, maxResults: 10 }),
    });
    const results: any[] = data?.results ?? [];
    const hit =
      results.find((r) => r?.type === "address" && /^POINT\(/.test(r?.shape ?? "")) ??
      results.find((r) => /^POINT\(/.test(r?.shape ?? ""));
    const m = hit?.shape?.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/);
    if (m) {
      const x = Number(m[1]);
      const y = Number(m[2]);
      return { x, y, ...mercatorToWgs84(x, y), matched: String(hit.text ?? text) };
    }
  }
  return null;
}

export interface GovmapPolygon {
  polygonId: string;
  street: string | null;
  houseNum: string | null;
  city: string | null;
  dealCount: number;
}

/** Building polygons within `radiusM` of a point, nearest first. */
export async function polygonsNear(ctx: HttpContext, x: number, y: number, radiusM: number): Promise<GovmapPolygon[]> {
  const arr = await getJson<any>(ctx, "govmap", `${BASE}/real-estate/deals/${x},${y}/${radiusM}`).catch((e) => {
    if (isBlocked(e)) throw e;
    return [];
  });
  const out: GovmapPolygon[] = [];
  for (const p of Array.isArray(arr) ? arr : []) {
    const id = p?.polygon_id != null ? String(p.polygon_id) : null;
    if (!id || out.some((o) => o.polygonId === id)) continue;
    out.push({
      polygonId: id,
      street: p.streetNameHeb ?? null,
      houseNum: p.houseNum != null ? String(p.houseNum) : null,
      city: p.settlementNameHeb ?? null,
      dealCount: Number(p.dealscount) || 0,
    });
  }
  return out;
}

/** Deals for one polygon, at building/street scope or across its neighborhood. */
export async function dealsForPolygon(
  ctx: HttpContext,
  scope: "street" | "neighborhood",
  polygonId: string,
): Promise<GovmapDeal[]> {
  // One unhappy polygon is survivable — its siblings still carry comps. A block is not.
  const data = await getJson<any>(ctx, "govmap", `${BASE}/real-estate/${scope}-deals/${encodeURIComponent(polygonId)}`).catch(
    (e) => {
      if (isBlocked(e)) throw e;
      return null;
    },
  );
  const rows: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return rows.map(toGovmapDeal).filter((d): d is GovmapDeal => d != null);
}

export interface CollectOptions {
  /** Escalating search radii, meters. */
  radiusStages: number[];
  /** New polygons to read per stage. */
  maxPolygonsPerStage: number;
  /** Also read the first polygon's neighborhood deals. */
  includeNeighborhood: boolean;
  /** Stop widening once this returns true. */
  enough?: (deals: GovmapDeal[]) => boolean;
}

/**
 * All sale deals near a point, deduped by deal id. The radius widens in stages: a residential
 * street resolves within 50 m, while a shop or office often needs the wider business district.
 * The polygon budget is per stage and counts only polygons not already read, so dense near
 * stages cannot starve the wide stage where sparse commercial comps live.
 */
export async function collectDeals(
  ctx: HttpContext,
  point: { x: number; y: number },
  opts: CollectOptions,
): Promise<{ deals: GovmapDeal[]; nearest: GovmapPolygon | null }> {
  const byId = new Map<string, GovmapDeal>();
  const seen = new Set<string>();
  let neighborhoodDone = false;
  let nearest: GovmapPolygon | null = null;

  for (const radius of opts.radiusStages) {
    const polys = (await polygonsNear(ctx, point.x, point.y, radius)).filter((p) => !seen.has(p.polygonId));
    nearest ??= polys.find((p) => p.street) ?? polys[0] ?? null;
    for (const p of polys.slice(0, opts.maxPolygonsPerStage)) {
      seen.add(p.polygonId);
      for (const d of await dealsForPolygon(ctx, "street", p.polygonId)) byId.set(d.dealId, d);
    }
    if (opts.includeNeighborhood && !neighborhoodDone && polys.length) {
      neighborhoodDone = true;
      for (const d of await dealsForPolygon(ctx, "neighborhood", polys[0]!.polygonId)) byId.set(d.dealId, d);
    }
    if (opts.enough?.([...byId.values()])) break;
  }
  return { deals: [...byId.values()], nearest };
}

/** A GovMap deal as a package-wide {@link Comp}. */
export function govmapDealToComp(d: GovmapDeal): Comp {
  return {
    source: "govmap",
    kind: "deal",
    deal: "sale",
    id: d.dealId,
    date: d.dealDate,
    price: d.price,
    areaSqm: d.sizeSqm,
    pricePerSqm: d.pricePerSqm,
    rooms: d.rooms,
    floor: d.floor,
    propertyType: d.nature,
    street: d.street,
    houseNumber: d.houseNum,
    neighborhood: d.neighborhood,
    city: d.city,
    lat: null,
    lng: null,
    distanceM: null,
    url: null,
  };
}

/** Most common neighborhood name among the deals in the subject's own building / street. */
export function dominantNeighborhood(deals: GovmapDeal[], street: string | null): string | null {
  const pool = street ? deals.filter((d) => d.street === street) : deals;
  const counts = new Map<string, number>();
  for (const d of pool.length ? pool : deals) {
    const n = clean(d.neighborhood);
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

