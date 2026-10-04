# Contributing

Thanks for helping. The most valuable contributions are usually small: a source changed its page
and a parser needs a tweak, a Hebrew property-type label is misclassified, a city does not resolve.

## Setup

```sh
git clone https://github.com/mikey641/nadlan-comps.git
cd nadlan-comps
npm install
npm test            # offline unit tests — no network
npm run typecheck
npm run build
```

Run the CLI from source after a build:

```sh
node dist/cli.js --city "רמת גן" --address "ביאליק 30" --type apartment --area 85 -v
```

## Live tests

`npm run test:live` hits the real government APIs (no browser). `NADLAN_COMPS_LIVE=browser npm run
test:live` also exercises Madlan and Yad2 and needs `patchright` plus Chrome. Live tests never run
in CI — upstream sites change and rate-limit, and CI must stay deterministic.

## When a source breaks

1. Reproduce with `-v --json` and note the `status` and `reason`.
2. Find where the payload changed — `docs/sources.md` lists the endpoints and the fields read.
3. Fix the parser defensively (tolerate both shapes when you can) and add a unit test with a small,
   **synthetic** fixture of the new shape. Do not commit real listings, phone numbers, or large
   captured payloads.

## Guidelines

- TypeScript strict mode; no new runtime dependencies without discussion.
- Every rule that filters or adjusts data should say *why* in a comment — usually the real-data case
  that made it necessary.
- Never report a blocked source as an empty market.
- Keep the request volume of any change at "one person browsing" levels.
- Add a line to `CHANGELOG.md` under an `Unreleased` heading.
