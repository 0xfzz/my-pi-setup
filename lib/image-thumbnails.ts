/**
 * image-thumbnails.ts — display-only thumbnails for terminal images.
 *
 * Every inline image in Pi (a pasted attachment preview, a tool-result image) is a
 * pi-tui `Image` that re-sends its full base64 payload to the terminal on each
 * render. A multi-megabyte screenshot makes scrolling and typing lag.
 *
 * The fix is on the display side only: each `Image` instance swaps its OWN copy of
 * the data for a small thumbnail the first time it renders. The caller's data is
 * never touched, so the attachment that is sent to the model, the file on disk and
 * the tool result content stay exactly as they were.
 */
import { createHash } from "node:crypto";

export interface ThumbnailConfig {
  enabled: boolean;
  /** Longest side of the thumbnail in pixels. */
  maxDimension: number;
  /** JPEG quality, 1-100. */
  jpegQuality: number;
  /** Target size ceiling for the encoded thumbnail. */
  maxBytes: number;
}

export const DEFAULT_THUMBNAIL_CONFIG: ThumbnailConfig = {
  enabled: true, maxDimension: 640, jpegQuality: 60, maxBytes: 200_000,
};

/** Images whose base64 is already this small are shown as they are: nothing to gain. */
export const SMALL_IMAGE_BASE64_CHARS = 120_000;

export function validateThumbnailConfig(value: unknown): ThumbnailConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  const config = { ...DEFAULT_THUMBNAIL_CONFIG };
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_THUMBNAIL_CONFIG, key)) throw new Error(`Unknown image thumbnail setting: ${key}`);
    if (key === "enabled") {
      if (typeof raw !== "boolean") throw new Error("enabled must be true or false");
      config.enabled = raw;
    } else {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) throw new Error(`${key} must be a positive number`);
      (config as Record<string, number | boolean>)[key] = raw;
    }
  }
  if (config.jpegQuality > 100) throw new Error("jpegQuality must be at most 100");
  if (config.maxDimension < 16) throw new Error("maxDimension must be at least 16");
  return config;
}

export interface Thumbnail { data: string; mimeType: string }

export interface ThumbnailerDeps {
  /** Downscale encoded image bytes; null when the image cannot be decoded. */
  resize(bytes: Uint8Array, mimeType: string, options: {
    maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number;
  }): Promise<Thumbnail | null>;
  /** Convert to PNG; only called when the terminal cannot show the thumbnail's format. */
  toPng?(thumbnail: Thumbnail): Promise<Thumbnail | null>;
  /** True when the terminal needs PNG (Kitty protocol). */
  needsPng(): boolean;
}

const CACHE_LIMIT = 48;

export interface Thumbnailer {
  /** The thumbnail if it is already computed, without doing any work. */
  peek(data: string): Thumbnail | null | undefined;
  /** Compute (or fetch) the thumbnail; null means "show the original". */
  get(data: string, mimeType: string): Promise<Thumbnail | null>;
}

export function createThumbnailer(deps: ThumbnailerDeps, getConfig: () => ThumbnailConfig): Thumbnailer {
  // Keyed by a digest, not the payload: the payload can be megabytes. Least recently used first.
  const cache = new Map<string, Thumbnail | null>();
  const inflight = new Map<string, Promise<Thumbnail | null>>();
  const keyOf = (data: string) => createHash("sha1").update(data).digest("hex");
  const remember = (key: string, value: Thumbnail | null) => {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  };
  return {
    peek(data) {
      const key = keyOf(data);
      if (!cache.has(key)) return undefined;
      const value = cache.get(key)!;
      remember(key, value);
      return value;
    },
    get(data, mimeType) {
      const key = keyOf(data);
      if (cache.has(key)) return Promise.resolve(cache.get(key)!);
      const pending = inflight.get(key);
      if (pending) return pending;
      const config = getConfig();
      const work = (async () => {
        try {
          let thumb = await deps.resize(Buffer.from(data, "base64"), mimeType, {
            maxWidth: config.maxDimension, maxHeight: config.maxDimension,
            maxBytes: config.maxBytes, jpegQuality: config.jpegQuality,
          });
          if (thumb && thumb.mimeType !== "image/png" && deps.needsPng() && deps.toPng) thumb = await deps.toPng(thumb);
          // A "thumbnail" that is not smaller is not worth swapping in.
          return thumb && thumb.data.length < data.length ? thumb : null;
        } catch {
          return null;
        }
      })().then((value) => { remember(key, value); inflight.delete(key); return value; });
      inflight.set(key, work);
      return work;
    },
  };
}

/** The slice of pi-tui's `Image` this module relies on. */
export interface PatchableImage {
  base64Data: string;
  mimeType: string;
  pngData?: string;
  theme?: { fallbackColor?: (text: string) => string };
  invalidate(): void;
  render(width: number): string[];
}

type ImageState = "pending" | "done" | "skip";
const STATE = Symbol.for("pi-workflow-extensions.image-thumbnail-state");
const PATCHED = Symbol.for("pi-workflow-extensions.image-thumbnail-patch");

export interface PatchOptions {
  thumbnailer: Thumbnailer;
  getConfig: () => ThumbnailConfig;
  /** True when the terminal can draw inline images at all. */
  canDrawImages: () => boolean;
  /** Called when a thumbnail lands, so the host can repaint. */
  onReady: () => void;
}

/**
 * Patch `Image.prototype.render` so instances display a thumbnail.
 *
 * Returns a function that restores the original. Patching twice is a no-op: a
 * reload must not stack wrappers.
 */
export function patchImageRender(
  prototype: { render(width: number): string[] },
  options: PatchOptions,
): () => void {
  const target = prototype as typeof prototype & { [PATCHED]?: () => void };
  if (target[PATCHED]) target[PATCHED]!();
  const original = target.render;
  target.render = function render(this: PatchableImage, width: number): string[] {
    const self = this as PatchableImage & { [STATE]?: ImageState };
    if (!options.getConfig().enabled || !options.canDrawImages() || self[STATE] === "done" || self[STATE] === "skip") {
      return original.call(this, width);
    }
    if (self[STATE] === undefined) {
      if (self.base64Data.length <= SMALL_IMAGE_BASE64_CHARS) {
        self[STATE] = "skip";
        return original.call(this, width);
      }
      const cached = options.thumbnailer.peek(self.base64Data);
      if (cached !== undefined) {
        // Already computed for this image: no placeholder frame.
        if (cached) { self.base64Data = cached.data; self.mimeType = cached.mimeType; self.pngData = undefined; }
        self[STATE] = "done";
        self.invalidate();
        return original.call(this, width);
      }
      self[STATE] = "pending";
      const source = self.base64Data;
      void options.thumbnailer.get(source, self.mimeType).then((thumb) => {
        if (thumb && self.base64Data === source) {
          self.base64Data = thumb.data;
          self.mimeType = thumb.mimeType;
          self.pngData = undefined;
        }
        self[STATE] = "done";
        self.invalidate();
        options.onReady();
      });
    }
    // Pending: a one-line placeholder instead of sending the full-size payload.
    const text = "[image · preparing preview…]";
    return [self.theme?.fallbackColor ? self.theme.fallbackColor(text) : text];
  };
  const restore = () => {
    target.render = original;
    delete target[PATCHED];
  };
  target[PATCHED] = restore;
  return restore;
}
