# Data sources

What each source is, how it is read, and what tends to break. Last verified October 2026.

## GovMap — Israel Tax Authority transactions

The national mapping portal serves the Tax Authority's real-estate transaction registry as JSON.
nadlan.gov.il displays the same deals but gates its per-deal API behind reCAPTCHA; GovMap does not.

| Endpoint | Purpose |
| --- | --- |
| `POST https://www.govmap.gov.il/api/search-service/autocomplete` | Address → point (EPSG:3857). Body: `{ searchText, language: "he" \| "en", isAccurate: false, maxResults }` |
| `GET /api/real-estate/deals/{x},{y}/{radiusM}` | Building polygons within a radius, with Hebrew street / number / city |
| `GET /api/real-estate/street-deals/{polygonId}` | Transactions for the building / street segment |
| `GET /api/real-estate/neighborhood-deals/{polygonId}` | Transactions across the polygon's neighborhood |

Notes:

- The deal endpoints must be called **without query parameters** — extra parameters return 500.
- Deal rows carry `settlementId` (the CBS settlement code), used to find the nadlan.gov.il file.
- Some cloud IP ranges get 403s from GovMap's CDN. Those surface as `blocked`.

## nadlan.gov.il — published medians

Static JSON on `https://data.nadlan.gov.il/api/pages/`:

- `settlement/{buy|rent}/{settlementCode}.json`
- `neighborhood/{buy|rent}/{neighborhoodId}.json`

Each file has `trends.rooms[]` — one series per room count (`3`, `4`, `5`, `all`) of whole-property
medians. The settlement file lists its neighborhoods (`otherNeighborhoods`), which is how a
neighborhood name is matched to an id. Files start with a UTF-8 BOM.

City names are resolved to settlement codes via the CBS settlements registry on data.gov.il
(`datastore_search`, resource `5c78e9fa-c2e2-4771-93ff-7f400a12f7ba`), with a bundled table of
major cities as an offline fallback.

## CBS — price indices

`https://api.cbs.gov.il/index/data/price?id={series}&format=json&last={months}`

- `40010` — dwellings price index (מדד מחירי דירות)
- `120460` — dwelling-rent price index (מדד מחירי שכר דירה)

CBS periodically rebases an index ("2024 average = 100"). The package chains the segments into one
continuous series so any two months compare with a plain ratio.

## Madlan

Behind PerimeterX. Read with a real browser, without scripting the page:

- **Sale.** `https://www.madlan.co.il/address/{docId}` where `docId` is
  `{street}-{number}-{city}-ישראל` with spaces as hyphens. The page calls its GraphQL endpoint
  (`/api2`) with operation `docId2Insights`; the response's `prices` insight holds closed deals at
  `building` and `area` scope.
- **Rent.** `https://www.madlan.co.il/for-rent/{docId}?marketplace=residential`. The first page is
  server-rendered into `window.__SSR_HYDRATED_CONTEXT__` (`…searchList.data.searchPoiV2.poi`); the
  context is a JS literal that is JSON apart from bare `undefined`, so it is parsed, not evaluated.
  Later pages arrive as `searchPoi*` GraphQL responses — sometimes as lean map markers, so records
  are merged field by field.

PerimeterX challenges every headless browser tested, so Madlan's browser runs headed (off-screen)
when a display is available.

## Yad2

Behind Radware Bot Manager. Two transports:

- **Browser.** Open `https://www.yad2.co.il/realestate/rent`, then call the site's own autocomplete
  (`https://gw.yad2.co.il/address-autocomplete/realestate/v2?text=…`) as an in-page `fetch`, which is
  what the search box does. It returns `cityId`, `areaId`, `regionId` and `streetId`. The list search
  — `/realestate/rent?city=…&area=…&region=…&street=…`, or for commercial
  `/realestate/commercial/{region-slug}?dealType=1&city=…` — is server-rendered into `__NEXT_DATA__`
  (`props.pageProps.feed`, grouped as `private`, `agency`, `platinum`, …). The street is tried first,
  then the whole city when the street is thin.
- **Relay.** The same gateway's map feed, `https://gw.yad2.co.il/realestate-feed/{rent|commercial}/map?…`,
  fetched through a small authenticated Cloudflare Worker ([relay/cloudflare-yad2](../relay/cloudflare-yad2)).

Notes:

- The autocomplete wants canonical city names: "תל אביב - יפו" fails, "תל אביב יפו" works. Several
  variants are tried.
- Radware's challenge script can reload the page mid-read; reads are retried once the page settles.
- Items with a price under ₪100 are "price on request" placeholders and are skipped.
