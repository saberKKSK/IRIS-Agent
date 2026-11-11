/** 字幕条 + 输入条。只碰 DOM，不知道模型和网络。 */

const MAX_SAID = 600;

export interface AskPayload {
	id: string;
	title: string;
	detail: string;
	why?: string;
	where?: string;
	options: readonly { key: string; label: string }[];
}

export interface ChatUi {
	setTopic(text: string): void;
	pushDelta(text: string): void;
	startTurn(): void;
	endTurn(summary: string): void;
	setStatus(text: string): void;
	setError(text: string): void;
	/** 工具中间态：null 收起。带秒数——她在看屏幕时一动不动的 40 秒，靠这行证明人还在。 */
	setBusy(label: string | null): void;
	/** 她要看/写/跑命令，在等一个答复（ADR-0045）。 */
	showAsk(ask: AskPayload): void;
	hideAsk(): void;
}

/** 要发给她的一张图：页面只负责把字节读出来，怎么送是别人的事。 */
export interface IncomingImage {
	/** data URL（data:image/png;base64,…）。 */
	data: string;
	name: string;
	/** 他顺手打的那句话，可能为空。 */
	text: string;
}

export interface UiOptions {
	onSay(text: string): void;
	/** 他选了 / 粘贴了 / 拖进来一张图。 */
	onImage?(image: IncomingImage): void;
	/** 字幕条出现/消失/变高时叫一声：窗口要跟着改「哪儿吃鼠标」。 */
	onLayout?(): void;
	onQuit?(): void;
	/** 他点了卡片上的某个按钮。 */
	onAnswer?(id: string, choice: "yes" | "always" | "no"): void;
}

export function mountUi(options: UiOptions): ChatUi {
	const caption = document.querySelector<HTMLDivElement>("#caption");
	const topic = document.querySelector<HTMLDivElement>("#topic");
	const said = document.querySelector<HTMLDivElement>("#said");
	const input = document.querySelector<HTMLInputElement>("#input");
	const send = document.querySelector<HTMLButtonElement>("#send");
	const pick = document.querySelector<HTMLButtonElement>("#pick");
	const file = document.querySelector<HTMLInputElement>("#file");
	const quit = document.querySelector<HTMLButtonElement>("#quit");
	const status = document.querySelector<HTMLDivElement>("#status");
	// 名字别叫 busy：下面那个 busy 是「这一轮还没说完」，两回事。
	const busyBar = document.querySelector<HTMLDivElement>("#busy");
	const busyText = busyBar?.querySelector<HTMLSpanElement>("span") ?? null;
	const ask = document.querySelector<HTMLDivElement>("#ask");
	const askTitle = document.querySelector<HTMLDivElement>("#ask-title");
	const askDetail = document.querySelector<HTMLDivElement>("#ask-detail");
	const askWhy = document.querySelector<HTMLDivElement>("#ask-why");
	const askButtons = document.querySelector<HTMLDivElement>("#ask-buttons");
	if (
		caption === null ||
		topic === null ||
		said === null ||
		input === null ||
		send === null ||
		pick === null ||
		file === null ||
		status === null ||
		busyBar === null ||
		busyText === null ||
		ask === null ||
		askTitle === null ||
		askDetail === null ||
		askWhy === null ||
		askButtons === null
	) {
		throw new Error("界面结构不对：index.html 里少了 caption / input / busy / ask 这些节点");
	}

	let buffer = "";
	let busy = false;

	// 工具中间态：一开始想着用 setTimeout 每 500 ms 重画，但工具一结束就得撤掉定时器，
	// 漏一次就有个定时器在后台陪着页面跑到关窗。所以标记位 + 一个常驻定时器，平时它闭嘴。
	let busyLabel: string | null = null;
	let busySince = 0;
	const paintBusy = (): void => {
		if (busyLabel === null) {
			busyBar.hidden = true;
			return;
		}
		const seconds = Math.floor((performance.now() - busySince) / 1000);
		busyText.textContent = busyLabel + (seconds >= 3 ? " · " + String(seconds) + " 秒" : "");
		busyBar.hidden = false;
	};
	window.setInterval(paintBusy, 500);

	let askId: string | null = null;

	const paint = (): void => {
		const text = buffer.length > MAX_SAID ? "…" + buffer.slice(-MAX_SAID) : buffer;
		said.textContent = text;
		caption.hidden = text.length === 0;
		options.onLayout?.();
	};

	const submit = (): void => {
		const text = input.value.trim();
		if (text.length === 0 || busy) return;
		input.value = "";
		buffer = "";
		said.classList.remove("thinking");
		caption.hidden = false;
		topic.textContent = "你";
		paint();
		options.onSay(text);
	};

	/**
	 * 发图：她看不了图（说话的那个模型是纯文本），图得先过眼睛——那一步在 daemon 里做。
	 * 页面只管把字节读成 data URL 递过去；顺手打的那句话一起带上，当图的注解。
	 */
	const sendImage = (chosen: File): void => {
		if (busy || options.onImage === undefined) return;
		if (!chosen.type.startsWith("image/")) {
			status.textContent = "这个不是图";
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const data = typeof reader.result === "string" ? reader.result : "";
			if (data.length === 0) return;
			const text = input.value.trim();
			input.value = "";
			buffer = text.length > 0 ? "［图］" + text : "［图］";
			said.classList.remove("thinking");
			caption.hidden = false;
			topic.textContent = "你";
			paint();
			options.onImage?.({ data, name: chosen.name, text });
		};
		reader.readAsDataURL(chosen);
	};

	send.addEventListener("click", submit);
	pick.addEventListener("click", () => file.click());
	file.addEventListener("change", () => {
		const chosen = file.files?.[0];
		file.value = "";
		if (chosen !== undefined) sendImage(chosen);
	});
	// 截完图 Ctrl+V 是最顺的一条路；从资源管理器直接拖进窗口也算。
	window.addEventListener("paste", (event: ClipboardEvent) => {
		for (const item of Array.from(event.clipboardData?.items ?? [])) {
			if (!item.type.startsWith("image/")) continue;
			const chosen = item.getAsFile();
			if (chosen === null) continue;
			event.preventDefault();
			sendImage(chosen);
			return;
		}
	});
	window.addEventListener("dragover", (event: DragEvent) => event.preventDefault());
	window.addEventListener("drop", (event: DragEvent) => {
		const chosen = event.dataTransfer?.files?.[0];
		if (chosen === undefined) return;
		event.preventDefault();
		sendImage(chosen);
	});
	input.addEventListener("keydown", (event: KeyboardEvent) => {
		if (event.key === "Enter" && !event.isComposing) {
			event.preventDefault();
			submit();
		}
	});
	quit?.addEventListener("click", () => options.onQuit?.());

	return {
		setTopic(text: string): void {
			topic.textContent = text;
		},
		pushDelta(text: string): void {
			buffer += text;
			paint();
		},
		startTurn(): void {
			buffer = "";
			said.classList.add("thinking");
			said.textContent = "（在想…）";
			caption.hidden = false;
			topic.textContent = "伊里斯";
			busy = true;
			input.placeholder = "她在说…";
			options.onLayout?.();
		},
		endTurn(summary: string): void {
			said.classList.remove("thinking");
			paint();
			busy = false;
			input.placeholder = "跟她说点什么…";
			status.textContent = summary;
		},
		setStatus(text: string): void {
			status.textContent = text;
		},
		setError(text: string): void {
			said.classList.remove("thinking");
			said.textContent = text;
			caption.hidden = false;
			topic.textContent = "出错了";
			busy = false;
			input.placeholder = "跟她说点什么…";
			options.onLayout?.();
		},
		setBusy(label: string | null): void {
			if (label === busyLabel) return;
			busyLabel = label;
			busySince = performance.now();
			paintBusy();
			options.onLayout?.();
		},
		showAsk(payload: AskPayload): void {
			askId = payload.id;
			askTitle.textContent = payload.title;
			askDetail.textContent = payload.detail;
			const where = payload.where === undefined ? "" : payload.where;
			askWhy.textContent = [where, payload.why ?? ""].filter((part) => part.length > 0).join(" · ");
			askWhy.hidden = askWhy.textContent.length === 0;
			askButtons.textContent = "";
			for (const option of payload.options) {
				const button = document.createElement("button");
				button.type = "button";
				button.textContent = option.label;
				button.dataset.key = option.key;
				button.addEventListener("click", () => {
					if (askId !== payload.id) return;
					// 点过就把这张卡片锁住：daemon 那边可能还要几十毫秒才发现，连点两下会发两次。
					for (const other of askButtons.querySelectorAll("button")) {
						other.disabled = true;
					}
					button.classList.add("picked");
					options.onAnswer?.(payload.id, option.key as "yes" | "always" | "no");
				});
				askButtons.appendChild(button);
			}
			ask.hidden = false;
			options.onLayout?.();
		},
		hideAsk(): void {
			if (askId === null) return;
			askId = null;
			ask.hidden = true;
			askButtons.textContent = "";
			options.onLayout?.();
		},
	};
}
