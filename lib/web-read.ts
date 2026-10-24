import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";

export interface WebReadOptions {
  url: string;
  selector?: string;
  waitForSelector?: string;
  format?: "markdown" | "text" | "html";
  timeoutSeconds?: number;
  maxChars?: number;
  signal?: AbortSignal;
}

export interface WebReadResult {
  url: string;
  title: string;
  content: string;
  characterCount: number;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_SECONDS = 20;
const MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_CHARS = 35_000;
const IDLE_TIMEOUT_MS = 60_000;

export function findChromiumExecutable(): string | undefined {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const cacheDir = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(cacheDir)) {
    try {
      const entries = fs.readdirSync(cacheDir);
      // Prefer chromium_headless_shell (lightweight, minimal memory footprint)
      const shellDirs = entries.filter((e) => e.startsWith("chromium_headless_shell-")).sort().reverse();
      for (const d of shellDirs) {
        const p = path.join(cacheDir, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
        if (fs.existsSync(p)) return p;
      }
      // Fallback to full chromium binary
      const fullDirs = entries.filter((e) => e.startsWith("chromium-")).sort().reverse();
      for (const d of fullDirs) {
        const p = path.join(cacheDir, d, "chrome-linux64", "chrome");
        if (fs.existsSync(p)) return p;
      }
    } catch {
      // ignore cache read errors
    }
  }

  const systemCandidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
  ];
  for (const c of systemCandidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

export async function getPlaywrightCore(): Promise<any> {
  const require = createRequire(import.meta.url);
  try {
    return require("playwright-core");
  } catch {
    const fallbackPath = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "playwright-core");
    if (fs.existsSync(fallbackPath)) {
      return require(fallbackPath);
    }
  }
  throw new Error("playwright-core could not be resolved. Please install playwright-core.");
}

let sharedBrowserPromise: Promise<any> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    closeSharedBrowser().catch(() => {});
  }, IDLE_TIMEOUT_MS);
  if (idleTimer.unref) idleTimer.unref();
}

export async function closeSharedBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (sharedBrowserPromise) {
    const promise = sharedBrowserPromise;
    sharedBrowserPromise = null;
    try {
      const browser = await promise;
      await browser.close();
    } catch {
      // ignore
    }
  }
}

async function getBrowser(): Promise<any> {
  if (!sharedBrowserPromise) {
    const pw = await getPlaywrightCore();
    const executablePath = findChromiumExecutable();
    const launchOptions: Record<string, unknown> = {
      headless: true,
      args: [
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-extensions",
        "--disable-background-networking",
      ],
    };
    if (executablePath) {
      launchOptions.executablePath = executablePath;
    }
    sharedBrowserPromise = pw.chromium.launch(launchOptions).then((b: any) => {
      b.on("disconnected", () => {
        sharedBrowserPromise = null;
      });
      return b;
    }).catch((err: unknown) => {
      sharedBrowserPromise = null;
      throw err;
    });
  }
  resetIdleTimer();
  return sharedBrowserPromise;
}

/**
 * Cleanly reads and extracts web page content using a lightweight headless browser.
 */
export async function readWebPage(options: WebReadOptions): Promise<WebReadResult> {
  let targetUrl = options.url.trim();
  if (!/^(https?:\/\/|data:|file:\/\/)/i.test(targetUrl)) {
    targetUrl = `https://${targetUrl}`;
  }

  const timeoutSeconds = Math.max(1, Math.min(options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS));
  const timeoutMs = timeoutSeconds * 1000;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const format = options.format ?? "markdown";

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  // Resource blocking: abort images, fonts, audio, video to keep load times fast and memory low
  await context.route("**/*", (route: any) => {
    const req = route.request();
    const type = req.resourceType();
    if (["image", "media", "font", "imageset"].includes(type)) {
      return route.abort().catch(() => {});
    }
    return route.continue().catch(() => {});
  });

  const page = await context.newPage();

  let aborted = false;
  const abortHandler = () => {
    aborted = true;
    page.close().catch(() => {});
  };
  if (options.signal) {
    if (options.signal.aborted) {
      await context.close().catch(() => {});
      throw new Error("Web read operation was aborted.");
    }
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    if (options.waitForSelector) {
      await page.waitForSelector(options.waitForSelector, {
        timeout: Math.min(timeoutMs, 10_000),
      });
    } else {
      // Brief wait for client-side hydration if initial HTML is empty/minimal
      const bodyLen = await page.evaluate(() => document.body?.innerText?.trim()?.length || 0).catch(() => 0);
      if (bodyLen < 30) {
        await page.waitForFunction(
          () => (document.body?.innerText?.trim()?.length || 0) > 30,
          undefined,
          { timeout: 2000 },
        ).catch(() => {});
      }
    }

    const finalUrl = page.url();
    const title = await page.title();

    const extracted = await page.evaluate(({ selector, format }: { selector?: string; format: string }) => {
      const IGNORE_TAGS = new Set([
        "SCRIPT", "STYLE", "NOSCRIPT", "SVG", "IFRAME", "NAV", "FOOTER",
        "DIALOG", "TEMPLATE", "BUTTON"
      ]);

      let root: Element | null = null;
      if (selector) {
        root = document.querySelector(selector);
        if (!root) {
          return { error: `Selector "${selector}" not found on page.` };
        }
      } else {
        root = document.querySelector("main, article, [role='main']") || document.body;
      }

      if (!root) {
        return { error: "No readable body content found on page." };
      }

      if (format === "html") {
        return { content: root.innerHTML };
      }

      if (format === "text") {
        const text = (root as HTMLElement).innerText || "";
        return {
          content: text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
        };
      }

      // DOM to clean markdown walker
      function walk(el: Node): string {
        if (!el) return "";
        if (el.nodeType === Node.TEXT_NODE) {
          return (el.textContent || "").replace(/[ \t\r\n]+/g, " ");
        }
        if (el.nodeType !== Node.ELEMENT_NODE) return "";
        const elem = el as HTMLElement;
        const tag = elem.tagName;

        // Skip ignored tags unless explicitly selected by root
        if (IGNORE_TAGS.has(tag) && elem !== root) return "";

        if (tag === "PRE") {
          return "\n\n```\n" + (elem.textContent || "").trim() + "\n```\n\n";
        }
        if (tag === "CODE") {
          if (elem.closest("pre")) return elem.textContent || "";
          return "`" + (elem.textContent || "").trim() + "`";
        }
        if (tag === "A") {
          const href = (elem as HTMLAnchorElement).href || elem.getAttribute("href") || "";
          const text = Array.from(elem.childNodes).map(walk).join("").trim();
          if (!text) return "";
          return href ? `[${text}](${href})` : text;
        }
        if (tag === "STRONG" || tag === "B") {
          const text = Array.from(elem.childNodes).map(walk).join("").trim();
          return text ? `**${text}**` : "";
        }
        if (tag === "EM" || tag === "I") {
          const text = Array.from(elem.childNodes).map(walk).join("").trim();
          return text ? `*${text}*` : "";
        }
        if (/^H[1-6]$/.test(tag)) {
          const level = parseInt(tag[1], 10);
          const prefix = "#".repeat(level) + " ";
          const text = Array.from(elem.childNodes).map(walk).join("").trim();
          return "\n\n" + prefix + text + "\n\n";
        }
        if (tag === "UL" || tag === "OL") {
          const items = Array.from(elem.children).filter((c) => c.tagName === "LI");
          const isOl = tag === "OL";
          const res = items.map((li, idx) => {
            const prefix = isOl ? `${idx + 1}. ` : "- ";
            const itemText = Array.from(li.childNodes).map(walk).join("").trim();
            return prefix + itemText;
          }).join("\n");
          return "\n\n" + res + "\n\n";
        }
        if (tag === "BLOCKQUOTE") {
          const text = Array.from(elem.childNodes).map(walk).join("").trim();
          return "\n\n" + text.split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
        }
        if (tag === "TABLE") {
          const rows = Array.from(elem.querySelectorAll("tr"));
          if (rows.length === 0) return "";
          const mdRows: string[] = [];
          rows.forEach((tr, rIdx) => {
            const cells = Array.from(tr.querySelectorAll("th, td")).map((c) =>
              Array.from(c.childNodes).map(walk).join("").trim().replace(/\|/g, "\\|")
            );
            mdRows.push(`| ${cells.join(" | ")} |`);
            if (rIdx === 0) {
              const sep = cells.map(() => "---");
              mdRows.push(`| ${sep.join(" | ")} |`);
            }
          });
          return "\n\n" + mdRows.join("\n") + "\n\n";
        }
        if (tag === "BR") return "\n";
        if (tag === "HR") return "\n\n---\n\n";

        const childContent = Array.from(elem.childNodes).map(walk).join("");
        if (["P", "DIV", "SECTION", "ARTICLE", "MAIN"].includes(tag)) {
          return "\n\n" + childContent.trim() + "\n\n";
        }
        return childContent;
      }

      const raw = walk(root);
      return { content: raw.replace(/\n{3,}/g, "\n\n").trim() };
    }, { selector: options.selector, format });

    if (extracted.error) {
      throw new Error(extracted.error);
    }

    let content = extracted.content || "";
    const totalChars = content.length;
    let truncated = false;

    if (totalChars > maxChars) {
      truncated = true;
      content = content.slice(0, maxChars) +
        `\n\n... [Content truncated: showing ${maxChars} of ${totalChars} characters. Use a CSS selector (e.g. selector: "article" or selector: "#content") to focus on a specific section.]`;
    }

    return {
      url: finalUrl,
      title: title || "",
      content,
      characterCount: totalChars,
      truncated,
    };
  } catch (err: unknown) {
    if (aborted) {
      throw new Error("Web read operation was cancelled.");
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read web page "${targetUrl}": ${message}`);
  } finally {
    if (options.signal) {
      options.signal.removeEventListener("abort", abortHandler);
    }
    await context.close().catch(() => {});
    resetIdleTimer();
  }
}
