// Yad2 (yad2.co.il) — asking-rent listings, residential and commercial (נדל"ן מסחרי).
//
// Yad2 sits behind Radware Bot Manager. Two transports read the same data:
//   • browser (default): land on yad2.co.il, resolve the address with the site's own
//     autocomplete (an in-page fetch, exactly what the search box does), then open the list
//     search and read its server-rendered `__NEXT_DATA__` feed;
//   • relay: plain HTTP through a tiny Cloudflare Worker (relay/cloudflare-yad2), for servers
//     whose datacenter IPs Radware blocks outright. The relay reads the gw.yad2.co.il map feed.
import { SourceBlockedError } from "../errors.js";
import type { BrowserSession } from "../browser.js";
import type { Comp } from "../types.js";
import { haversineM } from "../util/geo.js";
import { num } from "../util/stats.js";
import { clean } from "../util/text.js";

const WWW = "https://www.yad2.co.il";
const GW = "https://gw.yad2.co.il";
const WALL = /__uzdbm_|perfdrive|Radware|px-captcha|SSJSInternal|Attention Required|Just a moment|Verifying you are human/i;

/** Yad2's region ids → the commercial vertical's URL slug. */
const REGION_SLUG: Record<string, string> = {
  "1": "center-and-sharon",
  "2": "south",
  "3": "tel-aviv-area",
  "4": "jerusalem-area",
  "5": "coastal-north",
  "6": "north-and-valleys",
};

export interface Yad2Location {
  cityId: string;
  areaId: string | null;
  regionId: string | null;
  streetId: string | null;
}

export interface Yad2Transport {
  /** GET a gw.yad2.co.il JSON endpoint. */
  gwJson(url: string): Promise<any>;
  /** Listing items for a search — list search (browser) or map feed (relay). */
  search(loc: Yad2Location, commercial: boolean, withStreet: boolean): Promise<any[]>;
}

/** Autocomplete "Tel Aviv - Yafo" fails while "תל אביב יפו" and "תל אביב" resolve; try simpler forms. */
function cityCandidates(city: string): string[] {
  const out = [city];
  const noHyphen = clean(city.replace(/\s*[-–]\s*/g, " "));
  if (noHyphen && !out.includes(noHyphen)) out.push(noHyphen);
  const head = clean(city.split(/\s*[-–]\s*/)[0]);
  if (head && !out.includes(head)) out.push(head);
  return out;
}

const autocompleteUrl = (text: string) => `${GW}/address-autocomplete/realestate/v2?text=${encodeURIComponent(text)}`;

/**
 * Resolve street + city to Yad2's location codes. The city is pinned from the city name alone
 * (a bare street like "הרצל" exists in dozens of cities), then the street is matched within it.
 */
export async function resolveYad2Location(t: Yad2Transport, street: string, city: string): Promise<Yad2Location | null> {
  let cityRec: any = null;
  let cityQuery = city;
  for (const cand of cityCandidates(city)) {
    const j = await t.gwJson(autocompleteUrl(cand));
    const hit = j?.cities?.[0] ?? null;
    if (hit) {
      cityRec = hit;
      cityQuery = cand;
      break;
    }
  }
  if (cityRec) {
    let streetId: string | null = null;
    if (street) {
      const j = await t.gwJson(autocompleteUrl(`${street} ${cityQuery}`));
      streetId = (j?.streets ?? []).find((s: any) => String(s.cityId) === String(cityRec.cityId))?.streetId ?? null;
    }
    return { cityId: String(cityRec.cityId), areaId: str(cityRec.areaId), regionId: str(cityRec.regionId), streetId: str(streetId) };
  }
  if (street) {
    const j = await t.gwJson(autocompleteUrl(clean(`${street} ${city}`)));
    const st = j?.streets?.[0];
    if (st) return { cityId: String(st.cityId), areaId: str(st.areaId), regionId: str(st.regionId), streetId: str(st.streetId) };
  }
  return null;
}

const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

/** List-search URL (browser transport). */
export function yad2ListUrl(loc: Yad2Location, commercial: boolean, withStreet: boolean): string {
  const p = new URLSearchParams();
  if (commercial) p.set("dealType", "1"); // commercial vertical: 1 = rent, 2 = sale
  p.set("city", loc.cityId);
  if (loc.areaId) p.set("area", loc.areaId);
  if (!commercial && loc.regionId) p.set("region", loc.regionId);
  if (withStreet && loc.streetId) p.set("street", loc.streetId);
  const path = commercial ? `realestate/commercial/${REGION_SLUG[loc.regionId ?? ""] ?? "center-and-sharon"}` : "realestate/rent";
  return `${WWW}/${path}?${p.toString()}`;
}

/** Map-feed URL (relay transport). */
export function yad2MapFeedUrl(loc: Yad2Location, commercial: boolean, withStreet: boolean): string {
  const p = new URLSearchParams();
  if (commercial) p.set("dealType", "1");
  if (loc.regionId) p.set("region", loc.regionId);
  if (loc.areaId) p.set("area", loc.areaId);
  p.set("city", loc.cityId);
  if (withStreet && loc.streetId) p.set("street", loc.streetId);
  return `${GW}/realestate-feed/${commercial ? "commercial" : "rent"}/map?${p.toString()}`;
}

/** Flatten a Next.js page's `pageProps.feed` groups (private / agency / platinum …) into one list. */
export function itemsFromNextData(nextData: unknown): any[] {
  const pp = (nextData as any)?.props?.pageProps ?? {};
  let feed = pp.feed;
  if (!feed || typeof feed !== "object") {
    const q = (pp.dehydratedState?.queries ?? []).find(
      (x: any) => Array.isArray(x?.queryKey) && /realestate-.*-feed/.test(String(x.queryKey[0])),
    );
    feed = q?.state?.data ?? {};
  }
  const out: any[] = [];
  for (const group of Object.keys(feed)) if (Array.isArray(feed[group])) out.push(...feed[group]);
  return out;
}

/** One Yad2 feed item → a rent {@link Comp}. */
export function yad2ItemToComp(d: any, commercial: boolean, subject: { lat: number; lng: number } | null): Comp | null {
  const id = d?.token ?? d?.orderId ?? d?.id;
  const price = num(d?.price);
  if (id == null || !price || price < 100) return null; // "price on request" items carry 0 / 1
  const addr = d.address ?? {};
  const details = d.additionalDetails ?? {};
  const size = num(details.squareMeter ?? d.squareMeter);
  const lat = num(addr.coords?.lat);
  const lng = num(addr.coords?.lon ?? addr.coords?.lng);
  return {
    source: "yad2",
    kind: "listing",
    deal: "rent",
    id: String(id),
    date: null,
    price,
    areaSqm: size,
    pricePerSqm: size ? Math.round((price / size) * 10) / 10 : null,
    rooms: num(details.roomsCount ?? d.rooms),
    floor: addr.house?.floor != null ? String(addr.house.floor) : null,
    propertyType: clean(details.property?.text) || (commercial ? "מסחרי" : null),
    street: clean(addr.street?.text) || null,
    houseNumber: addr.house?.number != null ? String(addr.house.number) : null,
    neighborhood: clean(addr.neighborhood?.text) || null,
    city: clean(addr.city?.text) || null,
    lat,
    lng,
    distanceM: subject && lat != null && lng != null ? haversineM(subject, { lat, lng }) : null,
    url: d.token ? `${WWW}/realestate/item/${d.token}` : null,
  };
}

// ---- browser transport --------------------------------------------------------------------

/**
 * page.evaluate that survives Radware's challenge script reloading the page underneath it: on a
 * destroyed execution context, wait for the reload to settle and try again.
 */
async function settledEvaluate<T>(page: any, fn: (arg: any) => T | Promise<T>, arg?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(fn, arg);
    } catch (e) {
      if (attempt >= 3 || !/context was destroyed|navigat/i.test(String((e as Error)?.message))) throw e;
      await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000);
    }
  }
}

const nextDataReady = (page: any) =>
  page.waitForSelector("#__NEXT_DATA__", { state: "attached", timeout: 20_000 }).catch(() => undefined);

export async function browserTransport(session: BrowserSession, timeoutMs: number): Promise<Yad2Transport & { close(): Promise<void> }> {
  const page = await session.context.newPage();
  // Land on a yad2.co.il origin first: gw.* calls must be same-site, cookie-carrying fetches.
  await page.goto(`${WWW}/realestate/rent`, { waitUntil: "load", timeout: timeoutMs }).catch(() => undefined);
  await nextDataReady(page);
  if (WALL.test(page.url())) throw new SourceBlockedError("yad2: Radware challenge", 403);

  const gwJson = async (url: string) => {
    const r = await settledEvaluate<{ status: number; body: string }>(page, async (u: string) => {
      try {
        const res = await fetch(u, { headers: { accept: "application/json" }, credentials: "include" });
        return { status: res.status, body: await res.text() };
      } catch (e) {
        return { status: 0, body: String(e) };
      }
    }, url);
    if (WALL.test(r.body) || r.status === 403 || r.status === 429) throw new SourceBlockedError("yad2: Radware challenge", r.status);
    if (r.status >= 400 || !r.body) return null;
    try {
      return JSON.parse(r.body);
    } catch {
      return null;
    }
  };

  const search = async (loc: Yad2Location, commercial: boolean, withStreet: boolean) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.goto(yad2ListUrl(loc, commercial, withStreet), { waitUntil: "load", timeout: timeoutMs }).catch(() => undefined);
      await nextDataReady(page);
      const raw = await settledEvaluate<string | null>(
        page,
        () => document.getElementById("__NEXT_DATA__")?.textContent ?? null,
      ).catch(() => null);
      if (raw && !WALL.test(raw)) {
        try {
          return itemsFromNextData(JSON.parse(raw));
        } catch {
          return [];
        }
      }
      await page.waitForTimeout(4000 + attempt * 5000); // Radware's score decays with time
    }
    throw new SourceBlockedError("yad2: Radware challenge", 403);
  };

  return { gwJson, search, close: () => page.close().catch(() => undefined) };
}

// ---- relay transport ----------------------------------------------------------------------

export function relayTransport(relay: { url: string; token?: string }, fetchImpl: typeof fetch, timeoutMs: number): Yad2Transport {
  const base = relay.url.replace(/\/+$/, "");
  const gwJson = async (url: string) => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/?url=${encodeURIComponent(url)}`, {
        headers: relay.token ? { authorization: `Bearer ${relay.token}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new SourceBlockedError(`yad2 relay unreachable: ${(e as Error).message}`);
    }
    const body = await res.text();
    if (WALL.test(body) || res.status === 403 || res.status === 429) throw new SourceBlockedError("yad2: Radware challenge (via relay)", res.status);
    if (res.status === 401) throw new SourceBlockedError("yad2 relay rejected the token", 401);
    if (res.status >= 400) return null;
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  };
  return {
    gwJson,
    search: async (loc, commercial, withStreet) => {
      const j = await gwJson(yad2MapFeedUrl(loc, commercial, withStreet));
      return j?.data?.markers ?? [];
    },
  };
}
