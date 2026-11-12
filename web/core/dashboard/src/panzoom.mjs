/**
 * Pan/zoom for an inline SVG using only its `viewBox` attribute.
 *
 * No CSS transforms (so no inline-style CSP exceptions) and no external
 * libraries. Pointer drag pans, wheel zooms around the cursor, and the SVG is
 * keyboard operable when focused (+ / - / 0 / arrows).
 */

const MIN_ZOOM_WIDTH_RATIO = 0.12;
const MAX_ZOOM_WIDTH_RATIO = 10;

function parseViewBox(text) {
  const parts = String(text || "").trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value)) || parts[2] <= 0 || parts[3] <= 0) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function formatNumber(value) {
  return Number(value.toFixed(3));
}

export function createPanZoom(container, svg, { onChange } = {}) {
  const initial = parseViewBox(svg.getAttribute("viewBox")) || { x: 0, y: 0, w: 640, h: 420 };
  let view = { ...initial };
  let touched = false;
  let drag = null;

  function apply() {
    svg.setAttribute("viewBox", `${formatNumber(view.x)} ${formatNumber(view.y)} ${formatNumber(view.w)} ${formatNumber(view.h)}`);
    onChange?.({ ...view }, touched);
  }

  function pointerToGraph(event) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    const scale = Math.min(rect.width / view.w, rect.height / view.h);
    const renderedWidth = view.w * scale;
    const renderedHeight = view.h * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;
    return {
      x: view.x + (event.clientX - rect.left - offsetX) / scale,
      y: view.y + (event.clientY - rect.top - offsetY) / scale,
    };
  }

  function zoomAt(factor, point) {
    const clamped = Math.min(MAX_ZOOM_WIDTH_RATIO, Math.max(MIN_ZOOM_WIDTH_RATIO, factor));
    const width = Math.max(initial.w * MIN_ZOOM_WIDTH_RATIO, Math.min(initial.w * MAX_ZOOM_WIDTH_RATIO, view.w * clamped));
    const ratio = width / view.w;
    const center = point || { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    view = {
      x: center.x - (center.x - view.x) * ratio,
      y: center.y - (center.y - view.y) * ratio,
      w: width,
      h: view.h * ratio,
    };
    touched = true;
    apply();
  }

  function onWheel(event) {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    zoomAt(factor, pointerToGraph(event));
  }

  function onPointerDown(event) {
    if (event.button !== 0 || event.target.closest(".node")) return;
    drag = { x: event.clientX, y: event.clientY, view: { ...view } };
    svg.setPointerCapture?.(event.pointerId);
    svg.classList.add("is-panning");
  }

  function onPointerMove(event) {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / drag.view.w, rect.height / drag.view.h) || 1;
    view = {
      x: drag.view.x - (event.clientX - drag.x) / scale,
      y: drag.view.y - (event.clientY - drag.y) / scale,
      w: drag.view.w,
      h: drag.view.h,
    };
    touched = true;
    apply();
  }

  function onPointerUp(event) {
    if (!drag) return;
    drag = null;
    svg.releasePointerCapture?.(event.pointerId);
    svg.classList.remove("is-panning");
  }

  function onKeyDown(event) {
    const step = 0.15;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAt(1 / (1 + step));
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomAt(1 + step);
    } else if (event.key === "0") {
      event.preventDefault();
      fit();
    } else if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const dx = event.key === "ArrowLeft" ? -view.w * step : event.key === "ArrowRight" ? view.w * step : 0;
      const dy = event.key === "ArrowUp" ? -view.h * step : event.key === "ArrowDown" ? view.h * step : 0;
      view = { ...view, x: view.x + dx, y: view.y + dy };
      touched = true;
      apply();
    }
  }

  function fit() {
    view = { ...initial };
    touched = false;
    apply();
  }

  function zoomBy(factor) {
    zoomAt(factor, null);
  }

  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("pointermove", onPointerMove);
  svg.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("pointercancel", onPointerUp);
  svg.addEventListener("keydown", onKeyDown);
  apply();

  return {
    fit,
    zoomBy,
    getView: () => ({ ...view }),
    isTouched: () => touched,
    isDragging: () => Boolean(drag),
    recomputeInitial(next) {
      const parsed = parseViewBox(next);
      if (parsed) apply();
    },
    destroy() {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("pointerdown", onPointerDown);
      svg.removeEventListener("pointermove", onPointerMove);
      svg.removeEventListener("pointerup", onPointerUp);
      svg.removeEventListener("pointercancel", onPointerUp);
      svg.removeEventListener("keydown", onKeyDown);
    },
  };
}
