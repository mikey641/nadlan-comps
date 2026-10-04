/**
 * The source answered, but not with data: a bot wall, a datacenter-IP block, a rate limit,
 * or no answer at all. Never the same fact as "there are no comps here" — callers report it
 * as `status: "blocked"` so an outage is not mistaken for an empty market.
 */
export class SourceBlockedError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "SourceBlockedError";
    this.status = status;
  }
}

/** A source needs something the caller did not provide (a browser, a relay, an address…). */
export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

export const isBlocked = (e: unknown): e is SourceBlockedError =>
  e instanceof SourceBlockedError || (e as { name?: string } | null)?.name === "SourceBlockedError";
