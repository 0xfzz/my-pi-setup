import test from "node:test";
import assert from "node:assert/strict";
import { Container, Text, ScrollView, type Component } from "@earendil-works/pi-tui";
import { OnDemandContainer } from "../lib/sidebar/sidebar-ondemand.ts";

test("on-demand container delegates to native render when below threshold", () => {
  const container = new Container();
  for (let i = 0; i < 5; i++) {
    container.addChild(new Text(`Line ${i}`, 0, 0));
  }
  const sv = new ScrollView(container);
  const onDemand = new OnDemandContainer(container, () => sv, { threshold: 10 });
  const dispose = onDemand.install();

  const lines = container.render(40);
  assert.equal(lines.length, 5);
  assert.equal(lines[0]?.trim(), "Line 0");
  dispose();
});

test("on-demand container formats visible messages on demand and reuses cache for offscreen", () => {
  const container = new Container();
  const renderCounts = new Map<number, number>();

  for (let i = 0; i < 40; i++) {
    const id = i;
    const comp: Component = {
      render(width: number) {
        renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
        return [`Msg ${id} [w=${width}]`];
      },
      invalidate() {},
    };
    container.addChild(comp);
  }

  const sv = new ScrollView(container, { follow: "end" });
  // Mock viewport height and layout state
  Reflect.set(sv, "currentViewportHeight", 10);
  Reflect.set(sv, "followingEnd", true);

  const onDemand = new OnDemandContainer(container, () => sv, { threshold: 10, bufferLines: 5 });
  const dispose = onDemand.install();

  // First render at width 80: populates initial cache
  container.render(80);
  // All 40 were rendered at least once to populate the initial cache
  assert.equal(renderCounts.get(0), 1);
  assert.equal(renderCounts.get(39), 1);

  // Second render at width 70: only visible messages (near bottom 39) should re-render!
  container.render(70);

  // Message 0 (far offscreen at the top) should NOT have been re-rendered!
  assert.equal(renderCounts.get(0), 1, "Offscreen message 0 was not re-rendered");
  // Message 39 (visible at the bottom) SHOULD have been re-rendered on demand at width 70!
  assert.equal(renderCounts.get(39), 2, "Visible message 39 was re-rendered on demand");

  // Verify mouse layout exists
  const ml = Reflect.get(container, "mouseLayout");
  assert.ok(ml);
  assert.equal(ml.children.length, 40);

  dispose();
  // After dispose, original render is restored
  container.render(60);
  assert.equal(renderCounts.get(0), 2, "Message 0 re-rendered after on-demand uninstalled");
});
