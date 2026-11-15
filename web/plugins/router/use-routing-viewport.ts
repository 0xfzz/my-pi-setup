import { useEffect, useRef, useState, type PointerEvent } from "react";
import { fitRoutingViewport, zoomRoutingViewport, type RoutingLayout, type RoutingViewport } from "./routing-layout.ts";

/** Canvas gestures never send router commands: inspecting a path cannot change routing. */
export function useRoutingViewport(graph: RoutingLayout) {
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; origin: RoutingViewport } | null>(null);
  const [viewport, setViewport] = useState<RoutingViewport>({ x: 0, y: 0, scale: 1 });
  const dimensions = useRef(graph);
  dimensions.current = graph;

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
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: viewport };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    setViewport({ ...start.origin, x: start.origin.x + event.clientX - start.x, y: start.origin.y + event.clientY - start.y });
  };
  const onPointerUp = () => { drag.current = null; };
  return { canvas, viewport, fit, zoom, gestures: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onLostPointerCapture: onPointerUp } };
}
