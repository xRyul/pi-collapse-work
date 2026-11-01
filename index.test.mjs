import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AssistantMessageComponent,
  CustomEditor,
  discoverAndLoadExtensions,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  KeybindingsManager,
  setKeybindings,
  Spacer,
  stripTerminalSequences,
  Text,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";

const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
initTheme("dark", false);
setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o" } }));

const CTRL_O = "\x0f";
const WIDTH = 80;

async function loadExtension(t) {
  const discoveryRoot = await mkdtemp(join(tmpdir(), "pi-collapse-work-"));
  t.after(() => rm(discoveryRoot, { recursive: true, force: true }));
  const result = await discoverAndLoadExtensions([extensionPath], discoveryRoot, join(discoveryRoot, "agent"));
  assert.deepEqual(result.errors, []);
  const resolved = await realpath(extensionPath);
  const extension = result.extensions.find((candidate) => candidate.resolvedPath === resolved);
  assert.ok(extension, "collapse-work extension should load");
  return extension;
}

async function emit(extension, type, event, ctx) {
  for (const handler of extension.handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
}

/** Pi's interactive layout: a document of header, resources and chat, plus the editor. */
function createHost({ branch = [] } = {}) {
  const chat = new Container();
  const document = new Container();
  document.addChild(new Container());
  document.addChild(new Container());
  document.addChild(chat);
  const editor = Object.create(CustomEditor.prototype);
  const listeners = [];
  const notices = [];
  let toolsExpanded = false;
  let focused = editor;
  let renders = 0;
  const tui = {
    children: [document, new Container()],
    getFocusedComponent: () => focused,
    requestRender: () => renders++,
  };
  const theme = {
    fg: (_color, text) => text,
    italic: (text) => text,
  };
  const ui = {
    theme,
    setWidget(_key, content) {
      if (typeof content === "function") content(tui, theme);
    },
    onTerminalInput(handler) {
      listeners.push(handler);
      return () => listeners.splice(listeners.indexOf(handler), 1);
    },
    notify: (message) => notices.push(message),
    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded(expanded) {
      toolsExpanded = expanded;
      for (const child of chat.children) child.setExpanded?.(expanded);
    },
  };
  let idle = true;
  const ctx = {
    ui,
    mode: "tui",
    isIdle: () => idle,
    sessionManager: { getBranch: () => branch },
  };
  return {
    chat,
    ctx,
    tui,
    notices,
    get renders() {
      return renders;
    },
    setIdle(value) {
      idle = value;
    },
    focus(component) {
      focused = component;
    },
    press(data) {
      for (const listener of [...listeners]) {
        const result = listener(data);
        if (result?.consume) return true;
      }
      return false;
    },
    screen() {
      return chat.render(WIDTH).map((line) => stripTerminalSequences(line).trimEnd()).join("\n");
    },
  };
}

const assistantMessage = (timestamp, content, stopReason) => ({ role: "assistant", content, stopReason, timestamp });
const toolCall = (id) => ({ type: "toolCall", id, name: "probe_tool", arguments: { target: id } });

function addPrompt(chat, text) {
  chat.addChild(new Spacer(1));
  chat.addChild(new UserMessageComponent(text));
}

function addAssistant(chat, message) {
  chat.addChild(new AssistantMessageComponent(message, true));
  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    const ui = { requestRender() {} };
    const component = new ToolExecutionComponent(block.name, block.id, block.arguments, {}, undefined, ui, "/tmp");
    component.updateResult({ content: [{ type: "text", text: `output of ${block.id}` }], isError: false });
    chat.addChild(component);
  }
}

function buildExchange(chat) {
  addPrompt(chat, "PROMPT-ONE");
  addAssistant(chat, assistantMessage(1100, [{ type: "thinking", thinking: "THOUGHT" }, { type: "text", text: "INTERIM-TEXT" }, toolCall("call-a"), toolCall("call-b")], "toolUse"));
  addAssistant(chat, assistantMessage(1300, [toolCall("call-c")], "toolUse"));
  addAssistant(chat, assistantMessage(1500, [{ type: "thinking", thinking: "LAST-THOUGHT" }, { type: "text", text: "FINAL-ANSWER" }], "stop"));
}

const branch = [
  { type: "message", timestamp: new Date(1000).toISOString(), message: { role: "user", timestamp: 1000 } },
  { type: "message", timestamp: new Date(1200).toISOString(), message: { role: "assistant", timestamp: 1100 } },
  { type: "message", timestamp: new Date(1400).toISOString(), message: { role: "assistant", timestamp: 1300 } },
  { type: "message", timestamp: new Date(84400).toISOString(), message: { role: "assistant", timestamp: 1500 } },
];

test("the transcript folds to prompt, Working line and final answer", async (t) => {
  const extension = await loadExtension(t);
  const host = createHost({ branch });
  buildExchange(host.chat);
  await emit(extension, "session_start", { reason: "startup" }, host.ctx);

  const screen = host.screen();
  assert.match(screen, /PROMPT-ONE/);
  assert.match(screen, /Working\.\.\. 3 tool calls, 1:23\.4/);
  assert.match(screen, /FINAL-ANSWER/);
  for (const hidden of ["INTERIM-TEXT", "THOUGHT", "LAST-THOUGHT", "probe_tool", "call-a", "output of"]) {
    assert.doesNotMatch(screen, new RegExp(hidden), `${hidden} should be folded away`);
  }
  assert.ok(screen.indexOf("PROMPT-ONE") < screen.indexOf("Working") && screen.indexOf("Working") < screen.indexOf("FINAL-ANSWER"));

  await emit(extension, "session_shutdown", { reason: "quit" }, host.ctx);
});

test("Ctrl+O cycles folded, tool calls, tool output and back", async (t) => {
  const extension = await loadExtension(t);
  const host = createHost({ branch });
  buildExchange(host.chat);
  await emit(extension, "session_start", { reason: "startup" }, host.ctx);

  assert.equal(host.press(CTRL_O), true);
  let screen = host.screen();
  assert.doesNotMatch(screen, /Working\.\.\./);
  assert.match(screen, /INTERIM-TEXT/);
  assert.match(screen, /probe_tool/);
  assert.equal(host.ctx.ui.getToolsExpanded(), false);
  assert.equal(host.notices.at(-1), "Work: tool calls");

  assert.equal(host.press(CTRL_O), true);
  screen = host.screen();
  assert.match(screen, /probe_tool/);
  assert.equal(host.ctx.ui.getToolsExpanded(), true);
  assert.equal(host.notices.at(-1), "Work: tool output");

  assert.equal(host.press(CTRL_O), true);
  screen = host.screen();
  assert.match(screen, /Working\.\.\. 3 tool calls/);
  assert.doesNotMatch(screen, /probe_tool/);
  assert.equal(host.ctx.ui.getToolsExpanded(), false);
  assert.equal(host.notices.at(-1), "Work: folded");

  await emit(extension, "session_shutdown", { reason: "quit" }, host.ctx);
});

test("Ctrl+O is left alone while a dialog or selector has focus", async (t) => {
  const extension = await loadExtension(t);
  const host = createHost({ branch });
  buildExchange(host.chat);
  await emit(extension, "session_start", { reason: "startup" }, host.ctx);

  host.focus(new Text("selector"));
  assert.equal(host.press(CTRL_O), false);
  assert.match(host.screen(), /Working\.\.\./);
  assert.equal(host.press("a"), false);

  await emit(extension, "session_shutdown", { reason: "quit" }, host.ctx);
});

test("a running exchange shows a live Working line and no streamed text", async (t) => {
  const extension = await loadExtension(t);
  const host = createHost();
  addPrompt(host.chat, "OLD-PROMPT");
  addAssistant(host.chat, assistantMessage(500, [{ type: "text", text: "OLD-ANSWER" }], "stop"));
  await emit(extension, "session_start", { reason: "startup" }, host.ctx);

  host.setIdle(false);
  await emit(extension, "agent_start", {}, host.ctx);
  // The previous answer stays until the new prompt reaches the transcript.
  assert.match(host.screen(), /OLD-ANSWER/);

  const sentAt = Date.now() - 4000;
  await emit(extension, "message_start", { message: { role: "user", content: "NEW", timestamp: sentAt } }, host.ctx);
  addPrompt(host.chat, "NEW-PROMPT");
  addAssistant(host.chat, assistantMessage(Date.now(), [{ type: "text", text: "STREAMING-TEXT" }, toolCall("live-1")], "toolUse"));
  addAssistant(host.chat, assistantMessage(Date.now(), [{ type: "text", text: "DRAFT-ANSWER" }], "stop"));

  let screen = host.screen();
  assert.match(screen, /OLD-ANSWER/);
  assert.match(screen, /NEW-PROMPT/);
  assert.match(screen, /Working\.\.\. 1 tool call, [4-9]\.\ds/);
  assert.doesNotMatch(screen, /STREAMING-TEXT|DRAFT-ANSWER|probe_tool/);

  host.setIdle(true);
  await emit(extension, "agent_settled", { aborted: false }, host.ctx);
  screen = host.screen();
  assert.match(screen, /DRAFT-ANSWER/);
  assert.doesNotMatch(screen, /STREAMING-TEXT/);

  await emit(extension, "session_shutdown", { reason: "quit" }, host.ctx);
});

test("shutdown restores pi's own rendering of the chat", async (t) => {
  const extension = await loadExtension(t);
  const host = createHost({ branch });
  buildExchange(host.chat);
  const originalRender = host.chat.render;
  await emit(extension, "session_start", { reason: "startup" }, host.ctx);
  assert.notEqual(host.chat.render, originalRender);

  await emit(extension, "session_shutdown", { reason: "reload" }, host.ctx);
  assert.equal(host.chat.render, originalRender);
  assert.match(host.screen(), /INTERIM-TEXT/);
  assert.equal(host.press(CTRL_O), false);
});

test("without pi's chat layout the extension stays out of the way", async (t) => {
  const extension = await loadExtension(t);
  const host = createHost();
  host.tui.children = [new Container()];
  await emit(extension, "session_start", { reason: "startup" }, host.ctx);
  assert.match(host.notices.at(-1), /chat container not found/);
  assert.equal(host.press(CTRL_O), false);
  await emit(extension, "session_shutdown", { reason: "quit" }, host.ctx);
});

test("non-interactive modes are ignored", async (t) => {
  const extension = await loadExtension(t);
  const host = createHost({ branch });
  buildExchange(host.chat);
  const originalRender = host.chat.render;
  await emit(extension, "session_start", { reason: "startup" }, { ...host.ctx, mode: "print" });
  assert.equal(host.chat.render, originalRender);
});
