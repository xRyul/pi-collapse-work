import assert from "node:assert/strict";
import { test } from "node:test";
import { collectTimings, describeWork, foldTranscript, formatElapsed, timingOf } from "./fold.ts";

// Transcript stand-ins: kind, plus the stop reason of assistant messages.
const prompt = (name) => ({ kind: "prompt", name });
const assistant = (name, stopReason = "toolUse") => ({ kind: "assistant", name, stopReason });
const tool = (name) => ({ kind: "tool", name });
const spacer = () => ({ kind: "spacer", name: "·" });
const other = (name) => ({ kind: "other", name });

const fold = (children, live = false) =>
  foldTranscript(children, {
    kindOf: (child) => child.kind,
    isAnswer: (child) => child.stopReason !== "toolUse",
    live,
  });

// One string per folded item: child names, "W<tools>", and "A:<name>".
const shape = (items) =>
  items.map((item) =>
    item.type === "working" ? `W${item.exchange.toolCount}${item.exchange.live ? "*" : ""}` : item.type === "answer" ? `A:${item.child.name}` : item.child.name,
  );

test("an exchange keeps its prompt and answer and folds the work between them", () => {
  const items = fold([
    spacer(), prompt("p1"),
    assistant("a1"), tool("t1"), tool("t2"),
    assistant("a2"), tool("t3"),
    assistant("a3", "stop"),
  ]);
  assert.deepEqual(shape(items), ["·", "p1", "W3", "A:a3"]);
});

test("each prompt starts a new exchange with its own tool count", () => {
  const items = fold([
    prompt("p1"), assistant("a1"), tool("t1"), assistant("a2", "stop"),
    spacer(), prompt("p2"), assistant("b1"), tool("t2"), tool("t3"), assistant("b2", "stop"),
  ]);
  assert.deepEqual(shape(items), ["p1", "W1", "A:a2", "·", "p2", "W2", "A:b2"]);
});

test("a reply without tool calls still shows a Working line before it", () => {
  assert.deepEqual(shape(fold([prompt("p1"), assistant("a1", "stop")])), ["p1", "W0", "A:a1"]);
});

test("status lines, errors and custom messages stay visible inside the work", () => {
  const items = fold([
    prompt("p1"), assistant("a1"), tool("t1"), spacer(), other("warning"), tool("t2"), assistant("a2", "stop"),
  ]);
  assert.deepEqual(shape(items), ["p1", "W2", "·", "warning", "A:a2"]);
});

test("a live exchange shows no answer, even when its last message has stopped", () => {
  const items = fold([prompt("p1"), assistant("a1"), tool("t1"), assistant("a2", "stop")], true);
  assert.deepEqual(shape(items), ["p1", "W1*", ]);
});

test("a live exchange with nothing streamed yet still shows its Working line", () => {
  const items = fold([prompt("p1"), assistant("a1", "stop"), spacer(), prompt("p2")], true);
  assert.deepEqual(shape(items), ["p1", "W0", "A:a1", "·", "p2", "W0*"]);
});

test("only the latest exchange is live", () => {
  const items = fold([prompt("p1"), assistant("a1", "stop"), prompt("p2"), assistant("b1"), tool("t1")], true);
  assert.deepEqual(shape(items), ["p1", "W0", "A:a1", "p2", "W1*"]);
});

test("an aborted or failed last message is shown as the outcome", () => {
  assert.deepEqual(shape(fold([prompt("p1"), assistant("a1"), tool("t1"), assistant("a2", "aborted")])), ["p1", "W1", "A:a2"]);
  assert.deepEqual(shape(fold([prompt("p1"), assistant("a1", "error")])), ["p1", "W0", "A:a1"]);
});

test("an exchange that ends on a tool call shows only its Working line", () => {
  assert.deepEqual(shape(fold([prompt("p1"), assistant("a1"), tool("t1")])), ["p1", "W1"]);
});

test("a skill block and the prompt rendered under it are one prompt", () => {
  const items = fold([prompt("skill"), spacer(), prompt("p1"), assistant("a1"), tool("t1"), assistant("a2", "stop")]);
  assert.deepEqual(shape(items), ["skill", "·", "p1", "W1", "A:a2"]);
  assert.equal(items[3].exchange.toolCount, 1);
});

test("work before the first prompt, such as after compaction, is folded too", () => {
  const items = fold([other("compaction"), assistant("a1"), tool("t1"), assistant("a2", "stop"), prompt("p1")]);
  assert.deepEqual(shape(items), ["compaction", "W1", "A:a2", "p1"]);
});

test("timings run from the prompt to the end of each assistant message on the branch", () => {
  const first = { role: "assistant", timestamp: 1100 };
  const last = { role: "assistant", timestamp: 1300 };
  const entries = [
    { type: "model_change", timestamp: "2026-10-31T21:45:41.752Z" },
    { type: "message", timestamp: "2026-10-31T21:58:47.065Z", message: { role: "user", timestamp: 1000 } },
    { type: "message", timestamp: "2026-10-31T21:58:52.797Z", message: first },
    { type: "message", timestamp: "2026-10-31T21:58:53.000Z", message: { role: "toolResult", timestamp: 1200 } },
    { type: "message", timestamp: "1970-01-01T00:00:09.500Z", message: last },
    { type: "message", timestamp: "1970-01-01T00:00:20.000Z", message: { role: "user", timestamp: 20000 } },
  ];
  const timings = collectTimings(entries);
  assert.deepEqual(timingOf(timings, last), { start: 1000, end: 9500 });
  assert.deepEqual(timingOf(timings, { ...last }), { start: 1000, end: 9500 }, "copies match by timestamp");
  assert.equal(timingOf(timings, { role: "assistant", timestamp: 5 }), undefined);
  assert.equal(timings.lastUserAt, 20000);
});

test("messages sharing a timestamp keep their own timings", () => {
  const a = { role: "assistant", timestamp: 500 };
  const b = { role: "assistant", timestamp: 500 };
  const timings = collectTimings([
    { type: "message", timestamp: new Date(100).toISOString(), message: { role: "user", timestamp: 100 } },
    { type: "message", timestamp: new Date(3300).toISOString(), message: a },
    { type: "message", timestamp: new Date(9000).toISOString(), message: { role: "user", timestamp: 9000 } },
    { type: "message", timestamp: new Date(10500).toISOString(), message: b },
  ]);
  assert.deepEqual(timingOf(timings, a), { start: 100, end: 3300 });
  assert.deepEqual(timingOf(timings, b), { start: 9000, end: 10500 });
});

test("elapsed time reads like the thinking timer", () => {
  assert.equal(formatElapsed(0), "0.0s");
  assert.equal(formatElapsed(6540), "6.5s");
  assert.equal(formatElapsed(83400), "1:23.4");
  assert.equal(formatElapsed(605000), "10:05.0");
});

test("the Working detail names tool calls and time", () => {
  assert.equal(describeWork(7, 83400), "7 tool calls, 1:23.4");
  assert.equal(describeWork(1, 2000), "1 tool call, 2.0s");
  assert.equal(describeWork(0, 4200), "4.2s");
  assert.equal(describeWork(3, undefined), "3 tool calls");
  assert.equal(describeWork(0, undefined), "");
});
