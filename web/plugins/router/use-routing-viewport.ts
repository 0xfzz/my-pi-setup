import { useEffect, useRef, useState, type PointerEvent } from "react";
import { fitRoutingViewport, zoomRoutingViewport, type RoutingLayout, type RoutingViewport } from "./routing-layout.ts";

/** Pan is read-only: it never sends a router command. */
interface PointerPoint { x: number; y: number }
interface PinchGesture { distance: number; center: PointerPoint; viewport: RoutingViewport }

function distanceBetween(a: PointerPoint, b: PointerPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpointOf(a: PointerPoint, b: PointerPoint): PointerPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Canvas gestures never send router commands: inspecting a path cannot change routing. */
export function useRoutingViewport(graph: RoutingLayout) {
  const canvas = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, PointerPoint>());
  const drag = useRef<{ id: number; x: number; y: number; origin: RoutingViewport } | null>(null);
  const pinch = useRef<PinchGesture | null>(null);
  const [viewport, setViewport] = useState<RoutingViewport>({ x: 0, y: 0, scale: 1 });
  const dimensions = useRef(graph);
  dimensions.current = graph;

  const pointerPair = (): [PointerPoint, PointerPoint] | null => {
    const points = [...pointers.current.values()];
    return points.length >= 2 ? [points[0], points[1]] : null;
  };

  const startPinch = (viewportAtStart: RoutingViewport): void => {
    const pair = pointerPair();
    if (pair === null) return;
    drag.current = null;
    pinch.current = {
      distance: distanceBetween(...pair),
      center: midpointOf(...pair),
      viewport: viewportAtStart,
    };
  };

  const fit = () => {
    const element = canvas.current;
    if (element) setViewport(fitRoutingViewport(element.getBoundingClientRect(), dimensions.current));
  };
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport(fitRoutingViewport(element.getBoundingClientRect(), dimensions.current)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [graph.width, graph.height]);

  const zoom = (factor: number) => {
    const bounds = canvas.current?.getBoundingClientRect();
    if (bounds) setViewport(current => zoomRoutingViewport(current, { factor, anchor: { x: bounds.width / 2, y: bounds.height / 2 } }));
  };
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      setViewport(current => zoomRoutingViewport(current, {
        factor: Math.exp(-event.deltaY * 0.002), anchor: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      }));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      pinch.current = null;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: viewport };
      return;
    }
    startPinch(viewport);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pair = pointerPair();
    if (pair !== null && pinch.current !== null) {
      if (pinch.current.distance > 0) {
        setViewport(zoomRoutingViewport(pinch.current.viewport, {
          factor: distanceBetween(...pair) / pinch.current.distance,
          anchor: pinch.current.center,
        }));
      }
      return;
    }
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    setViewport({ ...start.origin, x: start.origin.x + event.clientX - start.x, y: start.origin.y + event.clientY - start.y });
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointerPair() !== null) {
      startPinch(viewport);
      return;
    }
    drag.current = null;
    pinch.current = null;
  };

  return {
    canvas, viewport, fit, zoom,
    gestures: {
      onPointerDown, onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onLostPointerCapture: onPointerEnd,
    },
  };
}
