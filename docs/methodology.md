# Methodology

How `valueAsset` turns raw deals and listings into a valuation. Every rule here exists because the
naive version produced a wrong number on real data.

## 1. Locate the asset

The address is geocoded with GovMap's public autocomplete (Hebrew first for Hebrew input; English
then Hebrew otherwise). GovMap answers in Web-Mercator (EPSG:3857); the point is converted to WGS84
for distance calculations.

The building polygon at that point carries the Hebrew street and city names. That canonical Hebrew
address is what Madlan and Yad2 search with, so English input works for every source.

## 2. Sale comparables

### Sources

- **GovMap** — Israel Tax Authority transactions. The search starts at the building (50 m) and
  widens in stages — 300 m for residential; 600 m and 1.5 km for commercial, because shops and
  offices trade sparsely and a new tower has no history of its own. Widening stops as soon as there
  are enough recent same-class deals. The polygon budget is per stage and counts only polygons not
  already read, so the dense near rings cannot starve the wide ring where commercial comps live.
- **Madlan** — closed deals for the building and its surroundings (residential only).

### Filters

1. **Plausibility.** The registry contains rows such as ₪370,000 for 1 m² (parking spaces, sub-parcel
   artifacts). A deal counts only with price ≥ ₪100,000, area ≥ 8 m², and ₪2,000 ≤ ₪/m² ≤ ₪200,000.
2. **Class.** Every deal is classified from its Hebrew nature (`דירה בבית קומות`, `משרדים`, `חנויות`,
   `מחסנים`, …) into residential / office / retail / warehouse / industrial / hotel / land / parking.
   An office is valued from offices; only if fewer than the minimum exist in *every* recency window
   does the pool widen to any commercial class — five-year-old office deals beat fresh warehouse deals.
   Deals without a nature count as residential (the registry omits it mostly on dwellings).
3. **Recency.** 36 months, then 72, then all history — the first window with enough deals wins.
   The method string records which.
4. **Size.** When the area is known and enough deals remain, deals more than 6× larger or smaller are
   dropped: a 1,200 m² anchor store is not a comparable for a 60 m² shop.

Minimums: 5 deals residential, 4 commercial.

### Time adjustment

Each deal's ₪/m² is multiplied by `index(latest) / index(deal month)` using the CBS dwellings price
index (series 40010), chained across CBS rebasings into one continuous series. Without this, a thin
market that falls back to old deals would compare 2012 shekels with today's. For commercial classes
the dwellings index is a proxy — Israel publishes no commercial property price index.

### Band and blend

The band is the p25 / p50 / p75 of adjusted ₪/m², multiplied by the asset's area. GovMap and Madlan
bands are averaged weighted by deal count, each weight capped at 30, so a source with hundreds of
area deals cannot drown the building-level registry.

### Fallback

When neither source yields a band for a residential asset, the nadlan.gov.il published sale median
(city or neighborhood, by room count) is rolled forward from its as-of month with the same CBS
index. It is reported as a fallback, with a warning.

## 3. Rent comparables

Israel has no rent registry — leases are not reported to the Tax Authority — so rent comes from
asking rents on Yad2 and Madlan.

1. **Pool and de-duplicate.** The same flat is often listed on both boards; listings with the same
   price, area, rooms, street, house number and floor are kept once.
2. **Plausibility.** ₪500 ≤ rent ≤ ₪500,000 per month, and ₪15 ≤ ₪/m² ≤ ₪600. Boards carry ₪1
   placeholders and per-m² prices typed into the total field.
3. **Distance.** Within 2 km (3 km commercial), when enough listings remain.
4. **Residential.** Listings without rooms or area are dropped. The asset's room bucket (1–2, 3, 4,
   5+) is used — widened to all sizes when the bucket has fewer than 5 — and narrowed to listings
   within 1.5× of the area when enough remain. The band is p25 / p50 / p75 of the monthly rent.
5. **Commercial.** Listings of the asset's own class are preferred when there are at least 5. The
   band is the p25 / p50 / p75 of ₪/m²/month, within 4× of the area, times the area.

### Fallbacks

- Residential: the nadlan.gov.il published rent median for the room bucket nearest the asset, rolled
  forward with the CBS dwelling-rent index (series 120460). The published series stopped in 2021.
- Commercial: the income approach — the GovMap sale band × 6% / 7% / 8% gross yield ÷ 12, × area.

## 4. Honesty rules

- A blocked source is `blocked`, not `no-data`. An outage must never read as an empty market.
- Every estimate carries `count` and a `method` string naming its comps, window and adjustments.
- Fallbacks are labelled `fallback —` and add a warning.
- Without an area, whole-property values are `null` rather than guessed.
