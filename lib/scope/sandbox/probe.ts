import { execFile } from "node:child_process";
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

  const binary = findLandlockBinary();
  if (!binary) {
    return {
      ok: false,
      backend: "landlock",
      detail: "Landlock helper binary not installed",
    };
  }

  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 3000 });
    const match = /ABI\s+(\d+|\w+)/i.exec(stdout);
    const abiNum = match ? parseInt(match[1]!, 10) : undefined;
    return {
      ok: true,
      backend: "landlock",
      abi: Number.isFinite(abiNum) ? abiNum : undefined,
      detail: `Landlock functional (${stdout.trim()})`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      backend: "landlock",
      detail: `Landlock helper probe failed: ${msg}`,
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
