// Browser acquisition for the bot-protected sources (Madlan: PerimeterX, Yad2: Radware).
//
// patchright — a Playwright fork with the CDP `Runtime.enable` leak patched — is preferred because
// both walls fingerprint stock automation. Plain playwright is accepted as a fallback. Neither is a
// hard dependency: without one, the browser-only sources report `skipped` with a clear reason.
import { SourceUnavailableError } from "./errors.js";
import type { BrowserContextLike, BrowserLike, ValueAssetOptions } from "./types.js";

export const CONTEXT_OPTIONS = {
  locale: "he-IL",
  timezoneId: "Asia/Jerusalem",
  viewport: { width: 1440, height: 1000 },
};

/**
 * Context options for a launched browser. Headless Chrome announces itself as "HeadlessChrome" in
 * its User-Agent, which both walls reject, so headless sessions get the matching headed UA. The
 * version must be the real one: a UA that disagrees with the Sec-CH-UA client hints is itself a
 * bot signal. Headed sessions keep their genuine UA untouched.
 */
export function contextOptionsFor(browser: { version?: () => string }, headless: boolean): Record<string, unknown> {
  if (!headless) return CONTEXT_OPTIONS;
  const major = String(browser.version?.() ?? "").split(".")[0] || "131";
  const os =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : process.platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return {
    ...CONTEXT_OPTIONS,
    userAgent: `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  };
}

/** A browser context the sources can open pages in; `release` closes whatever the session owns. */
export interface BrowserSession {
  context: BrowserContextLike;
  release(): Promise<void>;
}

type Launcher = { launch(opts: Record<string, unknown>): Promise<BrowserLike> };

async function loadLauncher(): Promise<{ name: string; chromium: Launcher } | null> {
  for (const name of ["patchright", "playwright"]) {
    try {
      const mod: any = await import(/* @vite-ignore */ name);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return { name, chromium };
    } catch {
      // not installed — try the next one
    }
  }
  return null;
}

/** True when a headed window can be opened (desktop OS, or an X/Wayland display on Linux). */
const canShowWindow = (): boolean =>
  process.platform === "darwin" ||
  process.platform === "win32" ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/**
 * Open a browser context for one source.
 *
 * `prefersHeaded` marks a source whose wall challenges every headless browser (Madlan). When the
 * caller did not choose `headless` explicitly and a display exists, that source gets a headed
 * window parked off-screen; otherwise it runs headless and may come back `blocked`.
 */
export async function openSession(
  opts: Pick<ValueAssetOptions, "browser" | "browserLaunch">,
  prefersHeaded = false,
): Promise<BrowserSession> {
  const choice = opts.browser ?? "auto";
  if (choice === false) throw new SourceUnavailableError("browser disabled (options.browser = false)");

  if (typeof choice === "object") {
    const context = await choice.newContext(CONTEXT_OPTIONS);
    return { context, release: () => context.close().catch(() => undefined) };
  }

  const launcher = await loadLauncher();
  if (!launcher) {
    throw new SourceUnavailableError("needs a browser — `npm install patchright` (recommended) or `playwright`");
  }
  const launch = opts.browserLaunch ?? {};
  const headless = launch.headless ?? !(prefersHeaded && canShowWindow());
  const base: Record<string, unknown> = {
    headless,
    args: headless ? [] : ["--window-position=-2400,-2400", "--window-size=1440,1000"],
    ...(launch.proxy ? { proxy: proxyOption(launch.proxy) } : {}),
  };

  // Prefer the installed Google Chrome (no browser download, and a real Chrome build is less
  // conspicuous to bot walls), then the launcher's bundled Chromium.
  const attempts: Record<string, unknown>[] = launch.executablePath
    ? [{ ...base, executablePath: launch.executablePath }]
    : [{ ...base, channel: "chrome" }, base];
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const browser = await launcher.chromium.launch(attempt);
      const context = await browser.newContext(contextOptionsFor(browser as { version?: () => string }, headless));
      return {
        context,
        release: async () => {
          await context.close().catch(() => undefined);
          await browser.close().catch(() => undefined);
        },
      };
    } catch (e) {
      lastError = e;
    }
  }
  throw new SourceUnavailableError(
    `could not launch ${launcher.name}: ${String((lastError as Error)?.message ?? lastError).split("\n")[0]} ` +
      `(install Google Chrome, or run \`npx ${launcher.name} install chromium\`)`,
  );
}

function proxyOption(proxy: string): { server: string; username?: string; password?: string } {
  try {
    const u = new URL(proxy);
    return {
      server: `${u.protocol}//${u.host}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return { server: proxy };
  }
}
