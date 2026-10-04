import { describe, expect, it } from "vitest";
import { haversineM, mercatorToWgs84, wgs84ToMercator } from "../src/util/geo.js";
import { median, num, percentile, quartiles } from "../src/util/stats.js";
import { hasHebrew, placeKey, splitAddress } from "../src/util/text.js";

describe("splitAddress", () => {
  it("splits street and house number", () => {
    expect(splitAddress("רוטשילד 10")).toEqual({ street: "רוטשילד", houseNumber: "10" });
    expect(splitAddress("Rothschild 10")).toEqual({ street: "Rothschild", houseNumber: "10" });
    expect(splitAddress("הרצל 12א")).toEqual({ street: "הרצל", houseNumber: "12א" });
  });
  it("drops floor / apartment / entrance suffixes", () => {
    expect(splitAddress("ז'בוטינסקי 7, קומה 9 דירה 93")).toEqual({ street: "ז'בוטינסקי", houseNumber: "7" });
    expect(splitAddress("Rothschild 22, apt 4")).toEqual({ street: "Rothschild", houseNumber: "22" });
  });
  it("tolerates a street without a number", () => {
    expect(splitAddress("שדרות רוטשילד")).toEqual({ street: "שדרות רוטשילד", houseNumber: null });
    expect(splitAddress(undefined)).toEqual({ street: "", houseNumber: null });
  });
});

describe("placeKey", () => {
  it("treats punctuation and spacing variants as one place", () => {
    expect(placeKey("תל אביב - יפו")).toBe(placeKey("תל אביב יפו"));
    expect(placeKey("Ra'anana")).toBe(placeKey("Raanana"));
    expect(placeKey("קריית גת")).toBe(placeKey("קרית גת"));
  });
  it("detects Hebrew", () => {
    expect(hasHebrew("פתח תקווה")).toBe(true);
    expect(hasHebrew("Petah Tikva")).toBe(false);
  });
});

describe("geo", () => {
  it("round-trips Web-Mercator and WGS84", () => {
    const p = mercatorToWgs84(3883045.17, 3774987.41);
    expect(p.lat).toBeCloseTo(32.0886, 3);
    expect(p.lng).toBeCloseTo(34.8822, 3);
    const back = wgs84ToMercator(p.lat, p.lng);
    expect(back.x).toBeCloseTo(3883045.17, 1);
    expect(back.y).toBeCloseTo(3774987.41, 1);
  });
  it("measures distance in meters", () => {
    expect(haversineM({ lat: 32.0853, lng: 34.7818 }, { lat: 32.0853, lng: 34.7918 })).toBeGreaterThan(900);
    expect(haversineM({ lat: 32.0853, lng: 34.7818 }, { lat: 32.0853, lng: 34.7918 })).toBeLessThan(1000);
  });
});

describe("stats", () => {
  it("computes nearest-rank percentiles and medians", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(3); // (2+3)/2 rounded
    expect(median([])).toBeNull();
    expect(quartiles([10, 20, 30, 40, 50])).toEqual({ low: 20, mid: 30, high: 40 });
  });
  it("parses loose numbers", () => {
    expect(num("1,250,000")).toBe(1_250_000);
    expect(num("85 מ״ר")).toBe(85);
    expect(num(0)).toBeNull();
    expect(num(null)).toBeNull();
  });
});
