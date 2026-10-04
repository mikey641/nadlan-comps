import { beforeEach, describe, expect, it } from "vitest";
import { resetSettlementCache } from "../src/sources/settlements.js";
import { sourcesFor, valueAsset } from "../src/value-asset.js";
import { stubFetch } from "./helpers.js";

const recent = (monthsAgo: number) => {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo);
  return `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
};

const govmapRow = (i: number, nature = "דירה בבית קומות") => ({
  dealId: 1000 + i,
  dealDate: recent(i + 1),
  dealAmount: 2_000_000 + i * 50_000,
  assetArea: 80,
  assetRoomNum: 3,
  floorNo: "2",
  dealNatureDescription: nature,
  streetNameHeb: "רוטשילד",
  houseNum: 10,
  settlementNameHeb: "פתח תקווה",
  settlementId: 7900,
  neighborhood: "מרכז העיר",
  polygonId: "p1",
});

const cbs = {
  month: [
    {
      date: [
        { year: 2021, month: 3, currBase: { value: 100, baseDesc: "2020 ממוצע" } },
        { year: 2026, month: 6, currBase: { value: 120, baseDesc: "2020 ממוצע" } },
      ],
    },
  ],
};

const nadlanRent = {
  settlementName: "פתח תקווה",
  otherNeighborhoods: [],
  trends: {
    rooms: [
      { numRooms: "3", graphData: [{ settlementPrice: 4_000, year: 2021, month: 3 }] },
      { numRooms: "4", graphData: [{ settlementPrice: 5_000, year: 2021, month: 3 }] },
      { numRooms: "all", graphData: [{ settlementPrice: 4_500, year: 2021, month: 3 }] },
    ],
  },
};

function routes(overrides: Record<string, unknown> = {}) {
  return stubFetch({
    "search-service/autocomplete": { results: [{ type: "address", text: "רוטשילד 10 פתח תקווה", shape: "POINT(3883045.17 3774987.41)" }] },
    "real-estate/deals/": [{ polygon_id: "p1", streetNameHeb: "רוטשילד", houseNum: 10, settlementNameHeb: "פתח תקווה", dealscount: "8" }],
    "street-deals/p1": { data: Array.from({ length: 8 }, (_, i) => govmapRow(i)) },
    "neighborhood-deals/p1": { data: [] },
    "api.cbs.gov.il": cbs,
    "settlement/rent/7900.json": nadlanRent,
    "settlement/buy/7900.json": { ...nadlanRent, trends: { rooms: [{ numRooms: "all", graphData: [{ settlementPrice: 1_500_000, year: 2021, month: 3 }] }] } },
    ...overrides,
  });
}

beforeEach(() => resetSettlementCache());

describe("sourcesFor", () => {
  it("routes residential and commercial assets to the right sources", () => {
    expect(sourcesFor("apartment", "sale")).toEqual(["govmap", "madlan", "nadlan-gov"]);
    expect(sourcesFor("apartment", "rent")).toEqual(["yad2", "madlan", "nadlan-gov"]);
    expect(sourcesFor("office", "sale")).toEqual(["govmap"]);
    expect(sourcesFor("retail", "rent")).toEqual(["yad2"]);
  });
});

describe("valueAsset", () => {
  it("values an apartment end to end from the HTTP sources", async () => {
    const r = await valueAsset(
      { city: "פתח תקווה", address: "רוטשילד 10", type: "apartment", areaSqm: 90, rooms: 3 },
      { fetch: routes(), browser: false },
    );
    expect(r.asset.canonicalAddress).toBe("רוטשילד 10 פתח תקווה");
    expect(r.asset.settlementCode).toBe("7900");
    expect(r.asset.location!.lat).toBeCloseTo(32.0886, 3);

    expect(r.sale!.estimate!.sources).toEqual(["govmap"]);
    expect(r.sale!.estimate!.count).toBe(8);
    expect(r.sale!.estimate!.value!.mid).toBeGreaterThan(2_000_000);
    const madlan = r.sale!.sources.find((s) => s.source === "madlan")!;
    expect(madlan.status).toBe("skipped");

    // No listings without a browser → the published median, rolled forward 100 → 120.
    expect(r.rent!.estimate!.sources).toEqual(["nadlan-gov"]);
    expect(r.rent!.estimate!.value!.mid).toBe(4_800); // 3-room bucket 4,000 × 1.2
    expect(r.warnings.join(" ")).toMatch(/no asking-rent listings/);
  });

  it("reports a blocked source as blocked, not as an empty market", async () => {
    const r = await valueAsset(
      { city: "פתח תקווה", address: "רוטשילד 10", type: "apartment", areaSqm: 90 },
      {
        fetch: routes({ "real-estate/deals/": new Response("<html>denied</html>", { status: 403 }) }),
        browser: false,
        deals: ["sale"],
      },
    );
    const gov = r.sale!.sources.find((s) => s.source === "govmap")!;
    expect(gov.status).toBe("blocked");
    expect(r.warnings.join(" ")).toMatch(/govmap \(sale\) was blocked/);
    // The published median still answers.
    expect(r.sale!.estimate!.sources).toEqual(["nadlan-gov"]);
  });

  it("derives commercial rent from the sale band when there are no listings", async () => {
    const shops = Array.from({ length: 6 }, (_, i) => govmapRow(i, "חנות"));
    const r = await valueAsset(
      { city: "פתח תקווה", address: "רוטשילד 10", type: "retail", areaSqm: 50 },
      { fetch: routes({ "street-deals/p1": { data: shops } }), browser: false },
    );
    expect(r.sale!.sources.map((s) => s.source)).toEqual(["govmap"]);
    expect(r.rent!.estimate!.sources).toEqual(["govmap"]);
    expect(r.rent!.estimate!.method).toMatch(/gross yield/);
  });

  it("hides the internal GovMap leg when only rent was asked for", async () => {
    const r = await valueAsset(
      { city: "פתח תקווה", address: "רוטשילד 10", type: "office", areaSqm: 50 },
      { fetch: routes(), browser: false, deals: ["rent"] },
    );
    expect(r.sale).toBeNull();
    expect(r.rent!.sources.map((s) => s.source)).toEqual(["yad2"]);
  });

  it("omits raw comps when includeComps is false", async () => {
    const r = await valueAsset(
      { city: "פתח תקווה", address: "רוטשילד 10", type: "apartment", areaSqm: 90 },
      { fetch: routes(), browser: false, deals: ["sale"], includeComps: false },
    );
    expect(r.sale!.estimate).not.toBeNull();
    expect(r.sale!.sources.every((s) => s.comps.length === 0)).toBe(true);
  });

  it("does not treat a city centroid as the asset's location", async () => {
    const r = await valueAsset({ city: "פתח תקווה", type: "apartment" }, { fetch: routes(), browser: false, deals: ["sale"] });
    expect(r.asset.location).toBeUndefined();
    expect(r.sale!.sources.find((s) => s.source === "govmap")!).toMatchObject({ status: "skipped", reason: "needs an address or location" });
    expect(r.sale!.estimate!.sources).toEqual(["nadlan-gov"]);
  });

  it("validates its input", async () => {
    await expect(valueAsset({ city: "", type: "apartment" })).rejects.toThrow(/city is required/);
    await expect(valueAsset({ city: "חיפה", type: "castle" as never })).rejects.toThrow(/asset.type/);
    await expect(valueAsset({ city: "חיפה", type: "apartment", areaSqm: -3 })).rejects.toThrow(/areaSqm/);
  });
});
