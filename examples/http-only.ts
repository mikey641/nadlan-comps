// Serverless-friendly: no browser, only the open government APIs (GovMap, nadlan.gov.il, CBS).
// npx tsx examples/http-only.ts
import { valueAsset } from "nadlan-comps";

const report = await valueAsset(
  { city: "חיפה", address: "הנביאים 20", type: "apartment", areaSqm: 70, rooms: 3 },
  { browser: false },
);

console.log(report.sale?.estimate, report.rent?.estimate);
