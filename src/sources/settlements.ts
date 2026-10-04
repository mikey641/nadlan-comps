// City name → CBS settlement code (סמל יישוב), the key nadlan.gov.il files are published under.
// Resolved from the official settlements registry on data.gov.il, with a small bundled table of
// the largest cities as an offline fallback.
import { getJson, type HttpContext } from "../util/http.js";
import { placeKey } from "../util/text.js";

const REGISTRY =
  "https://data.gov.il/api/3/action/datastore_search?resource_id=5c78e9fa-c2e2-4771-93ff-7f400a12f7ba&limit=5000";

const BUNDLED: Record<string, string[]> = {
  "5000": ["Tel Aviv", "Tel Aviv-Yafo", "Tel Aviv Jaffa", "תל אביב", "תל אביב - יפו", "תל אביב יפו"],
  "3000": ["Jerusalem", "ירושלים"],
  "4000": ["Haifa", "חיפה"],
  "8600": ["Ramat Gan", "רמת גן"],
  "6300": ["Givatayim", "גבעתיים"],
  "6400": ["Herzliya", "Herzliyya", "הרצליה"],
  "8300": ["Rishon LeZion", "Rishon Lezion", "ראשון לציון"],
  "7900": ["Petah Tikva", "Petah Tiqwa", "Petach Tikva", "פתח תקווה", "פתח תקוה"],
  "7400": ["Netanya", "נתניה"],
  "6200": ["Bat Yam", "בת ים"],
  "6600": ["Holon", "חולון"],
  "6100": ["Bnei Brak", "Bene Beraq", "בני ברק"],
  "8400": ["Rehovot", "רחובות"],
  "70": ["Ashdod", "אשדוד"],
  "9000": ["Beer Sheva", "Beersheba", "Be'er Sheva", "באר שבע"],
  "6900": ["Kfar Saba", "Kefar Sava", "כפר סבא"],
  "8700": ["Raanana", "Ra'anana", "רעננה"],
  "6500": ["Hadera", "חדרה"],
  "7100": ["Ashkelon", "אשקלון"],
  "9100": ["Nahariya", "נהריה"],
  "1200": ["Modiin", "Modi'in", "Modiin-Maccabim-Reut", "מודיעין-מכבים-רעות", "מודיעין"],
  "2640": ["Rosh HaAyin", "Rosh Haayin", "ראש העין"],
  "2610": ["Beit Shemesh", "בית שמש"],
  "9700": ["Hod HaSharon", "Hod Hasharon", "הוד השרון"],
  "8500": ["Ramla", "רמלה"],
  "7000": ["Lod", "לוד"],
  "2660": ["Yavne", "יבנה"],
  "2630": ["Kiryat Gat", "Qiryat Gat", "קרית גת"],
  "2600": ["Eilat", "אילת"],
};

let registry: Promise<Map<string, string>> | null = null;

const bundledIndex = (): Map<string, string> => {
  const m = new Map<string, string>();
  for (const [code, names] of Object.entries(BUNDLED)) for (const n of names) m.set(placeKey(n), code);
  return m;
};

async function loadRegistry(ctx: HttpContext): Promise<Map<string, string>> {
  const m = bundledIndex();
  try {
    const json = await getJson<any>(ctx, "data.gov.il", REGISTRY);
    for (const r of json?.result?.records ?? []) {
      const code = String(r["סמל_ישוב"] ?? "").trim();
      if (!code || code === "0") continue;
      for (const name of [r["שם_ישוב"], r["שם_ישוב_לועזי"]]) {
        const k = placeKey(name);
        if (k && !m.has(k)) m.set(k, code);
      }
    }
  } catch {
    // Offline or blocked: the bundled table still covers the major cities.
  }
  return m;
}

/** Resolve a Hebrew or English city name to its CBS settlement code; null when unknown. */
export async function settlementCode(ctx: HttpContext, city: string | null | undefined): Promise<string | null> {
  const key = placeKey(city);
  if (!key) return null;
  const bundled = bundledIndex().get(key);
  if (bundled) return bundled;
  registry ??= loadRegistry(ctx);
  const m = await registry;
  return m.get(key) ?? null;
}

/** Test hook: forget the cached registry. */
export function resetSettlementCache(): void {
  registry = null;
}
