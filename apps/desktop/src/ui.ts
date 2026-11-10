/** 字幕条 + 输入条。只碰 DOM，不知道模型和网络。 */

const MAX_SAID = 600;

export interface ChatUi {
	setTopic(text: string): void;
	pushDelta(text: string): void;
	startTurn(): void;
	endTurn(summary: string): void;
	setStatus(text: string): void;
	setError(text: string): void;
}

export interface UiOptions {
	onSay(text: string): void;
	/** 字幕条出现/消失/变高时叫一声：窗口要跟着改「哪儿吃鼠标」。 */
	onLayout?(): void;
	onQuit?(): void;
}

export function mountUi(options: UiOptions): ChatUi {
	const caption = document.querySelector<HTMLDivElement>("#caption");
	const topic = document.querySelector<HTMLDivElement>("#topic");
	const said = document.querySelector<HTMLDivElement>("#said");
	const input = document.querySelector<HTMLInputElement>("#input");
	const send = document.querySelector<HTMLButtonElement>("#send");
	const quit = document.querySelector<HTMLButtonElement>("#quit");
	const status = document.querySelector<HTMLDivElement>("#status");
	if (caption === null || topic === null || said === null || input === null || send === null || status === null) {
		throw new Error("界面结构不对：index.html 里少了 caption / input 这些节点");
	}

	let buffer = "";
	let busy = false;

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

	send.addEventListener("click", submit);
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
	};
}
