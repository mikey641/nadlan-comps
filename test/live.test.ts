// Opt-in smoke test against the real sources: `npm run test:live`.
// Catches upstream API drift; never runs in CI by default.
import { describe, expect, it } from "vitest";
import { valueAsset } from "../src/index.js";

const live = Boolean(process.env.NADLAN_COMPS_LIVE);
const withBrowser = process.env.NADLAN_COMPS_LIVE === "browser";

describe.skipIf(!live)("live sources", () => {
  it(
    "values an apartment from the HTTP sources",
    async () => {
      const r = await valueAsset(
        { city: "רמת גן", address: "ביאליק 30", type: "apartment", areaSqm: 85, rooms: 3.5 },
        { browser: withBrowser ? "auto" : false },
      );
      expect(r.asset.canonicalAddress).toContain("רמת גן");
      expect(r.sale?.sources.find((s) => s.source === "govmap")?.status).toBe("ok");
      expect(r.sale?.sources.find((s) => s.source === "nadlan-gov")?.status).toBe("ok");
      expect(r.sale?.estimate?.value?.mid).toBeGreaterThan(500_000);
      expect(r.rent?.estimate?.value?.mid).toBeGreaterThan(1_000);
      if (withBrowser) {
        expect(r.rent?.sources.find((s) => s.source === "yad2")?.status).toBe("ok");
        expect(r.sale?.sources.find((s) => s.source === "madlan")?.status).toBe("ok");
      }
    },
    240_000,
  );

  it(
    "geocodes an English address",
    async () => {
      const r = await valueAsset(
        { city: "Tel Aviv", address: "Rothschild 22", type: "office", areaSqm: 150 },
        { browser: false, deals: ["sale"] },
      );
      expect(r.asset.canonicalAddress).toMatch(/רוטשילד/);
    },
    120_000,
  );
});
