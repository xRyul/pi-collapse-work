/**
 * Collapse Work Extension
 *
 * Folds everything the agent does between two prompts into one line, so the
 * transcript reads as prompt, work summary, answer:
 *
 *   Working... 7 tool calls, 1:23.4
 *
 * Ctrl+O (app.tools.expand) cycles folded → tool calls → tool output → folded.
 *
 * Implementation notes:
 * - Pi has no API for hiding transcript entries. We take the TUI handed to a
 *   widget factory, find pi's chat container in it, and replace that
 *   container's render() with a folded view of its children.
 * - Ctrl+O is reserved for extensions, so we take it from raw terminal input
 *   while the main editor has focus and drive ctx.ui.setToolsExpanded().
 * - If pi changes its internal UI structure, the extension stays inert and pi
 *   renders the transcript as usual.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	CustomEditor,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	getKeybindings,
	isKeyRelease,
	Spacer,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { collectTimings, describeWork, type Exchange, foldTranscript, type Kind, type Timings, timingOf, toMs } from "./fold.ts";

type Store = {
	folded: boolean;
	/** Between agent_start and agent_settled. */
	inRun: boolean;
	/** The run has shown a message, so the last exchange is the one being worked on. */
	live: boolean;
	runStartedAt?: number;
	timings: Timings;
	/** When the latest prompt was sent, including one not saved yet. */
	lastUserAt?: number;
	timingsDirty: boolean;
	sessionManager?: ExtensionContext["sessionManager"];
	ui?: ExtensionContext["ui"];
	/** Text-only copies of final answers, keyed by the transcript's assistant component. */
	answers: WeakMap<object, { message: unknown; outputPad: unknown; component: Component }>;
};

type Patch = { render: Container["render"]; invalidate: Container["invalidate"] };

const STORE_KEY = Symbol.for("pi.extensions.collapseWork.store");
const PATCH_KEY = Symbol.for("pi.extensions.collapseWork.patch");
const WIDGET_KEY = "pi-collapse-work";
const EXPAND_ACTION = "app.tools.expand";
const TICK_MS = 100;

function getStore(): Store | undefined {
	return (globalThis as any)[STORE_KEY] as Store | undefined;
}

function kindOf(child: unknown): Kind {
	if (child instanceof UserMessageComponent || child instanceof SkillInvocationMessageComponent) return "prompt";
	if (child instanceof AssistantMessageComponent) return "assistant";
	if (child instanceof ToolExecutionComponent) return "tool";
	if (child instanceof Spacer) return "spacer";
	return "other";
}

/** An assistant message that ended its run instead of stopping for tool calls. */
function isAnswer(child: unknown): boolean {
	const stopReason = (child as any)?.lastMessage?.stopReason;
	return typeof stopReason === "string" && stopReason !== "toolUse";
}

function refreshTimings(store: Store): void {
	if (!store.timingsDirty || !store.sessionManager) return;
	store.timingsDirty = false;
	try {
		store.timings = collectTimings(store.sessionManager.getBranch());
		const saved = store.timings.lastUserAt;
		// A prompt that has started but is not saved yet is newer than the branch.
		if (saved !== undefined && (store.lastUserAt === undefined || saved > store.lastUserAt)) {
			store.lastUserAt = saved;
		}
	} catch {
		// A replaced session invalidates its manager; keep the last timings.
	}
}

function elapsedMs(exchange: Exchange<unknown>, store: Store, now: number): number | undefined {
	if (exchange.live) {
		const start = store.lastUserAt ?? store.runStartedAt;
		return start === undefined ? undefined : Math.max(0, now - start);
	}
	for (let i = exchange.assistants.length - 1; i >= 0; i--) {
		const timing = timingOf(store.timings, (exchange.assistants[i] as any)?.lastMessage);
		if (timing) return Math.max(0, timing.end - timing.start);
	}
	return undefined;
}

function workingLine(exchange: Exchange<unknown>, store: Store, now: number): Component {
	const detail = describeWork(exchange.toolCount, elapsedMs(exchange, store, now));
	const theme = store.ui?.theme;
	const label = theme
		? theme.italic(theme.fg("thinkingText", "Working...") + (detail ? theme.fg("dim", ` ${detail}`) : ""))
		: detail
			? `Working... ${detail}`
			: "Working...";
	const outputPad = (exchange.assistants[0] as any)?.outputPad;
	const pad = " ".repeat(typeof outputPad === "number" ? outputPad : 1);
	return {
		render: (width) => ["", truncateToWidth(pad + label, width)],
		invalidate() {},
	};
}

/** The final answer without its thinking blocks and tool calls. */
function answerComponent(source: any, store: Store): Component {
	const message = source?.lastMessage;
	if (!message || !Array.isArray(message.content)) return source;
	if (message.content.every((block: any) => block?.type === "text")) return source;
	const cached = store.answers.get(source);
	if (cached && cached.message === message && cached.outputPad === source.outputPad) return cached.component;
	const component = new AssistantMessageComponent(
		{ ...message, content: message.content.filter((block: any) => block?.type === "text") },
		true,
		source.markdownTheme,
		source.hiddenThinkingLabel,
		source.outputPad,
		source.markdownTransformers,
	);
	store.answers.set(source, { message, outputPad: source.outputPad, component });
	return component;
}

function renderFolded(chat: Container, width: number, store: Store): string[] {
	refreshTimings(store);
	const now = Date.now();
	const items = foldTranscript<Component>(chat.children, { kindOf, isAnswer, live: store.live });
	const lines: string[] = [];
	const mouseChildren: Array<{ component: Component; height: number }> = [];
	for (const item of items) {
		const component =
			item.type === "child"
				? item.child
				: item.type === "answer"
					? answerComponent(item.child, store)
					: workingLine(item.exchange, store, now);
		const rendered = component.render(width);
		mouseChildren.push({ component, height: rendered.length });
		for (const line of rendered) lines.push(line);
	}
	// Container.handleMouse maps clicks through the layout of the last render.
	(chat as any).mouseLayout = { width, children: mouseChildren };
	return lines;
}

function removePatch(chat: Container | undefined): void {
	const original = (chat as any)?.[PATCH_KEY] as Patch | undefined;
	if (!chat || !original) return;
	chat.render = original.render;
	chat.invalidate = original.invalidate;
	delete (chat as any)[PATCH_KEY];
}

function installPatch(chat: Container): void {
	// Replace a patch left by an earlier load instead of wrapping it.
	removePatch(chat);
	const original: Patch = { render: chat.render, invalidate: chat.invalidate };
	chat.render = function (this: Container, width: number): string[] {
		const store = getStore();
		if (store?.folded) {
			try {
				return renderFolded(this, width, store);
			} catch {
				// Never break the transcript; fall back to pi's rendering.
			}
		}
		return original.render.call(this, width);
	};
	chat.invalidate = function (this: Container): void {
		original.invalidate.call(this);
		const store = getStore();
		if (store) store.answers = new WeakMap();
	};
	(chat as any)[PATCH_KEY] = original;
}

/** Widget factories receive pi's TUI; mount an empty widget just long enough to take it. */
function captureTui(ui: ExtensionContext["ui"]): TUI | undefined {
	let captured: TUI | undefined;
	ui.setWidget(
		WIDGET_KEY,
		(tui) => {
			captured = tui;
			return { render: () => [], invalidate() {} };
		},
		{ placement: "belowEditor" },
	);
	ui.setWidget(WIDGET_KEY, undefined);
	return captured;
}

/** Pi's document holds three plain containers: header, loaded resources, chat. */
function findChat(tui: TUI | undefined): Container | undefined {
	for (const root of (tui as any)?.children ?? []) {
		const children = root?.children;
		if (!Array.isArray(children) || children.length !== 3) continue;
		if (children.every((child) => Object.getPrototypeOf(child) === Container.prototype)) {
			return children[2] as Container;
		}
	}
	return undefined;
}

/** Pi's interactive mode installs its keybindings globally, so this follows rebinds of Ctrl+O. */
function isExpandKey(data: string): boolean {
	return getKeybindings().matches(data, EXPAND_ACTION as any);
}

export default function (pi: ExtensionAPI) {
	const store: Store = {
		folded: true,
		inRun: false,
		live: false,
		timings: collectTimings([]),
		timingsDirty: true,
		answers: new WeakMap(),
	};
	(globalThis as any)[STORE_KEY] = store;

	let tui: TUI | undefined;
	let chat: Container | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let unsubscribeInput: (() => void) | undefined;

	function requestRender() {
		tui?.requestRender();
	}

	function stopTicker() {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	}

	function startTicker() {
		if (ticker || !chat) return;
		ticker = setInterval(() => {
			if (store.folded) requestRender();
		}, TICK_MS);
	}

	function cycle(ui: ExtensionContext["ui"]) {
		let status: string;
		if (store.folded) {
			store.folded = false;
			ui.setToolsExpanded(false);
			status = "Work: tool calls";
		} else if (!ui.getToolsExpanded()) {
			ui.setToolsExpanded(true);
			status = "Work: tool output";
		} else {
			store.folded = true;
			ui.setToolsExpanded(false);
			status = "Work: folded";
		}
		// Pi reports "Tool output: ..." for setToolsExpanded; this replaces that status line.
		ui.notify(status, "info");
		requestRender();
	}

	function resetBranchState() {
		store.timingsDirty = true;
		store.lastUserAt = undefined;
		store.answers = new WeakMap();
	}

	function teardown() {
		stopTicker();
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		removePatch(chat);
		chat = undefined;
		tui = undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		teardown();
		store.ui = ctx.ui;
		store.sessionManager = ctx.sessionManager;
		store.inRun = store.live = !ctx.isIdle();
		resetBranchState();

		tui = captureTui(ctx.ui);
		chat = findChat(tui);
		if (!chat) {
			ctx.ui.notify("pi-collapse-work: chat container not found; transcript is not folded", "warning");
			return;
		}
		installPatch(chat);
		if (store.inRun) startTicker();

		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (isKeyRelease(data) || !isExpandKey(data)) return undefined;
			// Dialogs and selectors give Ctrl+O their own meaning.
			if (!((tui as any)?.getFocusedComponent?.() instanceof CustomEditor)) return undefined;
			cycle(ctx.ui);
			return { consume: true };
		});
		requestRender();
	});

	pi.on("agent_start", async () => {
		store.inRun = true;
		store.runStartedAt = Date.now();
		startTicker();
	});

	pi.on("message_start", async (event) => {
		const message: any = event.message;
		if (message?.role === "user") {
			store.lastUserAt = toMs(message.timestamp) ?? Date.now();
		}
		// Waiting for the run's first message keeps the previous answer on screen
		// until the new prompt is in the transcript.
		if (store.inRun && (message?.role === "user" || message?.role === "assistant")) {
			store.live = true;
		}
	});

	pi.on("message_end", async () => {
		store.timingsDirty = true;
	});

	pi.on("agent_settled", async () => {
		store.inRun = false;
		store.live = false;
		store.timingsDirty = true;
		stopTicker();
		requestRender();
	});

	pi.on("session_tree", async () => {
		resetBranchState();
	});

	pi.on("session_compact", async () => {
		resetBranchState();
	});

	pi.on("session_shutdown", async () => {
		teardown();
		store.inRun = false;
		store.live = false;
	});
}
