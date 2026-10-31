import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SandboxBackendId } from "./config.ts";
import { findLandlockBinary } from "./landlock.ts";

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  ok: boolean;
  backend: SandboxBackendId;
  detail: string;
  abi?: number;
}

const probeCache = new Map<SandboxBackendId, ProbeResult>();

/** Clear the probe cache, mainly for tests. */
export function clearProbeCache(): void {
  probeCache.clear();
}

/** Test-only: pin a probe outcome so tests can drive degradation and
 *  availability without spawning real backends. */
export function primeProbeCacheForTest(backend: SandboxBackendId, result: ProbeResult): void {
  probeCache.set(backend, result);
}

/**
 * Probe a specific backend or auto-detect the best available one.
 * Order for "auto": landlock -> bwrap -> seatbelt -> none.
 */
export async function probeBackend(backend: SandboxBackendId = "auto"): Promise<ProbeResult> {
  const cached = probeCache.get(backend);
  if (cached) return cached;

  let result: ProbeResult;
  switch (backend) {
    case "none":
      result = { ok: true, backend: "none", detail: "sandbox disabled (none)" };
      break;

    case "bwrap":
      result = await probeBwrap();
      break;

    case "seatbelt":
      result = await probeSeatbelt();
      break;

    case "landlock":
      result = await probeLandlock();
      break;

    case "auto":
      result = await probeAuto();
      break;

    default:
      result = { ok: false, backend, detail: `unknown backend: ${String(backend)}` };
      break;
  }

  probeCache.set(backend, result);
  return result;
}

async function probeBwrap(): Promise<ProbeResult> {
  if (process.platform !== "linux") {
    return {
      ok: false,
      backend: "bwrap",
      detail: "bubblewrap (bwrap) is only supported on Linux",
    };
  }

  try {
    await execFileAsync("bwrap", ["--ro-bind", "/", "/", "true"], { timeout: 3000 });
    return {
      ok: true,
      backend: "bwrap",
      detail: "bubblewrap (bwrap) available and functional",
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      backend: "bwrap",
      detail: `bwrap probe failed: ${msg}`,
    };
  }
}

async function probeSeatbelt(): Promise<ProbeResult> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      backend: "seatbelt",
      detail: "seatbelt (sandbox-exec) is only supported on macOS",
    };
  }

  try {
    await execFileAsync("sandbox-exec", ["-p", "(version 1)(allow default)", "true"], { timeout: 3000 });
    return {
      ok: true,
      backend: "seatbelt",
      detail: "sandbox-exec available and functional",
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      backend: "seatbelt",
      detail: `sandbox-exec probe failed: ${msg}`,
    };
  }
}

async function probeLandlock(): Promise<ProbeResult> {
  if (process.platform !== "linux") {
    return {
      ok: false,
      backend: "landlock",
      detail: "Landlock is only supported on Linux",
    };
  }

  try {
    const { stdout } = await execFileAsync(findLandlockBinary(), ["--version"], { timeout: 3000 });
    const match = /ABI\s+(\d+)/.exec(stdout);
    const abiNum = match ? Number.parseInt(match[1]!, 10) : undefined;

    // A version banner proves nothing: the smoke run writes inside an
    // rw-listed dir and asserts a non-listed dir stays refused. If the kernel
    // cannot enforce, either step fails and the backend degrades to `off`.
    const inside = mkdtempSync(join(tmpdir(), "pi-scope-landlock-a-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-scope-landlock-b-"));
    try {
      await execFileAsync(
        findLandlockBinary(),
        ["--rw", inside, "--", "/bin/sh", "-c", `touch '${inside}/ok' && ! test -e '${outside}/ok'`],
        { timeout: 3000 },
      );
    } finally {
      rmSync(inside, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }

    return {
      ok: true,
      backend: "landlock",
      abi: Number.isFinite(abiNum) ? abiNum : undefined,
      detail: `Landlock smoke run passed${Number.isFinite(abiNum) ? ` (ABI ${abiNum})` : ""}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      backend: "landlock",
      detail: `Landlock probe failed: ${msg}`,
    };
  }
}

async function probeAuto(): Promise<ProbeResult> {
  const landlock = await probeLandlock();
  if (landlock.ok) {
    return { ...landlock, backend: "landlock" };
  }

  const bwrap = await probeBwrap();
  if (bwrap.ok) {
    return { ...bwrap, backend: "bwrap" };
  }

  const seatbelt = await probeSeatbelt();
  if (seatbelt.ok) {
    return { ...seatbelt, backend: "seatbelt" };
  }

  return {
    ok: false,
    backend: "none",
    detail: "no sandbox backend available on this platform",
  };
}
