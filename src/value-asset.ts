import { blendEstimates, type WeightedEstimate } from "./analysis/blend.js";
import { dedupeListings, rentEstimate, rentFromSaleBand } from "./analysis/rent.js";
import { exactClassCount, poolsFor, saleBand } from "./analysis/sale.js";
import { openSession, type BrowserSession } from "./browser.js";
import { isBlocked, SourceUnavailableError } from "./errors.js";
import { CBS_SERIES, escalate, fetchCbsIndex, type IndexPoint } from "./sources/cbs.js";
import {
  collectDeals,
  dominantNeighborhood,
  geocode,
  govmapDealToComp,
  natureClass,
  polygonsNear,
  type GovmapDeal,
} from "./sources/govmap.js";
import {
  fetchMadlanDeals,
  fetchMadlanRentBulletins,
  madlanBulletinToComp,
  madlanDealToComp,
  madlanDocId,
} from "./sources/madlan.js";
import { nadlanGovMedian, roomBucketValue, type NadlanGovMedian } from "./sources/nadlan-gov.js";
import { settlementCode } from "./sources/settlements.js";
import {
  browserTransport,
  relayTransport,
  resolveYad2Location,
  yad2ItemToComp,
  type Yad2Transport,
} from "./sources/yad2.js";
import type {
  AssetInput,
  AssetType,
  Comp,
  DealKind,
  DealValuation,
  Estimate,
  ResolvedAsset,
  SourceId,
  SourceResult,
  ValuationReport,
  ValueAssetOptions,
} from "./types.js";
import { wgs84ToMercator } from "./util/geo.js";
import type { HttpContext } from "./util/http.js";
import { clean, hasHebrew, splitAddress } from "./util/text.js";

export const ASSET_TYPES: AssetType[] = ["apartment", "house", "office", "retail", "warehouse", "industrial", "commercial"];
export const ALL_SOURCES: SourceId[] = ["govmap", "nadlan-gov", "madlan", "yad2"];

export const isResidentialType = (t: AssetType) => t === "apartment" || t === "house";

/**
 * Which sources apply to an asset type and deal. Madlan's deal data and nadlan.gov.il's medians
 * are residential; GovMap sale deals and Yad2 rent listings cover both segments.
 */
export function sourcesFor(type: AssetType, deal: DealKind): SourceId[] {
  const residential = isResidentialType(type);
  if (deal === "sale") return residential ? ["govmap", "madlan", "nadlan-gov"] : ["govmap"];
  return residential ? ["yad2", "madlan", "nadlan-gov"] : ["yad2"];
}

function validate(input: AssetInput): AssetInput {
  if (!input || typeof input !== "object") throw new TypeError("valueAsset: asset is required");
  if (!clean(input.city)) throw new TypeError("valueAsset: asset.city is required");
  if (!ASSET_TYPES.includes(input.type)) {
    throw new TypeError(`valueAsset: asset.type must be one of ${ASSET_TYPES.join(", ")}`);
  }
  for (const k of ["areaSqm", "rooms"] as const) {
    const v = input[k];
    if (v != null && !(Number.isFinite(v) && v > 0)) throw new TypeError(`valueAsset: asset.${k} must be a positive number`);
  }
  return { ...input, city: clean(input.city), address: clean(input.address) || undefined, neighborhood: clean(input.neighborhood) || undefined };
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(`timed out after ${Math.round(ms / 1000)} s`)), ms);
    const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * Value one Israeli property from every applicable source.
 *
 * @example
 * const report = await valueAsset({ city: "פתח תקווה", address: "רוטשילד 10", type: "apartment", areaSqm: 85, rooms: 3.5 });
 * report.sale?.estimate?.value // { low, mid, high } in ₪
 * report.rent?.estimate?.value // { low, mid, high } in ₪/month
 */
export async function valueAsset(input: AssetInput, options: ValueAssetOptions = {}): Promise<ValuationReport> {
  const started = Date.now();
  const asset = validate(input);
  const residential = isResidentialType(asset.type);
  const deals = [...new Set(options.deals ?? (["sale", "rent"] as DealKind[]))];
  const enabled = new Set(options.sources ?? ALL_SOURCES);
  const timeoutMs = options.sourceTimeoutMs ?? 90_000;
  const monthsBack = options.monthsBack ?? 36;
  const includeComps = options.includeComps ?? true;
  const log = options.logger ?? {};
  const warnings: string[] = [];
  const ctx: HttpContext = { fetch: options.fetch ?? globalThis.fetch, signal: options.signal, timeoutMs: Math.min(timeoutMs, 30_000) };
  const sessions: BrowserSession[] = [];

  // ---- 1. Locate the asset (GovMap geocoder) and learn its canonical Hebrew address ----------
  const { street: inputStreet, houseNumber } = splitAddress(asset.address);
  let subject = asset.location ?? null;
  let point = subject ? wgs84ToMercator(subject.lat, subject.lng) : null;
  let hebStreet = hasHebrew(inputStreet) ? inputStreet : "";
  let hebCity = hasHebrew(asset.city) ? asset.city : "";
  if (asset.address || !point) {
    try {
      const g = await geocode(ctx, clean(`${asset.address ?? ""} ${asset.city}`));
      if (g) {
        point = { x: g.x, y: g.y };
        // A city-only match is the city centre: good for resolving Hebrew names, not a location.
        if (asset.address) subject ??= { lat: g.lat, lng: g.lng };
        log.debug?.(`geocoded → ${g.matched}`);
      } else warnings.push(`GovMap could not geocode "${clean(`${asset.address ?? ""} ${asset.city}`)}"`);
    } catch (e) {
      warnings.push(`geocoding failed: ${(e as Error).message}`);
    }
  }
  if (point && (!hebStreet || !hebCity)) {
    // The building polygon at the point carries the Hebrew street and city names.
    const polys = await polygonsNear(ctx, point.x, point.y, 60).catch(() => []);
    const own = polys.find((p) => p.street && p.houseNum === houseNumber) ?? polys.find((p) => p.street);
    hebStreet ||= own?.street ?? "";
    hebCity ||= own?.city ?? polys.find((p) => p.city)?.city ?? "";
  }
  // Deal searches and distances need the asset's own point, not a city centroid.
  if (!subject) point = null;
  const canonicalAddress = hebStreet && hebCity ? clean(`${hebStreet} ${houseNumber ?? ""} ${hebCity}`) : hebCity || null;

  const resolved: ResolvedAsset = {
    ...asset,
    location: subject ?? undefined,
    canonicalAddress,
    settlementCode: null,
    segment: residential ? "residential" : "commercial",
  };

  // ---- 2. Plan -----------------------------------------------------------------------------
  const planned = (deal: DealKind, source: SourceId) =>
    deals.includes(deal) && enabled.has(source) && sourcesFor(asset.type, deal).includes(source);
  // Commercial rent without listings falls back to the sale band, so GovMap runs for it too.
  const needGovmap = enabled.has("govmap") && (planned("sale", "govmap") || (!residential && deals.includes("rent")));

  const memo = <T>(f: () => Promise<T>) => {
    let p: Promise<T> | null = null;
    return () => (p ??= f());
  };
  const homeIndex = memo(() => fetchCbsIndex(ctx, CBS_SERIES.homePrices, 480).catch(() => [] as IndexPoint[]));
  const rentIndex = memo(() => fetchCbsIndex(ctx, CBS_SERIES.rent, 240).catch(() => [] as IndexPoint[]));

  const results: SourceResult[] = [];
  const record = (r: SourceResult) => {
    results.push(r);
    log.info?.(`${r.source}/${r.deal}: ${r.status}${r.reason ? ` — ${r.reason}` : ""}${r.estimate ? ` (${r.estimate.count} comps)` : ""}`);
  };
  const skip = (source: SourceId, deal: DealKind, reason: string) =>
    record({ source, deal, status: "skipped", reason, estimate: null, comps: [], durationMs: 0 });

  /** Run one source leg, mapping failures onto statuses. */
  const leg = async (
    source: SourceId,
    deal: DealKind,
    fn: () => Promise<{ comps: Comp[]; estimate: Estimate | null; reason?: string }>,
  ): Promise<SourceResult> => {
    const t0 = Date.now();
    let r: SourceResult;
    try {
      const out = await withTimeout(fn(), timeoutMs, options.signal);
      r = {
        source,
        deal,
        status: out.estimate ? "ok" : "no-data",
        reason: out.estimate ? undefined : out.reason ?? (out.comps.length ? `only ${out.comps.length} usable comps` : "no comps found"),
        estimate: out.estimate,
        comps: out.comps,
        durationMs: Date.now() - t0,
      };
    } catch (e) {
      if (options.signal?.aborted) throw e;
      const message = (e as Error)?.message ?? String(e);
      const status = isBlocked(e) ? "blocked" : e instanceof SourceUnavailableError ? "skipped" : "error";
      r = { source, deal, status, reason: message, estimate: null, comps: [], durationMs: Date.now() - t0 };
    }
    record(r);
    return r;
  };

  // ---- 3. Sources --------------------------------------------------------------------------
  let govmapDeals: GovmapDeal[] = [];
  let internalSaleBand = null as Estimate | null;
  const govmapTask = (async () => {
    if (!needGovmap) {
      if (deals.includes("sale") && sourcesFor(asset.type, "sale").includes("govmap")) skip("govmap", "sale", "disabled by options.sources");
      return;
    }
    const run = () =>
      leg("govmap", "sale", async () => {
        if (!point) throw new SourceUnavailableError(asset.address ? "the address could not be geocoded" : "needs an address or location");
        const enoughAt = residential ? 12 : 6;
        const { deals: found } = await collectDeals(ctx, point, {
          radiusStages: residential ? [50, 300] : [50, 600, 1500],
          maxPolygonsPerStage: residential ? 8 : 20,
          includeNeighborhood: true,
          enough: (ds) => exactClassCount(ds.map(govmapDealToComp), asset.type, monthsBack) >= enoughAt,
        });
        govmapDeals = found;
        const comps = found.map(govmapDealToComp);
        const estimate = saleBand(comps, {
          type: asset.type,
          areaSqm: asset.areaSqm,
          monthsBack,
          index: await homeIndex(),
          sourceLabel: "Tax Authority via govmap.gov.il",
        });
        internalSaleBand = estimate;
        const classes = poolsFor(asset.type)[0]!.classes;
        const relevant = comps.filter((c) => classes.includes(natureClass(c.propertyType)) || !residential);
        return { comps: relevant, estimate };
      });
    const r = await run();
    if (!planned("sale", "govmap")) results.splice(results.indexOf(r), 1); // ran only to back commercial rent
  })();

  const nadlanGovTask = (async () => {
    const kinds = (["sale", "rent"] as DealKind[]).filter((d) => planned(d, "nadlan-gov"));
    if (!kinds.length) return;
    await govmapTask; // its deals carry the settlement code and neighborhood names
    const code =
      govmapDeals.find((d) => d.settlementId)?.settlementId ??
      (await settlementCode(ctx, asset.city)) ??
      (hebCity ? await settlementCode(ctx, hebCity) : null);
    resolved.settlementCode = code;
    const neighborhood = asset.neighborhood ?? dominantNeighborhood(govmapDeals, hebStreet || null);
    await Promise.all(
      kinds.map((deal) =>
        leg("nadlan-gov", deal, async () => {
          if (!code) throw new SourceUnavailableError(`unknown settlement code for "${asset.city}"`);
          const m = await nadlanGovMedian(ctx, deal === "sale" ? "buy" : "rent", code, neighborhood);
          if (!m) return { comps: [], estimate: null, reason: "no published median" };
          return { comps: [], estimate: medianEstimate(m, deal, await (deal === "sale" ? homeIndex() : rentIndex()), asset) };
        }),
      ),
    );
  })();

  const madlanTask = (async () => {
    const kinds = (["sale", "rent"] as DealKind[]).filter((d) => planned(d, "madlan"));
    if (!kinds.length) return;
    let session: BrowserSession | null = null;
    const getSession = async () => {
      if (!session) {
        session = await openSession(options, true);
        sessions.push(session);
      }
      return session;
    };
    for (const deal of kinds) {
      await leg("madlan", deal, async () => {
        if (!hebCity) throw new SourceUnavailableError("needs a Hebrew city name (geocoding did not return one)");
        if (deal === "sale") {
          if (!hebStreet) throw new SourceUnavailableError("needs a street address");
          const docId = madlanDocId({ street: hebStreet, houseNumber, city: hebCity });
          const found = await fetchMadlanDeals(await getSession(), docId, timeoutMs);
          if (found == null) return { comps: [], estimate: null, reason: `Madlan does not know "${docId}"` };
          const comps = found.map(madlanDealToComp);
          const estimate = saleBand(comps, {
            type: asset.type,
            areaSqm: asset.areaSqm,
            monthsBack,
            index: await homeIndex(),
            sourceLabel: "madlan.co.il",
          });
          return { comps, estimate };
        }
        const docId = hebStreet
          ? madlanDocId({ street: hebStreet, houseNumber, city: hebCity })
          : madlanDocId({ street: "", city: hebCity });
        const bulletins = await fetchMadlanRentBulletins(await getSession(), docId, timeoutMs);
        const comps = bulletins.map((b) => madlanBulletinToComp(b, subject)).filter((c): c is Comp => c != null);
        return { comps, estimate: rentEstimate(comps, { ...rentOpts(asset), sourceLabel: "madlan.co.il" }) };
      });
    }
  })();

  const yad2Task = (async () => {
    if (!planned("rent", "yad2")) return;
    await leg("yad2", "rent", async () => {
      const city = hebCity || asset.city;
      let transport: Yad2Transport;
      if (options.yad2Relay?.url) {
        transport = relayTransport(options.yad2Relay, ctx.fetch, ctx.timeoutMs);
      } else {
        const session = await openSession(options, false);
        sessions.push(session);
        transport = await browserTransport(session, timeoutMs);
      }
      const loc = await resolveYad2Location(transport, hebStreet || inputStreet, city);
      if (!loc) return { comps: [], estimate: null, reason: `Yad2 does not recognise "${city}"` };
      const commercial = !residential;
      const byId = new Map<string, Comp>();
      for (const withStreet of loc.streetId ? [true, false] : [false]) {
        for (const item of await transport.search(loc, commercial, withStreet)) {
          const c = yad2ItemToComp(item, commercial, subject);
          if (c) byId.set(c.id, c);
        }
        if (byId.size >= 15) break; // the street alone is enough; skip the city-wide widen
      }
      const comps = commercial ? preferClass([...byId.values()], asset.type) : [...byId.values()];
      return { comps, estimate: rentEstimate(comps, { ...rentOpts(asset), sourceLabel: "yad2.co.il" }) };
    });
  })();

  try {
    await Promise.all([govmapTask, nadlanGovTask, madlanTask, yad2Task]);
  } finally {
    await Promise.all(sessions.map((s) => s.release()));
  }

  // ---- 4. Blend ----------------------------------------------------------------------------
  const order = (r: SourceResult) => ALL_SOURCES.indexOf(r.source);
  const of = (deal: DealKind) => results.filter((r) => r.deal === deal).sort((a, b) => order(a) - order(b));
  const ok = (deal: DealKind, source: SourceId) => results.find((r) => r.deal === deal && r.source === source && r.estimate);

  let sale: DealValuation | null = null;
  if (deals.includes("sale")) {
    const primary: WeightedEstimate[] = (["govmap", "madlan"] as SourceId[])
      .map((s) => ok("sale", s))
      .filter((r): r is SourceResult => r != null)
      .map((r) => ({ source: r.source, estimate: r.estimate! }));
    let estimate = blendEstimates(primary);
    const fallback = ok("sale", "nadlan-gov");
    if (!estimate && fallback) {
      estimate = { ...fallback.estimate!, method: `fallback — ${fallback.estimate!.method}`, sources: ["nadlan-gov"] };
      warnings.push("sale: no recent deal comps; using the nadlan.gov.il published median rolled forward by the CBS index");
    }
    sale = { estimate, sources: of("sale") };
  }

  let rent: DealValuation | null = null;
  if (deals.includes("rent")) {
    const listingSources = (["yad2", "madlan"] as SourceId[]).filter((s) =>
      results.some((r) => r.deal === "rent" && r.source === s && r.comps.length),
    );
    const pooled = dedupeListings(results.filter((r) => r.deal === "rent" && listingSources.includes(r.source)).flatMap((r) => r.comps));
    const pooledEstimate = listingSources.length
      ? rentEstimate(pooled, { ...rentOpts(asset), sourceLabel: listingSources.map(label).join(" + ") })
      : null;
    let estimate: DealValuation["estimate"] = pooledEstimate
      ? { ...pooledEstimate, sources: listingSources }
      : blendEstimates(
          (["yad2", "madlan"] as SourceId[])
            .map((s) => ok("rent", s))
            .filter((r): r is SourceResult => r != null)
            .map((r) => ({ source: r.source, estimate: r.estimate! })),
        );
    if (!estimate) {
      const gov = ok("rent", "nadlan-gov");
      if (gov) {
        estimate = { ...gov.estimate!, method: `fallback — ${gov.estimate!.method}`, sources: ["nadlan-gov"] };
        warnings.push("rent: no asking-rent listings; using the nadlan.gov.il published median rolled forward by the CBS rent index");
      } else if (!residential && internalSaleBand) {
        const derived = rentFromSaleBand(internalSaleBand, asset.areaSqm);
        if (derived) {
          estimate = { ...derived, sources: ["govmap"] };
          warnings.push("rent: no commercial rent listings; derived from the GovMap sale band at a 6–8% gross yield");
        }
      }
    }
    rent = { estimate, sources: of("rent") };
  }

  for (const r of results) if (r.status === "blocked") warnings.push(`${r.source} (${r.deal}) was blocked: ${r.reason}`);
  if (!asset.areaSqm) warnings.push("no areaSqm given — whole-property values are only available from whole-property sources");

  const strip = (v: DealValuation): DealValuation =>
    includeComps ? v : { ...v, sources: v.sources.map((r) => ({ ...r, comps: [] })) };

  return {
    asset: resolved,
    sale: sale && strip(sale),
    rent: rent && strip(rent),
    warnings,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}

const label = (s: SourceId) => ({ govmap: "govmap.gov.il", "nadlan-gov": "nadlan.gov.il", madlan: "madlan.co.il", yad2: "yad2.co.il" })[s];

const rentOpts = (asset: AssetInput) => ({ type: asset.type, areaSqm: asset.areaSqm, rooms: asset.rooms });

/** Keep commercial listings of the asset's own class when there are enough of them. */
function preferClass(comps: Comp[], type: AssetType): Comp[] {
  const classes = poolsFor(type)[0]!.classes;
  const own = comps.filter((c) => classes.includes(natureClass(c.propertyType)));
  return own.length >= 5 ? own : comps;
}

/** A nadlan.gov.il published median, rolled forward from its as-of month by the matching CBS index. */
function medianEstimate(m: NadlanGovMedian, deal: DealKind, index: IndexPoint[], asset: AssetInput): Estimate {
  // The subject's own room bucket is the better mid when the caller knows the room count.
  const roomed = roomBucketValue(m.perRoom, asset.rooms);
  const mid0 = roomed ?? m.mid;
  const roll = (n: number) => escalate(n, m.asOf, index);
  const f = roll(1_000_000);
  const scale = (n: number) => (f ? Math.round((n * f.value) / 1_000_000) : Math.round(n));
  const value = { low: scale(Math.min(m.low, mid0)), mid: scale(mid0), high: scale(Math.max(m.high, mid0)) };
  return {
    value,
    perSqm: asset.areaSqm
      ? { low: Math.round(value.low / asset.areaSqm), mid: Math.round(value.mid / asset.areaSqm), high: Math.round(value.high / asset.areaSqm) }
      : null,
    count: 0, // a published statistic, not individual comps
    method:
      `published ${deal === "sale" ? "sale" : "rent"} median for ${m.label} (${m.scope}, ${m.asOf?.slice(0, 7) ?? "n/a"})` +
      (f ? ` × CBS ${deal === "sale" ? "dwellings price" : "rent"} index ${(f.value / 1_000_000).toFixed(2)}` : " (not indexed)") +
      " · nadlan.gov.il",
  };
}

