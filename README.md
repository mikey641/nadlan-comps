# nadlan-comps

**Comparable-sales and rent valuations for a single Israeli property — one function call, four data sources.**

[![CI](https://github.com/mikey641/nadlan-comps/actions/workflows/ci.yml/badge.svg)](https://github.com/mikey641/nadlan-comps/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933)
![TypeScript](https://img.shields.io/badge/types-included-3178c6)

Give it an address, a city, an asset type and an area. It works out which Israeli market-data
sources apply to that asset, queries them in parallel, cleans and filters the comparables, and
returns a sale value and a monthly rent — each as a low / mid / high band, with a per-source
breakdown that shows where every number came from.

| Source | What it contributes | Access |
| --- | --- | --- |
| **[GovMap](https://www.govmap.gov.il)** | Israel Tax Authority closed sale transactions (רשות המסים), residential and commercial | Open JSON API |
| **[nadlan.gov.il](https://www.nadlan.gov.il)** | Published city / neighborhood median prices, to buy and to rent | Open static JSON |
| **[Madlan](https://www.madlan.co.il)** | Closed residential deals, asking rents | Browser (bot-protected) |
| **[Yad2](https://www.yad2.co.il)** | Asking rents — residential and commercial (נדל״ן מסחרי) | Browser, or an optional relay |

[CBS](https://www.cbs.gov.il) price indices are used to restate old deals and stale medians at today's price level.

```ts
import { valueAsset } from "nadlan-comps";

const report = await valueAsset({
  city: "רמת גן",
  address: "ביאליק 30",
  type: "apartment",
  areaSqm: 85,
  rooms: 3.5,
});

report.sale?.estimate?.value; // { low: 2_522_815, mid: 3_119_010, high: 3_508_410 }   ₪
report.rent?.estimate?.value; // { low: 6_400,     mid: 7_200,     high: 7_700 }       ₪ / month
```

## Contents

- [Install](#install)
- [Command line](#command-line)
- [Usage](#usage)
- [Which sources run](#which-sources-run)
- [The report](#the-report)
- [Options](#options)
- [Running on a server](#running-on-a-server)
- [How the numbers are made](#how-the-numbers-are-made)
- [Limitations](#limitations)
- [Responsible use](#responsible-use)
- [בעברית](#בעברית)

## Install

```sh
npm install nadlan-comps
```

That is enough for the open government sources (GovMap, nadlan.gov.il, CBS). Madlan and Yad2 sit
behind bot protection and are read through a real browser, so add
[patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) (a Playwright build with
the automation fingerprints patched) to enable them:

```sh
npm install patchright
# Uses your installed Google Chrome. Without Chrome:
npx patchright install chromium
```

Requires Node.js 20 or newer. Ships ESM, CommonJS and TypeScript types.

## Command line

```sh
npx nadlan-comps --city "רמת גן" --address "ביאליק 30" --type apartment --area 85 --rooms 3.5
```

```text
ביאליק 30 רמת גן · apartment · 85 m² · 3.5 rooms

SALE
  value     ₪2,522,815 – ₪3,508,410  (mid ₪3,119,010)
  per m²    ₪29,680 – ₪41,275  (mid ₪36,694)
  basis     comp-weighted blend of govmap (21) + madlan (173)
  · govmap     ok       21 comps, mid ₪2,969,560  [0.7s]
  · nadlan-gov ok       published median, mid ₪2,754,513  [0.1s]
  · madlan     ok       173 comps, mid ₪3,223,625  [3.4s]

RENT (monthly)
  value     ₪6,400 – ₪7,700  (mid ₪7,200)
  per m²    ₪69 – ₪82  (mid ₪76)
  basis     16 4-room, similar size asking rents · yad2.co.il + madlan.co.il
  · nadlan-gov ok       published median, mid ₪6,372  [0.3s]
  · madlan     ok       14 comps, mid ₪7,350  [7.2s]
  · yad2       ok       11 comps, mid ₪6,200  [6.5s]
```

`--json` prints the full report including every comparable. `--help` lists all flags.

## Usage

### An apartment

```ts
const report = await valueAsset({
  city: "Tel Aviv",            // Hebrew or English
  address: "Dizengoff 100",    // street + house number
  type: "apartment",
  areaSqm: 70,
  rooms: 3,
});
```

English addresses are geocoded by GovMap and translated to the canonical Hebrew address
(`report.asset.canonicalAddress`), which is what Madlan and Yad2 need. Hebrew input skips that step.

### A shop or an office

```ts
await valueAsset({ city: "פתח תקווה", address: "רוטשילד 10", type: "retail", areaSqm: 60 });
await valueAsset({ city: "תל אביב - יפו", address: "רוטשילד 22", type: "office", areaSqm: 150 });
```

Commercial assets are valued from commercial transactions only — an office is never priced from
apartments. When there are no commercial rent listings, the rent is derived from the sale band at a
6–8% gross yield, and the report says so.

### Without a browser (serverless, CI, edge)

```ts
await valueAsset(asset, { browser: false });
```

Only GovMap, nadlan.gov.il and CBS run — all plain HTTPS, typically under two seconds. Madlan and
Yad2 are reported as `skipped`.

### One side, some sources

```ts
await valueAsset(asset, { deals: ["rent"], sources: ["yad2", "nadlan-gov"] });
```

## Which sources run

| Asset `type` | Sale | Rent |
| --- | --- | --- |
| `apartment`, `house` | GovMap deals + Madlan deals, blended · nadlan.gov.il median as fallback | Yad2 + Madlan listings, pooled · nadlan.gov.il median as fallback |
| `office`, `retail`, `warehouse`, `industrial`, `commercial` | GovMap deals of the same class, widening to any commercial class only when the exact class is too thin | Yad2 commercial listings · yield-derived from the sale band as fallback |

Madlan's deal data and nadlan.gov.il's medians are residential, so they are never used for commercial assets.

## The report

```ts
interface ValuationReport {
  asset: ResolvedAsset;          // your input + canonicalAddress, location, settlementCode, segment
  sale: DealValuation | null;    // null when not requested
  rent: DealValuation | null;
  warnings: string[];            // fallbacks used, blocked sources, missing inputs
  generatedAt: string;
  durationMs: number;
}

interface DealValuation {
  estimate: (Estimate & { sources: SourceId[] }) | null;   // the blended figure
  sources: SourceResult[];                                 // one entry per source that applies
}

interface Estimate {
  value: { low: number; mid: number; high: number } | null;   // ₪, or ₪/month for rent
  perSqm: { low: number; mid: number; high: number } | null;  // ₪/m², or ₪/m²/month
  count: number;                                              // comps behind the figure
  method: string;                                             // human-readable provenance
}

interface SourceResult {
  source: "govmap" | "nadlan-gov" | "madlan" | "yad2";
  deal: "sale" | "rent";
  status: "ok" | "no-data" | "blocked" | "skipped" | "error";
  reason?: string;
  estimate: Estimate | null;
  comps: Comp[];                 // normalized deals / listings: price, area, rooms, date, address, distance, url
  durationMs: number;
}
```

A source that is **blocked** (bot wall, rate limit, datacenter IP) is reported as `blocked`, never
as an empty market — so an outage cannot quietly turn into "no comparables here".

## Options

| Option | Default | |
| --- | --- | --- |
| `deals` | `["sale", "rent"]` | Value one side only. |
| `sources` | all applicable | Subset of `govmap`, `nadlan-gov`, `madlan`, `yad2`. |
| `browser` | `"auto"` | `"auto"` launches patchright (or playwright) if installed. `false` disables browser sources. Or pass your own `Browser`. |
| `browserLaunch` | — | `{ headless, executablePath, proxy }`. |
| `yad2Relay` | — | `{ url, token }` — read Yad2 through [the relay](relay/cloudflare-yad2) instead of a browser. |
| `monthsBack` | `36` | Primary recency window for deal comps (then 2×, then all history). |
| `sourceTimeoutMs` | `90000` | Per-source timeout. |
| `includeComps` | `true` | Attach the raw comparables to each `SourceResult`. |
| `signal` | — | `AbortSignal` for the whole valuation. |
| `logger` | silent | `{ debug, info, warn }`. |
| `fetch` | global `fetch` | Inject a custom fetch (proxies, tests). |

The building blocks — `saleBand`, `rentEstimate`, `blendEstimates`, `geocode`, `collectDeals`,
`nadlanGovMedian`, `fetchCbsIndex` and friends — are exported too, if you want one source or your
own blend.

## Running on a server

- **GovMap, nadlan.gov.il, CBS** are open APIs and work from anywhere.
- **Madlan** (PerimeterX) challenges every headless browser. By default its browser opens as a real
  window parked off-screen when a display exists (macOS, Windows, Linux with `DISPLAY`). On a
  headless Linux server, run under `xvfb-run`, or expect `blocked`.
- **Yad2** (Radware) accepts headless patchright from residential IPs but blocks most datacenter
  ranges. Options: a residential proxy (`browserLaunch: { proxy }`), or the bundled
  [Cloudflare Worker relay](relay/cloudflare-yad2) (`yad2Relay`), which needs no browser at all.

## How the numbers are made

The short version — the full write-up is in [docs/methodology.md](docs/methodology.md), and each
source's endpoints and quirks are in [docs/sources.md](docs/sources.md).

- **Sale.** Deals are filtered to plausible whole-asset transactions, matched to the asset's class
  (residential / office / retail / warehouse / industrial), restricted to the last 36 months
  (widening to 72, then all history, only when thin), filtered to similar sizes, and restated to
  today's price level with the CBS dwellings price index. The band is the p25 / p50 / p75 of ₪/m²,
  times the area. GovMap and Madlan bands are blended weighted by comp count (capped, so one dense
  source cannot drown the other).
- **Rent.** Asking rents from Yad2 and Madlan are pooled and de-duplicated, kept within 2 km
  (3 km commercial), bucketed by room count the way the market quotes them, and narrowed to
  similar sizes. Commercial rent is priced per m².
- **Fallbacks.** nadlan.gov.il's published medians stopped updating (rent in 2021), so they are
  rolled forward with the matching CBS index and used only when no comparables exist.

## Limitations

- **This is not an appraisal.** It is a comparables screen. A licensed appraiser (שמאי מקרקעין)
  values the specific asset — condition, floor, view, rights, building status — which no comp set captures.
- **Asking rents are not signed rents.** Israel has no public rent registry; listing prices run above
  contracted rents, more so in slow markets.
- **Commercial markets are thin.** Expect wide bands and older deals; check `count` and `method`.
- **The sites change.** Madlan and Yad2 are read from their own pages, which change without notice.
  The parsers are defensive and failures surface as `error` / `blocked` rather than wrong numbers,
  but expect occasional breakage — [report it](https://github.com/mikey641/nadlan-comps/issues/new?template=source-broken.yml).

## Responsible use

This project is not affiliated with or endorsed by GovMap, the Israel Tax Authority, nadlan.gov.il,
Madlan, Yad2 or the CBS. It reads the same data their public websites show to any visitor, one asset
at a time, without logging in and without bypassing paywalls.

It is meant for valuing individual properties — an owner, a buyer, an analyst checking a deal.
Do not use it for bulk harvesting, republishing listings, or anything that loads the sites more
than a person browsing would. Review each site's terms of use for your situation; you are
responsible for how you use it.

## בעברית

`nadlan-comps` מעריך שווי ושכירות של נכס בודד בישראל מתוך עסקאות רשות המסים (GovMap), חציוני
nadlan.gov.il, עסקאות ומודעות מדלן, ומודעות השכרה ביד2 — בקריאה לפונקציה אחת. מזינים כתובת, עיר,
סוג נכס ושטח, ומקבלים טווח שווי (נמוך / חציוני / גבוה) ושכר דירה חודשי, עם פירוט מלא לפי מקור.
נכסים מסחריים (משרדים, חנויות, מחסנים, תעשייה) מוערכים מעסקאות מסחריות בלבד. אין זו שומה.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). If a source stops
returning data, the [source-broken template](https://github.com/mikey641/nadlan-comps/issues/new?template=source-broken.yml)
asks for exactly what is needed to fix it.

## License

[MIT](LICENSE)
