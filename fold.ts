/** Where a transcript component sits in an exchange. */
export type Kind = "prompt" | "assistant" | "tool" | "spacer" | "other";

export interface Exchange<T> {
	/** Assistant message components, oldest first. */
	assistants: T[];
	/** Top-level tool call rows. */
	toolCount: number;
	/** The agent is still working on this exchange. */
	live: boolean;
	/** The assistant message shown as the agent's final answer. */
	answer?: T;
}

export type FoldItem<T> =
	| { type: "child"; child: T }
	| { type: "working"; exchange: Exchange<T> }
	| { type: "answer"; child: T };

export interface FoldOptions<T> {
	kindOf(child: T): Kind;
	/** True when an assistant message ended its run instead of stopping for tool calls. */
	isAnswer(child: T): boolean;
	/** The agent is working on the last exchange. */
	live: boolean;
}

export interface Timing {
	/** When the prompt before this assistant message was sent. */
	start: number;
	/** When this assistant message finished. */
	end: number;
}

function newExchange<T>(): Exchange<T> {
	return { assistants: [], toolCount: 0, live: false };
}

/**
 * Splits the transcript at each prompt and replaces what the agent did in an
 * exchange with one Working line. Prompts, the final answer, and anything that
 * is neither an assistant message nor a tool call stay where they are.
 */
export function foldTranscript<T>(children: readonly T[], options: FoldOptions<T>): FoldItem<T>[] {
	const exchanges: Exchange<T>[] = [newExchange()];
	const kinds: Kind[] = [];
	const exchangeOf: Exchange<T>[] = [];
	let exchange = exchanges[0] as Exchange<T>;
	let previous: Kind | undefined;
	for (const child of children) {
		const kind = options.kindOf(child);
		// A skill block and the prompt rendered under it are one prompt.
		if (kind === "prompt" && previous !== "prompt") {
			exchange = newExchange();
			exchanges.push(exchange);
		}
		if (kind !== "spacer") previous = kind;
		if (kind === "assistant") exchange.assistants.push(child);
		else if (kind === "tool") exchange.toolCount++;
		kinds.push(kind);
		exchangeOf.push(exchange);
	}

	exchange.live = options.live;
	for (const candidate of exchanges) {
		const last = candidate.assistants[candidate.assistants.length - 1];
		if (!candidate.live && last !== undefined && options.isAnswer(last)) candidate.answer = last;
	}

	const items: FoldItem<T>[] = [];
	const placed = new Set<Exchange<T>>();
	children.forEach((child, index) => {
		const kind = kinds[index];
		const owner = exchangeOf[index] as Exchange<T>;
		if (kind !== "assistant" && kind !== "tool") {
			items.push({ type: "child", child });
			return;
		}
		if (!placed.has(owner)) {
			placed.add(owner);
			items.push({ type: "working", exchange: owner });
		}
		if (child === owner.answer) items.push({ type: "answer", child });
	});
	if (exchange.live && !placed.has(exchange)) items.push({ type: "working", exchange });
	return items;
}

export function toMs(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

export interface Timings {
	/** By assistant message object; transcript components hold the same objects as the session. */
	byMessage: WeakMap<object, Timing>;
	/** By assistant message timestamp, for copies of a message. */
	byTimestamp: Map<number, Timing>;
	/** When the latest prompt on the branch was sent. */
	lastUserAt?: number;
}

/** Times each assistant message on a session branch from the prompt before it to its end. */
export function collectTimings(entries: readonly any[]): Timings {
	const timings: Timings = { byMessage: new WeakMap(), byTimestamp: new Map() };
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry.message;
		const at = toMs(message?.timestamp);
		if (at === undefined) continue;
		if (message.role === "user") {
			timings.lastUserAt = at;
		} else if (message.role === "assistant") {
			const timing = { start: timings.lastUserAt ?? at, end: toMs(entry.timestamp) ?? at };
			timings.byMessage.set(message, timing);
			timings.byTimestamp.set(at, timing);
		}
	}
	return timings;
}

/** The timing of an assistant message, matched by identity first. */
export function timingOf(timings: Timings, message: any): Timing | undefined {
	if (!message || typeof message !== "object") return undefined;
	const exact = timings.byMessage.get(message);
	if (exact) return exact;
	const at = toMs(message.timestamp);
	return at === undefined ? undefined : timings.byTimestamp.get(at);
}

export function formatElapsed(ms: number): string {
	const totalSeconds = ms / 1000;
	if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds - minutes * 60;
	return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** "7 tool calls, 1:23.4", "1 tool call, 2.0s", or "4.2s". */
export function describeWork(toolCount: number, ms: number | undefined): string {
	const parts: string[] = [];
	if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? "" : "s"}`);
	if (ms !== undefined) parts.push(formatElapsed(ms));
	return parts.join(", ");
}
