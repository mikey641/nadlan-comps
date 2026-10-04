import { describe, expect, it } from "vitest";
import { blendEstimates } from "../src/analysis/blend.js";
import { dedupeListings, isSaneRent, rentEstimate, rentFromSaleBand, roomBucket } from "../src/analysis/rent.js";
import { exactClassCount, isSaneSale, saleBand } from "../src/analysis/sale.js";
import { comp, listing } from "./helpers.js";

const NOW = new Date("2026-10-01T00:00:00Z");
const range = (n: number, f: (i: number) => any) => Array.from({ length: n }, (_, i) => f(i));

describe("saleBand", () => {
  it("returns p25/p50/p75 ₪/m² and scales by area", () => {
    const comps = range(5, (i) => comp({ price: 2_000_000 + i * 100_000, areaSqm: 100 }));
    const band = saleBand(comps, { type: "apartment", areaSqm: 90, now: NOW, sourceLabel: "test" })!;
    expect(band.perSqm).toEqual({ low: 21_000, mid: 22_000, high: 23_000 });
    expect(band.value).toEqual({ low: 1_890_000, mid: 1_980_000, high: 2_070_000 });
    expect(band.count).toBe(5);
  });

  it("never prices an office from dwellings", () => {
    const dwellings = range(10, () => comp({ propertyType: "דירה בבית קומות" }));
    expect(saleBand(dwellings, { type: "office", now: NOW, sourceLabel: "t" })).toBeNull();
  });

  it("prefers the exact class, then widens to any commercial class", () => {
    const offices = range(4, () => comp({ propertyType: "משרדים", price: 3_000_000, areaSqm: 100 }));
    const shops = range(6, () => comp({ propertyType: "חנות", price: 5_000_000, areaSqm: 100 }));
    expect(saleBand([...offices, ...shops], { type: "office", now: NOW, sourceLabel: "t" })!.method).toMatch(/^4 office deals/);
    const twoOffices = offices.slice(0, 2);
    const widened = saleBand([...twoOffices, ...shops], { type: "office", now: NOW, sourceLabel: "t" })!;
    expect(widened.method).toMatch(/commercial \(widened\)/);
    expect(widened.count).toBe(8);
  });

  it("widens the recency window before giving up", () => {
    const old = range(5, (i) => comp({ date: `2018-0${i + 1}-01` }));
    const band = saleBand(old, { type: "apartment", now: NOW, sourceLabel: "t" })!;
    expect(band.method).toContain("all history");
  });

  it("restates old deals at today's level with the CBS index", () => {
    const deals = range(5, () => comp({ date: "2020-06-15", price: 1_000_000, areaSqm: 50 })); // 20,000/m²
    const index = [
      { month: "2020-06-01", value: 100 },
      { month: "2026-06-01", value: 150 },
    ];
    const band = saleBand(deals, { type: "apartment", now: NOW, index, sourceLabel: "t" })!;
    expect(band.perSqm!.mid).toBe(30_000);
  });

  it("drops implausible registry rows and size outliers", () => {
    expect(isSaneSale(comp({ price: 370_000, areaSqm: 1 }))).toBe(false);
    expect(isSaneSale(comp({ price: 50_000, areaSqm: 40 }))).toBe(false);
    const shops = range(4, () => comp({ propertyType: "חנות", price: 3_000_000, areaSqm: 60 }));
    const anchor = range(4, () => comp({ propertyType: "חנות", price: 20_000_000, areaSqm: 1_200 }));
    const band = saleBand([...shops, ...anchor], { type: "retail", areaSqm: 60, now: NOW, sourceLabel: "t" })!;
    expect(band.count).toBe(4);
    expect(band.perSqm!.mid).toBe(50_000);
  });

  it("counts exact-class recent deals for radius widening", () => {
    const comps = [comp({ propertyType: "משרדים" }), comp({ propertyType: "משרדים", date: "2015-01-01" }), comp()];
    expect(exactClassCount(comps, "office", 36, NOW)).toBe(1);
  });
});

describe("rentEstimate", () => {
  it("uses the subject's room bucket", () => {
    const threes = range(6, (i) => listing({ rooms: 3, price: 5_000 + i * 100 }));
    const fours = range(6, () => listing({ rooms: 4, price: 8_000 }));
    const est = rentEstimate([...threes, ...fours], { type: "apartment", rooms: 3, sourceLabel: "t" })!;
    expect(est.value!.mid).toBe(5_300);
    expect(est.method).toMatch(/3-room/);
  });

  it("widens a thin bucket to all sizes", () => {
    const pool = [listing({ rooms: 5, price: 9_000 }), ...range(6, () => listing({ rooms: 3, price: 5_000 }))];
    const est = rentEstimate(pool, { type: "apartment", rooms: 5, sourceLabel: "t" })!;
    expect(est.method).toMatch(/thin 5\+-room bucket/);
    expect(est.count).toBe(7);
  });

  it("prices commercial rent per m² and drops junk listings", () => {
    const pool = [
      ...range(5, (i) => listing({ propertyType: "משרדים", price: 10_000 + i * 1_000, areaSqm: 100 })),
      listing({ propertyType: "משרדים", price: 150, areaSqm: 150 }),
    ];
    const est = rentEstimate(pool, { type: "office", areaSqm: 200, sourceLabel: "t" })!;
    expect(est.count).toBe(5);
    expect(est.perSqm!.mid).toBe(120);
    expect(est.value!.mid).toBe(24_000);
  });

  it("prefers nearby listings when enough exist", () => {
    const near = range(5, () => listing({ distanceM: 400, price: 5_000 }));
    const far = range(5, () => listing({ distanceM: 9_000, price: 9_000 }));
    expect(rentEstimate([...near, ...far], { type: "apartment", sourceLabel: "t" })!.value!.mid).toBe(5_000);
  });

  it("ignores residential listings with neither rooms nor area", () => {
    const sized = range(5, () => listing({ rooms: 4, price: 7_000 }));
    const bare = range(40, () => listing({ rooms: null, areaSqm: null, price: 3_000 }));
    const est = rentEstimate([...sized, ...bare], { type: "apartment", rooms: 4, sourceLabel: "t" })!;
    expect(est.count).toBe(5);
    expect(est.value!.mid).toBe(7_000);
  });

  it("buckets rooms the way the market quotes them", () => {
    expect(roomBucket(2)).toBe("1-2");
    expect(roomBucket(3)).toBe("3");
    expect(roomBucket(3.5)).toBe("4");
    expect(roomBucket(6)).toBe("5+");
    expect(roomBucket(null)).toBeNull();
  });

  it("dedupes a flat listed on two boards", () => {
    const a = listing({ source: "yad2" });
    const b = listing({ source: "madlan" });
    expect(dedupeListings([a, b])).toHaveLength(1);
    expect(isSaneRent(listing({ price: 1 }))).toBe(false);
  });

  it("derives commercial rent from value at a 6–8% gross yield", () => {
    const rent = rentFromSaleBand(
      { perSqm: { low: 20_000, mid: 24_000, high: 30_000 }, value: null, count: 5, method: "" },
      100,
    )!;
    expect(rent.perSqm).toEqual({ low: 100, mid: 140, high: 200 });
    expect(rent.value!.mid).toBe(14_000);
  });
});

describe("blendEstimates", () => {
  it("weights by comp count, capped", () => {
    const blended = blendEstimates([
      { source: "govmap", estimate: { perSqm: { low: 20_000, mid: 20_000, high: 20_000 }, value: null, count: 10, method: "" } },
      { source: "madlan", estimate: { perSqm: { low: 30_000, mid: 30_000, high: 30_000 }, value: null, count: 500, method: "" } },
    ])!;
    // 10 vs capped 30 → (20k·10 + 30k·30) / 40
    expect(blended.perSqm!.mid).toBe(27_500);
    expect(blended.sources).toEqual(["govmap", "madlan"]);
  });
  it("passes a single source through", () => {
    const e = { perSqm: null, value: { low: 1, mid: 2, high: 3 }, count: 1, method: "m" };
    expect(blendEstimates([{ source: "yad2", estimate: e }])).toEqual({ ...e, sources: ["yad2"] });
    expect(blendEstimates([])).toBeNull();
  });
});
