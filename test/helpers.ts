import type { Comp } from "../src/types.js";

/** A comp with sensible defaults; override what the test cares about. */
export function comp(overrides: Partial<Comp> = {}): Comp {
  const price = overrides.price ?? 2_000_000;
  const areaSqm = overrides.areaSqm === undefined ? 80 : overrides.areaSqm;
  return {
    source: "govmap",
    kind: "deal",
    deal: "sale",
    id: Math.random().toString(36).slice(2),
    date: "2026-01-15",
    price,
    areaSqm,
    pricePerSqm: price && areaSqm ? Math.round(price / areaSqm) : null,
    rooms: 3,
    floor: "2",
    propertyType: "דירה בבית קומות",
    street: "הרצל",
    houseNumber: "10",
    neighborhood: "מרכז העיר",
    city: "פתח תקווה",
    lat: null,
    lng: null,
    distanceM: null,
    url: null,
    ...overrides,
  };
}

export function listing(overrides: Partial<Comp> = {}): Comp {
  const price = overrides.price ?? 5_000;
  const areaSqm = overrides.areaSqm === undefined ? 80 : overrides.areaSqm;
  return comp({
    source: "yad2",
    kind: "listing",
    deal: "rent",
    date: null,
    propertyType: "דירה",
    ...overrides,
    price,
    areaSqm,
    pricePerSqm: price && areaSqm ? Math.round((price / areaSqm) * 10) / 10 : null,
  });
}

/** A fetch stub routing by URL substring. Unmatched URLs 404. */
export function stubFetch(routes: Record<string, unknown | ((url: string, init?: RequestInit) => unknown)>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    const v = routes[key];
    const body = typeof v === "function" ? (v as (u: string, i?: RequestInit) => unknown)(url, init) : v;
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
