import test from "node:test";
import assert from "node:assert/strict";
import { createFrameCoalescer, type FrameSource } from "./frame-coalescer.ts";

/** A frame source that runs callbacks only when the test says a frame passed. */
function manualFrames(): FrameSource<number> & { pass(): void; scheduled(): number } {
  const queue = new Map<number, () => void>();
  let next = 1;
  return {
    request(callback) {
      const id = next++;
      queue.set(id, callback);
      return id;
    },
    cancel(handle) {
      queue.delete(handle);
    },
    pass() {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) callback();
    },
    scheduled: () => queue.size,
  };
}

test("many requests before a frame render exactly once", () => {
  const frames = manualFrames();
  let renders = 0;
  const coalescer = createFrameCoalescer(() => { renders++; }, frames);
  for (let i = 0; i < 50; i++) coalescer.request();
  assert.equal(renders, 0);
  frames.pass();
  assert.equal(renders, 1);
});

test("a request after a rendered frame schedules a new frame", () => {
  const frames = manualFrames();
  let renders = 0;
  const coalescer = createFrameCoalescer(() => { renders++; }, frames);
  coalescer.request();
  frames.pass();
  coalescer.request();
  frames.pass();
  assert.equal(renders, 2);
});

test("only one frame is ever pending, however many requests arrive", () => {
  const frames = manualFrames();
  const coalescer = createFrameCoalescer(() => undefined, frames);
  coalescer.request();
  coalescer.request();
  coalescer.request();
  assert.equal(frames.scheduled(), 1);
});

test("flush renders at once and drops the frame still waiting", () => {
  const frames = manualFrames();
  let renders = 0;
  const coalescer = createFrameCoalescer(() => { renders++; }, frames);
  coalescer.request();
  coalescer.flush();
  assert.equal(renders, 1);
  assert.equal(frames.scheduled(), 0, "the waiting frame was cancelled, not left to render twice");
  frames.pass();
  assert.equal(renders, 1);
});

test("flush with nothing pending still renders", () => {
  let renders = 0;
  const coalescer = createFrameCoalescer(() => { renders++; }, manualFrames());
  coalescer.flush();
  assert.equal(renders, 1);
});

test("dispose drops the waiting frame without rendering", () => {
  const frames = manualFrames();
  let renders = 0;
  const coalescer = createFrameCoalescer(() => { renders++; }, frames);
  coalescer.request();
  coalescer.dispose();
  assert.equal(frames.scheduled(), 0);
  frames.pass();
  assert.equal(renders, 0);
});

test("a frame that runs synchronously still renders once and leaves nothing pending", () => {
  let renders = 0;
  const immediate: FrameSource<undefined> = {
    request(callback) {
      callback();
      return undefined;
    },
    cancel() {},
  };
  const coalescer = createFrameCoalescer(() => { renders++; }, immediate);
  coalescer.request();
  coalescer.request();
  assert.equal(renders, 2, "each request after a finished frame gets its own render");
});
