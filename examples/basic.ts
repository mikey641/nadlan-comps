// npx tsx examples/basic.ts
import { valueAsset } from "nadlan-comps";

const report = await valueAsset({
  city: "רמת גן",
  address: "ביאליק 30",
  type: "apartment",
  areaSqm: 85,
  rooms: 3.5,
});

const fmt = (n?: number) => (n == null ? "—" : `₪${n.toLocaleString("en-US")}`);
console.log(report.asset.canonicalAddress);
console.log("sale:", fmt(report.sale?.estimate?.value?.mid), "—", report.sale?.estimate?.method);
console.log("rent:", fmt(report.rent?.estimate?.value?.mid), "/ month —", report.rent?.estimate?.method);
for (const s of [...(report.sale?.sources ?? []), ...(report.rent?.sources ?? [])]) {
  console.log(`  ${s.deal.padEnd(4)} ${s.source.padEnd(10)} ${s.status}${s.reason ? ` (${s.reason})` : ""}`);
}
