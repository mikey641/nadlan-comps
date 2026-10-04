import { SourceBlockedError } from "../errors.js";

export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Statuses that mean "this client is not being served", not "this id is bad". */
const BLOCKING_STATUS = new Set([401, 403, 407, 408, 429, 451, 502, 503, 504]);

export interface HttpContext {
  fetch: typeof fetch;
  signal?: AbortSignal;
  timeoutMs: number;
}

/**
 * Fetch JSON, classifying failures: transport errors, blocking statuses and HTML challenge pages
 * throw {@link SourceBlockedError}; other non-2xx statuses throw a plain Error.
 */
export async function getJson<T = any>(
  ctx: HttpContext,
  label: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const signals = [AbortSignal.timeout(ctx.timeoutMs)];
  if (ctx.signal) signals.push(ctx.signal);
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      ...init,
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    throw new SourceBlockedError(`${label} unreachable: ${(e as Error)?.message ?? "fetch failed"}`);
  }
  const path = safePath(url);
  if (!res.ok) {
    if (BLOCKING_STATUS.has(res.status)) {
      throw new SourceBlockedError(`${label} ${path} ${res.status} (blocked or unavailable)`, res.status);
    }
    throw new Error(`${label} ${path} ${res.status}`);
  }
  const text = (await res.text()).replace(/^﻿/, "");
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 200 carrying an HTML interstitial is a block wearing a success code.
    throw new SourceBlockedError(`${label} ${path} returned non-JSON`, res.status);
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
