/** 跟本地 daemon 的那条线：SSE 收流，fetch 发话。没有 WebSocket 依赖。 */

export type BridgeEvent =
	| { type: "hello"; model: string; conversation: string | null }
	| { type: "delta"; text: string }
	| { type: "expression"; id: string }
	| { type: "turn"; text: string; expression?: string | null; firstTokenMs: number; latencyMs: number; effort: string }
	| { type: "tool"; toolName: string; phase: "start" | "end"; isError?: boolean }
	| {
			type: "ask";
			id: string;
			phase: "ask" | "done" | "timeout";
			title?: string;
			detail?: string;
			why?: string;
			where?: string;
			options?: readonly { key: string; label: string }[];
			choice?: string;
	  }
	| { type: "compact"; dropped: number }
	| { type: "error"; message: string };

export interface BridgeHandlers {
	onEvent?(event: BridgeEvent): void;
	onLink?(state: "online" | "offline"): void;
}

export class Bridge {
	readonly base: string;
	private handlers: BridgeHandlers = {};
	private source: EventSource | null = null;

	constructor(base: string) {
		this.base = base.replace(/\/+$/u, "");
	}

	open(handlers: BridgeHandlers): void {
		this.handlers = handlers;
		this.close();
		const source = new EventSource(this.base + "/events");
		source.onopen = () => this.handlers.onLink?.("online");
		source.onerror = () => this.handlers.onLink?.("offline");
		source.onmessage = (message: MessageEvent<string>) => {
			let parsed: BridgeEvent;
			try {
				parsed = JSON.parse(message.data) as BridgeEvent;
			} catch {
				return;
			}
			this.handlers.onEvent?.(parsed);
		};
		this.source = source;
	}

	close(): void {
		if (this.source !== null) {
			this.source.close();
			this.source = null;
		}
	}

	async say(text: string): Promise<{ ok: boolean; reason?: string }> {
		return this.post("/say", { text });
	}

	/** 一张图（data URL）+ 他顺口说的那句话。daemon 那边先过眼睛，再交给她接话。 */
	async image(image: { data: string; name: string; text: string }): Promise<{ ok: boolean; reason?: string }> {
		return this.post("/image", image);
	}

	async speakUp(hint = ""): Promise<{ ok: boolean; reason?: string }> {
		return this.post("/speakup", { hint });
	}

	/** 她问「能不能看这个文件夹」时，窗口里那张卡片按下去的那一下（ADR-0045）。 */
	async answer(id: string, choice: "yes" | "always" | "no"): Promise<{ ok: boolean; reason?: string }> {
		return this.post("/answer", { id, choice });
	}

	/** 这一刻的心情（ADR-0044）：页面算 VAD，daemon 转成一句话，每轮贴在对方那句话末尾。 */
	async mood(mood: { valence: number; arousal: number; face: string | null; held: number }): Promise<void> {
		const held = Number.isFinite(mood.held) ? mood.held : 999;
		await this.post("/mood", { ...mood, held });
	}

	private async post(path: string, body: unknown): Promise<{ ok: boolean; reason?: string }> {
		try {
			const response = await fetch(this.base + path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (response.ok) return { ok: true };
			const raw = await response.text();
			return { ok: false, reason: raw.slice(0, 200) };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}
}
