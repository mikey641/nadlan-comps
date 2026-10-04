// A shop: GovMap retail deals for value, Yad2's commercial vertical for rent.
// npx tsx examples/commercial.ts
import { valueAsset } from "nadlan-comps";

const report = await valueAsset(
  { city: "Tel Aviv", address: "Dizengoff 100", type: "retail", areaSqm: 60 },
  { sources: ["govmap", "yad2"] },
);

console.log(JSON.stringify({ sale: report.sale?.estimate, rent: report.rent?.estimate, warnings: report.warnings }, null, 2));
