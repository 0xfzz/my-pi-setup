import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "ascii_anim_engine.wasm");

export type WasmSceneName = "aquarium" | "matrix" | "fire";

export const SCENE_IDS: Record<WasmSceneName, number> = {
  aquarium: 0,
  matrix: 1,
  fire: 2,
};

export interface AsciiAnimWasmInstance {
  memory: WebAssembly.Memory;
  get_buffer_ptr(): number;
  render_scene(sceneId: number, cols: number, rows: number, seconds: number, useAnsi: number): number;
  render_aquarium(cols: number, rows: number, seconds: number, useAnsi: number): number;
  render_matrix(cols: number, rows: number, seconds: number, useAnsi: number): number;
  render_fire(cols: number, rows: number, seconds: number, useAnsi: number): number;
  render_frame(cols: number, rows: number, seconds: number, useAnsi: number): number;
}

let wasmEngine: AsciiAnimWasmInstance | null | undefined;
const textDecoder = new TextDecoder();

export function getAsciiAnimEngine(): AsciiAnimWasmInstance | null {
  if (wasmEngine !== undefined) {
    return wasmEngine;
  }

  try {
    if (!existsSync(WASM_PATH)) {
      wasmEngine = null;
      return null;
    }
    const bytes = readFileSync(WASM_PATH);
    const mod = new WebAssembly.Module(bytes);
    const inst = new WebAssembly.Instance(mod, {});
    wasmEngine = inst.exports as unknown as AsciiAnimWasmInstance;
    return wasmEngine;
  } catch {
    wasmEngine = null;
    return null;
  }
}

export function renderWasmScene(
  scene: WasmSceneName | number,
  cols: number,
  rows: number,
  seconds: number,
  useAnsi = false
): string[] | null {
  const engine = getAsciiAnimEngine();
  if (!engine) return null;

  const sceneId = typeof scene === "number" ? scene : (SCENE_IDS[scene] ?? 0);
  const len = engine.render_scene(sceneId, cols, rows, seconds, useAnsi ? 1 : 0);
  const ptr = engine.get_buffer_ptr();
  const mem = new Uint8Array(engine.memory.buffer, ptr, len);
  return textDecoder.decode(mem).split("\n");
}
