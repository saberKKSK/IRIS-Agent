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

const ui = mountUi({
	onSay(text: string): void {
		if (bridge === null) return;
		void bridge.say(text).then((result) => {
			if (!result.ok) ui.setError("发不出去：" + (result.reason ?? "daemon 没在跑？"));
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
	shell.setRegion([stage.bodyBox(), boxOf(grip, 2), boxOf(caption, 6), boxOf(composer, 4)]);
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
			const seconds = (event.latencyMs / 1000).toFixed(1);
			const first = (event.firstTokenMs / 1000).toFixed(1);
			ui.endTurn("首字 " + first + "s · 整轮 " + seconds + "s · " + event.effort);
			break;
		}
		case "tool":
			if (event.phase === "start") ui.setStatus("在用 " + event.toolName + "…");
			break;
		case "compact":
			ui.setStatus("上下文压掉 " + String(event.dropped) + " 条");
			break;
		case "error":
			streaming = false;
			stage.setTalking(false);
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
