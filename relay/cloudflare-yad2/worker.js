// Yad2 relay — a Cloudflare Worker that forwards requests to Yad2's JSON gateway.
//
// Yad2's bot wall blocks most datacenter IP ranges. Running nadlan-comps on a server, you can
// route the Yad2 leg through this worker instead of a browser:
//
//   valueAsset(asset, { yad2Relay: { url: "https://yad2-relay.<you>.workers.dev", token: "…" } })
//
// It is deliberately NOT an open proxy: requests need the bearer token, and only yad2.co.il
// gateway URLs are forwarded. Deploy: `wrangler deploy`, then `wrangler secret put RELAY_TOKEN`.
// Whether this is appropriate for your use is your call — read Yad2's terms first.
const ALLOW = /^https:\/\/gw\.yad2\.co\.il\/(realestate-feed|address-autocomplete)\//;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export default {
  async fetch(request, env) {
    if (!env.RELAY_TOKEN) return new Response("RELAY_TOKEN is not configured", { status: 500 });
    if (request.headers.get("authorization") !== `Bearer ${env.RELAY_TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const target = new URL(request.url).searchParams.get("url");
    if (!target || !ALLOW.test(target)) return new Response("target not allowed", { status: 400 });
    const upstream = await fetch(target, {
      headers: { accept: "application/json", "accept-language": "he-IL,he;q=0.9,en;q=0.8", "user-agent": UA },
      redirect: "manual",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  },
};
