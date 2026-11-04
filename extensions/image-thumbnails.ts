import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convertToPng, getAgentDir, resizeImage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Image } from "@earendil-works/pi-tui";
import {
  createThumbnailer, DEFAULT_THUMBNAIL_CONFIG, patchImageRender, validateThumbnailConfig, type ThumbnailConfig,
} from "../lib/image-thumbnails.ts";

/**
 * Display-only image thumbnails. See lib/image-thumbnails.ts: the images Pi draws
 * inline (pasted attachment previews, tool-result images) are shown downscaled so
 * the terminal is not sent megabytes on every render. Originals are never changed.
 */
export default function imageThumbnails(pi: ExtensionAPI) {
  const path = join(getAgentDir(), "image-thumbnails.json");
  let config: ThumbnailConfig = { ...DEFAULT_THUMBNAIL_CONFIG };
  let configError: string | undefined;
  try {
    config = validateThumbnailConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") configError = String(error);
  }

  let requestRender: (() => void) | undefined;
  const thumbnailer = createThumbnailer({
    async resize(bytes, mimeType, options) {
      const result = await resizeImage(bytes, mimeType, options);
      return result ? { data: result.data, mimeType: result.mimeType } : null;
    },
    async toPng(thumbnail) {
      const png = await convertToPng(thumbnail.data, thumbnail.mimeType);
      return png ? { data: png.data, mimeType: png.mimeType } : null;
    },
    needsPng: () => getCapabilities().images === "kitty",
  }, () => config);

  const restore = patchImageRender(Image.prototype as never, {
    thumbnailer,
    getConfig: () => config,
    canDrawImages: () => Boolean(getCapabilities().images),
    onReady: () => requestRender?.(),
  });

  pi.on("session_start", async (_event, ctx) => {
    if (configError && ctx.hasUI) ctx.ui.notify(`Invalid ${path}; image thumbnails use defaults. ${configError}`, "warning");
    if (!ctx.hasUI) return;
    // The UI API has no repaint call, but a widget factory receives the TUI. An empty
    // widget costs nothing and gives the thumbnail a way to ask for a repaint.
    ctx.ui.setWidget("image-thumbnails-repaint", (tui) => {
      requestRender = () => tui.requestRender();
      return { render: () => [], invalidate: () => {} };
    });
  });
  pi.on("session_shutdown", async () => {
    requestRender = undefined;
    restore();
  });
}
