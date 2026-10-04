# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-10-04

### Added

- `valueAsset()` — sale and rent valuation of one Israeli property from GovMap (Tax Authority
  transactions), nadlan.gov.il published medians, Madlan and Yad2, routed by asset type.
- Class-aware sale bands (residential / office / retail / warehouse / industrial) with plausibility,
  recency, size and CBS time adjustment.
- Room-bucketed residential rent and per-m² commercial rent from pooled, de-duplicated asking rents.
- Fallbacks: CBS-indexed nadlan.gov.il medians (residential), yield-derived rent (commercial).
- `blocked` / `skipped` / `no-data` / `error` per-source statuses.
- English address support via GovMap geocoding.
- `nadlan-comps` CLI with human and JSON output.
- Optional Cloudflare Worker relay for Yad2.

[0.1.0]: https://github.com/mikey641/nadlan-comps/releases/tag/v0.1.0
