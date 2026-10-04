// Madlan (madlan.co.il) — closed residential deals and asking-rent listings.
//
// Madlan sits behind PerimeterX, so it is read through a real browser. Nothing is scripted on
// the page: we navigate like a visitor and read the data the site itself loads —
//   • sale: the address page fires a `docId2Insights` GraphQL call carrying every closed deal in
//     the building and the surrounding area;
//   • rent: the for-rent search is server-rendered into `window.__SSR_HYDRATED_CONTEXT__`
//     (`searchPoiV2.poi`), and later pages arrive over the same GraphQL endpoint.
// Madlan's deal data is residential, so this source only runs for residential assets.
import { SourceBlockedError } from "../errors.js";
import type { BrowserSession } from "../browser.js";
import type { Comp } from "../types.js";
import { haversineM } from "../util/geo.js";
import { num } from "../util/stats.js";
import { clean } from "../util/text.js";

const ORIGIN = "https://www.madlan.co.il";
const WALL = /px-captcha|Access to this page has been denied|Press & Hold|גרם לנו לחשוב שאתה רובוט|השלם את החידה/i;

/** Madlan's address document id: "רוטשילד-10-פתח-תקווה-ישראל". */
export function madlanDocId(parts: { street: string; houseNumber?: string | null; city: string }): string {
  return [parts.street, parts.houseNumber, parts.city, "ישראל"]
    .map((p) => clean(p ?? ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, "-");
}

export const madlanAddressUrl = (docId: string) => `${ORIGIN}/address/${encodeURIComponent(docId)}`;
export const madlanRentUrl = (docId: string) =>
  `${ORIGIN}/for-rent/${encodeURIComponent(docId)}?tracking_search_source=new_search&marketplace=residential`;

/** A closed deal from `docId2Insights`. `scope` says whether it is in the subject building or the area. */
export interface MadlanDeal {
  saleId: string;
  date: string | null;
  price: number | null;
  sizeSqm: number | null;
  pricePerSqm: number | null;
  rooms: number | null;
  floor: string | null;
  yearBuilt: number | null;
  street: string | null;
  houseNumber: string | null;
  city: string | null;
  neighborhood: string | null;
  scope: "building" | "area";
}

/** Pull building + area deals out of a `docId2Insights` payload. */
export function parseMadlanInsights(insights: any): MadlanDeal[] {
  const prices = (insights?.insights ?? []).find((i: any) => i?.type === "prices");
  const raw = prices?.summary?.nonText?.data ?? {};
  const out = new Map<string, MadlanDeal>();
  for (const scope of ["building", "area"] as const) {
    for (const d of raw[scope] ?? []) {
      if (!d?.saleId || out.has(String(d.saleId))) continue;
      const ar = d.addressRecord ?? {};
      const price = num(d.amount);
      const size = num(d.size);
      out.set(String(d.saleId), {
        saleId: String(d.saleId),
        date: d.date ? String(d.date).slice(0, 10) : null,
        price,
        sizeSqm: size,
        pricePerSqm: num(d.pricePerMeter) != null ? Math.round(num(d.pricePerMeter)!) : price && size ? Math.round(price / size) : null,
        rooms: num(d.beds),
        floor: d.floor != null ? String(d.floor) : null,
        yearBuilt: num(d.yearBuilt),
        street: ar.stName ?? null,
        houseNumber: ar.hNo != null ? String(ar.hNo) : null,
        city: ar.city ?? null,
        neighborhood: (ar.relevantDocIds ?? []).find((r: any) => r?.type === "neighbourhood")?.text ?? null,
        scope,
      });
    }
  }
  return [...out.values()];
}

export function madlanDealToComp(d: MadlanDeal): Comp {
  return {
    source: "madlan",
    kind: "deal",
    deal: "sale",
    id: d.saleId,
    date: d.date,
    price: d.price,
    areaSqm: d.sizeSqm,
    pricePerSqm: d.pricePerSqm,
    rooms: d.rooms,
    floor: d.floor,
    propertyType: null,
    street: d.street,
    houseNumber: d.houseNumber,
    neighborhood: d.neighborhood,
    city: d.city,
    lat: null,
    lng: null,
    distanceM: null,
    url: null,
  };
}

/** Rent bulletins anywhere in a Madlan payload (SSR context or GraphQL response). */
export function extractMadlanBulletins(json: unknown): any[] {
  const out: any[] = [];
  const seen = new Set<unknown>();
  const looks = (o: any) =>
    o && typeof o === "object" && o.price != null && (o.id != null || o.addressDetails != null) &&
    (o.beds != null || o.area != null || o.addressDetails != null);
  const walk = (v: any) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) if (looks(x)) out.push(x);
      v.forEach(walk);
    } else Object.values(v).forEach(walk);
  };
  walk(json);
  return out;
}

export function madlanBulletinToComp(b: any, subject: { lat: number; lng: number } | null): Comp | null {
  const id = b?.id != null ? String(b.id) : null;
  const price = num(b?.price);
  if (!id || !price) return null;
  if (b.dealType && !/rent/i.test(String(b.dealType))) return null;
  const ad = b.addressDetails ?? {};
  const area = num(b.area);
  const lat = num(b.locationPoint?.lat);
  const lng = num(b.locationPoint?.lng);
  return {
    source: "madlan",
    kind: "listing",
    deal: "rent",
    id,
    date: null,
    price,
    areaSqm: area,
    pricePerSqm: area ? Math.round((price / area) * 10) / 10 : null,
    rooms: num(b.beds),
    floor: b.floor != null ? String(b.floor) : null,
    propertyType: b.buildingClass ?? b.type ?? null,
    street: ad.streetName ?? null,
    houseNumber: ad.streetNumber != null ? String(ad.streetNumber) : null,
    neighborhood: ad.neighbourhood ?? null,
    city: ad.city ?? null,
    lat,
    lng,
    distanceM: subject && lat != null && lng != null ? haversineM(subject, { lat, lng }) : null,
    url: `${ORIGIN}/listings/${encodeURIComponent(id)}`,
  };
}

/** Shallow merge that ignores null / undefined values in `next`. */
export function mergeDefined<T extends Record<string, unknown>>(prev: T | undefined, next: T): T {
  if (!prev) return next;
  const out: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(next)) if (v != null) out[k] = v;
  return out as T;
}

/** Parse `window.__SSR_HYDRATED_CONTEXT__=…` out of a page's HTML without evaluating it. */
export function parseSsrContext(html: string): unknown | null {
  const marker = "window.__SSR_HYDRATED_CONTEXT__=";
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const rest = html.slice(start + marker.length);
  const end = rest.indexOf("</script>");
  const literal = (end >= 0 ? rest.slice(0, end) : rest).trim().replace(/;$/, "");
  try {
    // The context is a JS literal that is JSON except for bare `undefined` values.
    return JSON.parse(literal.replace(/:undefined([,}\]])/g, ":null$1"));
  } catch {
    return null;
  }
}

async function isWalled(page: any, status: number | null): Promise<boolean> {
  if (status === 403) return true;
  const text: string = await page
    .evaluate(() => `${document.title} ${document.body?.innerText?.slice(0, 2000) ?? ""}`)
    .catch(() => "");
  return WALL.test(text);
}

const opName = (req: any): string => {
  try {
    const j = JSON.parse(req.postData() ?? "");
    return String((Array.isArray(j) ? j[0] : j)?.operationName ?? "");
  } catch {
    return "";
  }
};

/** Closed deals for an address. Throws SourceBlockedError on the PerimeterX wall. */
export async function fetchMadlanDeals(session: BrowserSession, docId: string, timeoutMs: number): Promise<MadlanDeal[] | null> {
  const page = await session.context.newPage();
  let insights: any = null;
  page.on("response", async (resp: any) => {
    if (insights || !/\/api[23]\b/.test(resp.url()) || opName(resp.request()) !== "docId2Insights") return;
    try {
      let d = await resp.json();
      if (Array.isArray(d)) d = d[0];
      insights = d?.data?.docId2Insights ?? null;
    } catch {
      /* body evicted */
    }
  });
  try {
    const nav = await page.goto(madlanAddressUrl(docId), { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => null);
    const status = nav?.status() ?? null;
    const started = Date.now();
    const deadline = started + Math.min(timeoutMs, 30_000);
    let wallChecked = false;
    while (!insights && Date.now() < deadline) {
      await page.waitForTimeout(500);
      // Fail fast on the wall instead of waiting out the whole deadline.
      if (!wallChecked && Date.now() - started > 6_000) {
        wallChecked = true;
        if (!insights && (await isWalled(page, status))) throw new SourceBlockedError("madlan: PerimeterX challenge", 403);
      }
    }
    if (insights) return parseMadlanInsights(insights);
    if (await isWalled(page, status)) throw new SourceBlockedError("madlan: PerimeterX challenge", 403);
    if (status === 404) return null; // Madlan does not know this address
    return [];
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Asking-rent bulletins around an address. Throws SourceBlockedError on the PerimeterX wall. */
export async function fetchMadlanRentBulletins(session: BrowserSession, docId: string, timeoutMs: number): Promise<any[]> {
  const page = await session.context.newPage();
  const bulletins = new Map<string, any>();
  // The same bulletin arrives in several shapes (full SSR record, lean map marker); merge them
  // field by field so a lean copy never erases the rooms and area a richer one carried.
  const add = (list: any[]) =>
    list.forEach((b) => {
      if (b?.id == null) return;
      const id = String(b.id);
      bulletins.set(id, mergeDefined(bulletins.get(id), b));
    });
  page.on("response", async (resp: any) => {
    if (!/\/api[23]\b/.test(resp.url()) || !/searchPoi/i.test(opName(resp.request()))) return;
    try {
      add(extractMadlanBulletins(await resp.json()));
    } catch {
      /* body evicted */
    }
  });
  try {
    const nav = await page.goto(madlanRentUrl(docId), { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => null);
    await page.waitForTimeout(2500);
    if (await isWalled(page, nav?.status() ?? null)) throw new SourceBlockedError("madlan: PerimeterX challenge", 403);
    add(extractMadlanBulletins(parseSsrContext(await page.content())));
    // Scroll once to let the next results page stream in.
    await page.mouse.wheel(0, 4000).catch(() => undefined);
    await page.waitForTimeout(2500);
    return [...bulletins.values()];
  } finally {
    await page.close().catch(() => undefined);
  }
}
