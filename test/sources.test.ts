import { describe, expect, it } from "vitest";
import { chainToLatestBase, escalate } from "../src/sources/cbs.js";
import { natureClass, toGovmapDeal } from "../src/sources/govmap.js";
import {
  extractMadlanBulletins,
  madlanBulletinToComp,
  madlanDocId,
  mergeDefined,
  parseMadlanInsights,
  parseSsrContext,
} from "../src/sources/madlan.js";
import { medianFromPage, roomBucketValue } from "../src/sources/nadlan-gov.js";
import { itemsFromNextData, yad2ItemToComp, yad2ListUrl, yad2MapFeedUrl } from "../src/sources/yad2.js";

describe("CBS index", () => {
  it("chains rebased segments into one continuous series", () => {
    const rows = [
      { month: "2023-12-01", year: 2023, value: 110, baseDesc: "2022 ממוצע" },
      { month: "2024-06-01", year: 2024, value: 120, baseDesc: "2022 ממוצע" },
      { month: "2024-12-01", year: 2024, value: 120, baseDesc: "2022 ממוצע" },
      { month: "2025-01-01", year: 2025, value: 101, baseDesc: "2024 ממוצע" },
    ];
    const chained = chainToLatestBase(rows);
    // 2024 averaged 120 on the old base = 100 on the new one.
    expect(chained.find((p) => p.month === "2024-06-01")!.value).toBeCloseTo(100, 4);
    expect(chained.at(-1)!.value).toBe(101);
  });
  it("escalates an amount from an anchor month", () => {
    const series = [
      { month: "2021-03-01", value: 100 },
      { month: "2026-06-01", value: 125 },
    ];
    expect(escalate(4_000, "2021-03-01", series)).toMatchObject({ value: 5_000, factor: 1.25, toMonth: "2026-06-01" });
    expect(escalate(4_000, "2021-03-01", [])).toBeNull();
  });
});

describe("GovMap", () => {
  it("normalizes a registry row", () => {
    const d = toGovmapDeal({
      dealId: 123,
      dealDate: "2025-04-01T00:00:00.000Z",
      dealAmount: 2_400_000,
      assetArea: 80,
      assetRoomNum: 3.5,
      floorNo: "שניה",
      dealNatureDescription: "דירה בבית קומות",
      streetNameHeb: "רוטשילד",
      houseNum: 10.0,
      settlementNameHeb: "פתח תקווה",
      settlementId: 7900,
      neighborhood: "מרכז העיר",
    })!;
    expect(d).toMatchObject({ dealId: "123", dealDate: "2025-04-01", pricePerSqm: 30_000, houseNum: "10", settlementId: "7900" });
  });
  it("classifies deal natures", () => {
    expect(natureClass("דירה בבית קומות")).toBe("residential");
    expect(natureClass("משרדים")).toBe("office");
    expect(natureClass("חנויות")).toBe("retail");
    expect(natureClass("מחסנים")).toBe("warehouse");
    expect(natureClass("חניה")).toBe("parking");
    expect(natureClass("מלונות")).toBe("hotel");
    expect(natureClass(null)).toBe("unknown");
  });
});

describe("nadlan.gov.il", () => {
  const page = {
    trends: {
      rooms: [
        { numRooms: "3", graphData: [{ settlementPrice: 3_500, year: 2020, month: 12 }, { settlementPrice: 3_766, year: 2021, month: 3 }] },
        { numRooms: "4", graphData: [{ settlementPrice: 4_673, year: 2021, month: 3 }] },
        { numRooms: "5", graphData: [{ settlementPrice: 5_949, year: 2021, month: 3 }] },
        { numRooms: "all", graphData: [{ settlementPrice: 3_753, year: 2021, month: 3 }] },
      ],
    },
  };
  it("collapses room series into a band", () => {
    expect(medianFromPage(page, "settlementPrice")).toEqual({
      low: 3_753,
      mid: 3_753,
      high: 5_949,
      perRoom: { "3": 3_766, "4": 4_673, "5": 5_949 },
      asOf: "2021-03-01",
    });
  });
  it("picks the nearest published room bucket", () => {
    expect(roomBucketValue({ "3": 1, "4": 2, "5": 3 }, 4)).toBe(2);
    expect(roomBucketValue({ "3": 1, "4": 2, "5": 3 }, 6)).toBe(3);
    expect(roomBucketValue({ "3": 1 }, null)).toBeNull();
  });
});

describe("Madlan", () => {
  it("never lets a lean map marker erase a full record's rooms and area", () => {
    const full: Record<string, unknown> = { id: "x", price: 6_000, beds: 4, area: 100 };
    const marker: Record<string, unknown> = { id: "x", price: 6_100, beds: null, area: undefined };
    expect(mergeDefined(full, marker)).toEqual({ id: "x", price: 6_100, beds: 4, area: 100 });
    expect(mergeDefined(marker, full)).toEqual({ id: "x", price: 6_000, beds: 4, area: 100 });
  });

  it("builds Madlan document ids", () => {
    expect(madlanDocId({ street: "רוטשילד", houseNumber: "10", city: "פתח תקווה" })).toBe("רוטשילד-10-פתח-תקווה-ישראל");
    expect(madlanDocId({ street: "", city: "תל אביב - יפו" })).toBe("תל-אביב---יפו-ישראל");
  });

  it("parses deals from docId2Insights, building first", () => {
    const deals = parseMadlanInsights({
      insights: [
        {
          type: "prices",
          summary: {
            nonText: {
              data: {
                building: [{ saleId: "a", date: "2025-02-01", amount: 2_000_000, size: 80, pricePerMeter: 25_000, beds: 3, addressRecord: { stName: "הרצל", hNo: 1, city: "רמת גן" } }],
                area: [
                  { saleId: "a", amount: 1 },
                  { saleId: "b", date: "2024-01-01", amount: 1_800_000, size: 90, beds: 4, addressRecord: { relevantDocIds: [{ type: "neighbourhood", text: "הבורסה" }] } },
                ],
              },
            },
          },
        },
      ],
    });
    expect(deals.map((d) => [d.saleId, d.scope])).toEqual([["a", "building"], ["b", "area"]]);
    expect(deals[1]).toMatchObject({ pricePerSqm: 20_000, neighborhood: "הבורסה" });
  });

  it("reads rent bulletins from the SSR context without evaluating it", () => {
    const ctx = {
      reduxInitialState: {
        domainData: {
          searchList: {
            data: {
              searchPoiV2: {
                poi: [
                  {
                    id: "x1",
                    type: "bulletin",
                    dealType: "unitRent",
                    price: 6_000,
                    beds: 4,
                    area: 100,
                    floor: "3",
                    locationPoint: { lat: 32.09, lng: 34.88 },
                    addressDetails: { city: "פתח תקווה", streetName: "רוטשילד", streetNumber: "10", neighbourhood: "מרכז העיר" },
                  },
                  { id: "p1", type: "project", price: null },
                ],
              },
            },
          },
        },
      },
    };
    const html = `<script>window.__SSR_HYDRATED_CONTEXT__=${JSON.stringify(ctx).replace('"floor":"3"', '"floor":"3","x":undefined')};</script>`;
    const parsed = parseSsrContext(html);
    const bulletins = extractMadlanBulletins(parsed);
    expect(bulletins).toHaveLength(1);
    const c = madlanBulletinToComp(bulletins[0], { lat: 32.09, lng: 34.88 })!;
    expect(c).toMatchObject({ source: "madlan", deal: "rent", price: 6_000, rooms: 4, pricePerSqm: 60, distanceM: 0, street: "רוטשילד" });
    expect(parseSsrContext("<html></html>")).toBeNull();
  });
});

describe("Yad2", () => {
  const nextData = {
    props: {
      pageProps: {
        feed: {
          private: [
            {
              token: "abc123",
              price: 5_500,
              adType: "private",
              address: { city: { text: "פתח תקווה" }, neighborhood: { text: "מרכז העיר" }, street: { text: "הרצל" }, house: { number: 3, floor: 2 }, coords: { lat: 32.09, lon: 34.88 } },
              additionalDetails: { property: { text: "דירה" }, roomsCount: 3, squareMeter: 75 },
            },
          ],
          agency: [{ token: "def456", price: 0, address: {}, additionalDetails: {} }],
          pagination: { total: 2 },
        },
      },
    },
  };

  it("flattens the feed groups", () => {
    expect(itemsFromNextData(nextData).map((i) => i.token)).toEqual(["abc123", "def456"]);
  });

  it("maps a feed item and drops price-on-request items", () => {
    const [a, b] = itemsFromNextData(nextData);
    expect(yad2ItemToComp(a, false, null)).toMatchObject({
      id: "abc123",
      price: 5_500,
      areaSqm: 75,
      rooms: 3,
      street: "הרצל",
      houseNumber: "3",
      url: "https://www.yad2.co.il/realestate/item/abc123",
    });
    expect(yad2ItemToComp(b, false, null)).toBeNull();
  });

  it("builds list and map-feed URLs", () => {
    const loc = { cityId: "7900", areaId: "4", regionId: "1", streetId: "0214" };
    expect(yad2ListUrl(loc, false, true)).toBe("https://www.yad2.co.il/realestate/rent?city=7900&area=4&region=1&street=0214");
    expect(yad2ListUrl(loc, true, false)).toBe("https://www.yad2.co.il/realestate/commercial/center-and-sharon?dealType=1&city=7900&area=4");
    expect(yad2MapFeedUrl(loc, true, true)).toBe("https://gw.yad2.co.il/realestate-feed/commercial/map?dealType=1&region=1&area=4&city=7900&street=0214");
  });
});
