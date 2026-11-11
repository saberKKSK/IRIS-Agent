import { currentWindow } from "mygo-runtime";

import { Bridge, type BridgeEvent } from "./bridge";
import { Shell as GoShell } from "./mygo";
import { Shell, boxOf } from "./shell";
import { Stage } from "./stage";
import { mountUi } from "./ui";

const host = document.querySelector<HTMLDivElement>("#stage");
if (host === null) throw new Error("找不到 #stage");

const shell = new Shell();
const stage = new Stage();
let bridge: Bridge | null = null;
let streaming = false;

/** 工具名 -> 人话。她看屏幕时要 40 秒，页面上得有一句「在看你的屏幕」而不是干等着。 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
	look_at_screen: "在看你的屏幕",
	look_at_image: "在看那张图",
	web_search: "在上网查",
	web_fetch: "在翻网页",
	ls: "在看文件夹",
	read: "在读文件",
	grep: "在翻找内容",
	write_file: "在写文件",
	append_file: "在往后加内容",
	make_dir: "在建文件夹",
	move_path: "在给东西搬家",
	request_access: "在等你点头（看）",
	request_write: "在等你点头（写）",
	run_command: "在跑命令",
	douyin_feed: "在刷",
	douyin_comments: "在看评论",
	douyin_reply: "在发评论",
	douyin_like: "在点爱心",
	douyin_im: "在看私信",
	douyin_dm: "在发私信",
};

/** 正在跑的工具（可能并行两件），栈顶那个决定中间态说什么。 */
const runningTools: string[] = [];
/** 有一张卡片在屏幕上等答复：这时候说什么都不如「在等你点头」。 */
let asking = false;

function refreshBusy(): void {
	if (asking) {
		ui.setBusy("在等你点头");
		return;
	}
	const top = runningTools.at(-1);
	ui.setBusy(top === undefined ? null : (TOOL_LABELS[top] ?? "在用 " + top));
}

const ui = mountUi({
	onSay(text: string): void {
		if (bridge === null) return;
		void bridge.say(text).then((result) => {
			if (!result.ok) ui.setError("发不出去：" + (result.reason ?? "daemon 没在跑？"));
		});
	},
	onImage(image): void {
		if (bridge === null) return;
		// 图不会直接进对话（她说话的那个模型看不了图）：daemon 先让眼睛转述，再当他说的话交给她。
		ui.setStatus("图递过去了，她在看…");
		void bridge.image(image).then((result) => {
			if (!result.ok) ui.setError("图没递过去：" + (result.reason ?? "daemon 没在跑？"));
		});
	},
	onAnswer(id: string, choice: "yes" | "always" | "no"): void {
		if (bridge === null) return;
		void bridge.answer(id, choice).then((result) => {
			if (!result.ok) ui.setStatus("这个答复没送到：" + (result.reason ?? "?"));
		});
	},
	onLayout: () => reportRegion(),
	onQuit: () => {
		void currentWindow.close().catch(() => {});
	},
});

/**
 * 「哪儿吃鼠标」：她身子、顶部拖手、字幕条、输入条；别的地方（两侧透明区）
 * 让鼠标穿过去点到桌面。桌面宠物的关键就这一条。
 */
function reportRegion(): void {
	const caption = document.querySelector<HTMLElement>("#caption");
	const composer = document.querySelector<HTMLElement>("#composer");
	const grip = document.querySelector<HTMLElement>("#grip");
	const ask = document.querySelector<HTMLElement>("#ask");
	const boxes = [stage.bodyBox(), boxOf(grip, 2), boxOf(caption, 6), boxOf(composer, 4)];
	// 等答复的那张卡片也要吃鼠标，不然按钮点不动（窗口是按这几块切输入区的）
	if (ask !== null && !ask.hidden) boxes.push(boxOf(ask, 6));
	shell.setRegion(boxes);
}

const handle = (event: BridgeEvent): void => {
	switch (event.type) {
		case "hello":
			ui.setStatus("连上了 · " + event.model);
			break;
		case "delta":
			if (!streaming) {
				streaming = true;
				stage.setTalking(true);
				// 一轮的头一句：先把字幕清干净再往里追加。少了这一句，上一轮的话
				// 会被这一轮接在后面（用输入框发的时候 buffer 在提交时清过，所以只有
				// 程序发起的轮次看得出这个 bug）。顺带把输入框锁上。
				ui.startTurn();
			}
			ui.pushDelta(event.text);
			break;
		case "expression":
			// 她在正文最前面写了 `<脸红>`：核心层已经把这个标记摘掉了，这里只管换脸（ADR-0041）。
			void stage.setExpression(event.id).catch(() => {});
			break;
		case "turn": {
			streaming = false;
			stage.setTalking(false);
			// 一轮结束了就别再挂中间态：tool_end 少一条（工具抛了、或事件丢了）时
			// 栈会把「在上网查」永远留在画面上，下一轮一开始就说不清了。
			runningTools.length = 0;
			refreshBusy();
			const seconds = (event.latencyMs / 1000).toFixed(1);
			const first = (event.firstTokenMs / 1000).toFixed(1);
			ui.endTurn("首字 " + first + "s · 整轮 " + seconds + "s · " + event.effort);
			break;
		}
		case "tool":
			if (event.phase === "start") {
				runningTools.push(event.toolName);
			} else {
				const at = runningTools.lastIndexOf(event.toolName);
				if (at >= 0) runningTools.splice(at, 1);
				if (event.isError === true) ui.setStatus(event.toolName + " 没成");
			}
			refreshBusy();
			break;
		case "ask":
			// 她要碰文件 / 写 / 跑命令：问题落到窗口里，他点了才回来（ADR-0045）。
			if (event.phase === "ask" && event.options !== undefined) {
				asking = true;
				refreshBusy();
				ui.showAsk({
					id: event.id,
					title: event.title ?? "她想动点东西",
					detail: event.detail ?? "",
					...(event.why === undefined ? {} : { why: event.why }),
					...(event.where === undefined ? {} : { where: event.where }),
					options: event.options,
				});
			} else {
				asking = false;
				ui.hideAsk();
				if (event.phase === "timeout") ui.setStatus("等太久，按不给处理了");
				refreshBusy();
			}
			break;
		case "compact":
			ui.setStatus("上下文压掉 " + String(event.dropped) + " 条");
			break;
		case "error":
			streaming = false;
			stage.setTalking(false);
			runningTools.length = 0;
			refreshBusy();
			ui.setError(event.message);
			break;
	}
};

async function boot(): Promise<void> {
	const env = await shell.load();
	try {
		await stage.mount(host as HTMLDivElement, { base: env.modelBase, onStatus: (text) => ui.setStatus(text) });
	} catch (error) {
		(window as unknown as { __irisError?: unknown }).__irisError = error;
		console.error(error);
		ui.setError("模型没加载起来：" + (error instanceof Error ? error.message : String(error)));
		return;
	}
	reportRegion();
	window.setInterval(reportRegion, 500);
	window.addEventListener("resize", reportRegion);

	bridge = new Bridge(env.apiBase);
	bridge.open({
		onEvent: handle,
		onLink: (state) => {
			ui.setStatus(state === "online" ? "连上了" : "在重连 daemon…");
		},
	});
	ui.setStatus("模型好了");
}

// 她看着鼠标 —— 位置由 Go 报过来（光标相对窗口中心，-1..1）。
//
// 不能靠页面的 pointermove：窗口大部分是点击穿透的，指针压在那上面时页面
// 根本收不到事件，她的头就会停在最后一次「路过」的方向上（之前一直抬着头
// 就是这个）。Go 那边直接问 Windows 光标在哪，指到哪儿看到哪儿。
setInterval(() => {
	void GoShell.gaze()
		.then((gaze) => stage.followPointer(gaze.x, gaze.y))
		.catch(() => {});
}, 100);

// 把她此刻的心情报给 daemon（ADR-0044）：内核每轮把它拼成一句话贴在对方那句末尾，
// prompt 里「## 你的心情」那一段教她带着它说话。平静的时候 daemon 会自己闭嘴。
setInterval(() => {
	if (bridge === null) return;
	void bridge.mood(stage.moodSnapshot()).catch(() => {});
}, 2000);

/** 这一处（或它上面的某一层）是不是拖窗区：CSS 里写着 `--app-region: drag`。 */
function draggable(node: EventTarget | null): Element | null {
	for (let el = node instanceof Element ? node : null; el !== null; el = el.parentElement) {
		const region = getComputedStyle(el).getPropertyValue("--app-region").trim();
		if (region === "drag") return el;
		if (region === "no-drag") return null;
	}
	return null;
}

/**
 * 拖窗：按在顶部那条 grip 或字幕条上，指针一动就把位移交给 Go 让窗口跟上。
 *
 * 不用 CSS 的 `--app-region: drag` 让 MyGo 走 Windows 的标题栏移动循环 ——
 * 那条路上鼠标捕获在 WebView2 的子窗口手里，循环等不到位移，窗口纹丝不动。
 * 捕获在页面手里，页面就把位移自己算出来。
 */
let dragFrom: { x: number; y: number } | null = null;

/** 输入框和按钮自己要用鼠标，别的地方按下去都算拖窗。 */
function interactive(node: EventTarget | null): Element | null {
	if (!(node instanceof Element)) return null;
	return node.closest("#composer, button, input, textarea, a, select");
}

window.addEventListener(
	"pointerdown",
	(event: PointerEvent) => {
		if (event.button !== 0) return;
		const element = draggable(event.target);
		// 人物身上按下去也要能拖：舞台是 pointer-events: none，事件落在 body
		// 上，谁都匹配不到，于是「窗口拖不动」。
		if (element === null && interactive(event.target) !== null) return;
		dragFrom = { x: event.screenX, y: event.screenY };
		(element ?? document.body).setPointerCapture?.(event.pointerId);
		event.preventDefault();
	},
	true,
);

window.addEventListener("pointermove", (event: PointerEvent) => {
	if (dragFrom === null) return;
	const dx = event.screenX - dragFrom.x;
	const dy = event.screenY - dragFrom.y;
	if (dx === 0 && dy === 0) return;
	dragFrom = { x: event.screenX, y: event.screenY };
	void GoShell.moveBy(dx, dy).catch(() => {});
});

for (const name of ["pointerup", "pointercancel"]) {
	window.addEventListener(name, () => {
		dragFrom = null;
	});
}

window.addEventListener("keydown", (event: KeyboardEvent) => {
	if (event.key === "Escape") void currentWindow.minimize().catch(() => {});
});

void boot();
