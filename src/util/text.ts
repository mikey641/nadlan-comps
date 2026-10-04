/** Collapse whitespace. */
export const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

/** Loose key for matching place names across sources ("תל אביב - יפו" ≈ "תל אביב יפו"). */
export const placeKey = (s: string | null | undefined): string =>
  clean(s)
    .toLowerCase()
    .replace(/קריית/g, "קרית")
    .replace(/["'`׳״.\-–,()\s]/g, "");

export const hasHebrew = (s: string | null | undefined): boolean => /[֐-׿]/.test(s ?? "");

/**
 * Split "רוטשילד 10" / "Rothschild 10, apt 3" into street + house number. Floor / apartment /
 * entrance suffixes are dropped — they garble every autocomplete downstream.
 */
export function splitAddress(address: string | null | undefined): { street: string; houseNumber: string | null } {
  const a = clean(
    (address ?? "").replace(/[,\s]*(קומה|דירה|כניסה|apt\.?|apartment|floor|entrance)\s*[\dא-תa-zA-Z'"׳-]*/gi, ""),
  ).replace(/[,\s]+$/, "");
  const m = a.match(/^(.*?)[\s,]*(\d+[א-תa-zA-Z]?)\s*$/);
  return m ? { street: clean(m[1]), houseNumber: m[2]! } : { street: a, houseNumber: null };
}
