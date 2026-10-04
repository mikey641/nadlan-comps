# Yad2 relay (Cloudflare Worker)

Yad2's bot protection blocks most datacenter IP ranges, so on a server the Yad2 leg can fail with
`blocked`. This worker forwards nadlan-comps' Yad2 gateway requests from Cloudflare's network, so no
browser is needed.

```sh
cd relay/cloudflare-yad2
npx wrangler deploy
npx wrangler secret put RELAY_TOKEN     # any long random string
```

```ts
await valueAsset(asset, {
  yad2Relay: { url: "https://yad2-relay.<your-subdomain>.workers.dev", token: process.env.YAD2_RELAY_TOKEN },
});
```

The worker refuses to run without `RELAY_TOKEN`, requires it as a bearer token on every request, and
only forwards `gw.yad2.co.il` listing-feed and autocomplete URLs — it is not an open proxy. Keep the
token secret. Whether relaying is appropriate for your use is your decision; read Yad2's terms.
