import { parseArgs } from "node:util";
import { ALL_SOURCES, ASSET_TYPES, valueAsset } from "./value-asset.js";
import type { AssetType, Band, DealKind, DealValuation, SourceId, ValuationReport } from "./types.js";

const HELP = `nadlan-comps — value one Israeli property from GovMap, nadlan.gov.il, Madlan and Yad2

Usage
  nadlan-comps --city <city> [--address <street + number>] --type <type> [options]

Asset
  --city <name>         City, Hebrew or English (required)       e.g. "פתח תקווה", "Petah Tikva"
  --address <text>      Street and house number                   e.g. "רוטשילד 10"
  --neighborhood <name> Neighborhood (refines nadlan.gov.il medians)
  --type <type>         ${ASSET_TYPES.join(" | ")} (default: apartment)
  --area <m2>           Area in m² (needed for whole-property values)
  --rooms <n>           Rooms, e.g. 3.5
  --floor <n>           Floor

Options
  --deal <sale|rent>    Value one side only (default: both)
  --sources <list>      Comma-separated subset of: ${ALL_SOURCES.join(",")}
  --no-browser          Skip the browser sources (Madlan, Yad2)
  --headful             Show the browser window (helps clear a bot challenge)
  --headless            Force headless for every browser source
  --chrome <path>       Chrome / Chromium executable
  --proxy <url>         Browser proxy, e.g. http://user:pass@host:port
  --yad2-relay <url>    Read Yad2 through a relay (see relay/cloudflare-yad2)
  --yad2-relay-token <token>
  --months <n>          Primary recency window for deal comps (default: 36)
  --json                Print the full JSON report
  -v, --verbose         Log progress to stderr
  -h, --help            Show this help
`;

function fail(message: string): never {
  process.stderr.write(`nadlan-comps: ${message}\n\nRun with --help for usage.\n`);
  process.exit(2);
}

const ils = (n: number) => `₪${Math.round(n).toLocaleString("en-US")}`;
const band = (b: Band | null, suffix = "") => (b ? `${ils(b.low)} – ${ils(b.high)}${suffix}  (mid ${ils(b.mid)}${suffix})` : "—");

function printDeal(title: string, v: DealValuation | null, unit: string) {
  if (!v) return;
  const out: string[] = [`\n${title}`];
  if (v.estimate) {
    out.push(`  value     ${band(v.estimate.value, unit)}`);
    out.push(`  per m²    ${band(v.estimate.perSqm, unit)}`);
    out.push(`  basis     ${v.estimate.method}`);
  } else out.push("  no estimate");
  for (const s of v.sources) {
    const detail = s.estimate
      ? `${s.source === "nadlan-gov" ? "published median" : `${s.estimate.count} comps`}, mid ${s.estimate.value ? ils(s.estimate.value.mid) : `${ils(s.estimate.perSqm!.mid)}/m²`}` : s.reason ?? "";
    out.push(`  · ${s.source.padEnd(10)} ${s.status.padEnd(8)} ${detail}  [${(s.durationMs / 1000).toFixed(1)}s]`);
  }
  process.stdout.write(out.join("\n") + "\n");
}

function printReport(r: ValuationReport) {
  const a = r.asset;
  process.stdout.write(
    `${a.canonicalAddress ?? [a.address, a.city].filter(Boolean).join(", ")} · ${a.type}` +
      `${a.areaSqm ? ` · ${a.areaSqm} m²` : ""}${a.rooms ? ` · ${a.rooms} rooms` : ""}\n`,
  );
  printDeal("SALE", r.sale, "");
  printDeal("RENT (monthly)", r.rent, "");
  if (r.warnings.length) process.stdout.write(`\nNotes\n${r.warnings.map((w) => `  - ${w}`).join("\n")}\n`);
  process.stdout.write(`\n${(r.durationMs / 1000).toFixed(1)}s\n`);
}

async function main() {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        city: { type: "string" },
        address: { type: "string" },
        neighborhood: { type: "string" },
        type: { type: "string", default: "apartment" },
        area: { type: "string" },
        rooms: { type: "string" },
        floor: { type: "string" },
        deal: { type: "string" },
        sources: { type: "string" },
        "no-browser": { type: "boolean" },
        headful: { type: "boolean" },
        headless: { type: "boolean" },
        chrome: { type: "string" },
        proxy: { type: "string" },
        "yad2-relay": { type: "string" },
        "yad2-relay-token": { type: "string" },
        months: { type: "string" },
        json: { type: "boolean" },
        verbose: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    fail((e as Error).message);
  }
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const str = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : undefined);
  const number = (k: string) => {
    const s = str(k);
    if (s == null) return undefined;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) fail(`--${k} must be a positive number`);
    return n;
  };
  if (!str("city")) fail("--city is required");
  const type = str("type") as AssetType;
  if (!ASSET_TYPES.includes(type)) fail(`--type must be one of ${ASSET_TYPES.join(", ")}`);
  const deal = str("deal");
  if (deal && deal !== "sale" && deal !== "rent") fail("--deal must be sale or rent");
  const sources = str("sources")?.split(",").map((s) => s.trim()) as SourceId[] | undefined;
  for (const s of sources ?? []) if (!ALL_SOURCES.includes(s)) fail(`unknown source "${s}"`);

  const verbose = Boolean(values.verbose);
  const report = await valueAsset(
    {
      city: str("city")!,
      address: str("address"),
      neighborhood: str("neighborhood"),
      type,
      areaSqm: number("area"),
      rooms: number("rooms"),
      floor: str("floor") != null ? Number(str("floor")) : undefined,
    },
    {
      deals: deal ? [deal as DealKind] : undefined,
      sources,
      browser: values["no-browser"] ? false : "auto",
      browserLaunch: {
        headless: values.headful ? false : values.headless ? true : undefined,
        executablePath: str("chrome"),
        proxy: str("proxy"),
      },
      yad2Relay: str("yad2-relay") ? { url: str("yad2-relay")!, token: str("yad2-relay-token") } : undefined,
      monthsBack: number("months"),
      includeComps: Boolean(values.json),
      logger: verbose
        ? { debug: (m) => process.stderr.write(`· ${m}\n`), info: (m) => process.stderr.write(`· ${m}\n`), warn: (m) => process.stderr.write(`! ${m}\n`) }
        : undefined,
    },
  );
  if (values.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else printReport(report);
}

main().catch((e) => {
  process.stderr.write(`nadlan-comps: ${(e as Error)?.message ?? e}\n`);
  process.exit(1);
});
