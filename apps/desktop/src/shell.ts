/** Go 那一半：daemon 地址、模型地址，以及「窗口哪儿吃鼠标」。 */

import { isMyGo } from "mygo-runtime";
import { Shell as GoShell, type Rect } from "./mygo";

export interface ShellEnv {
	apiBase: string;
	modelBase: string;
	platform: string;
	version: string;
	hosted: boolean;
}

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** 一个元素在窗口里的矩形，pad 是往外放一点（边缘点起来也算）。 */
export function boxOf(element: Element | null, pad = 0): Box | null {
	if (element === null) return null;
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return null;
	return {
		x: Math.max(0, Math.round(rect.left - pad)),
		y: Math.max(0, Math.round(rect.top - pad)),
		width: Math.round(rect.width + pad * 2),
		height: Math.round(rect.height + pad * 2),
	};
}

/** 浏览器里调版式时的退路：模型由 vite 的 /live2d 中间件给，daemon 在 5274。 */
const FALLBACK: ShellEnv = {
	apiBase: "http://127.0.0.1:5274",
	modelBase: "/live2d",
	platform: "web",
	version: "?",
	hosted: false,
};

export class Shell {
	hosted = false;
	private env: ShellEnv = FALLBACK;
	private sent = "";

	/** 问 Go 要 daemon 与模型的地址。不在 MyGo 里就返回浏览器调试用的默认值。 */
	async load(): Promise<ShellEnv> {
		if (!isMyGo()) {
			document.documentElement.classList.add("browser");
			return this.env;
		}
		this.hosted = true;
		document.documentElement.classList.add("hosted");
		try {
			this.env = await GoShell.env();
		} catch (error) {
			console.warn("拿不到 Go 那边的环境", error);
		}
		return this.env;
	}

	/** 把「这些矩形吃鼠标、其余地方放过去」告诉窗口。相同的不重复发。 */
	setRegion(boxes: (Box | null)[]): void {
		if (!this.hosted) return;
		const rects: Rect[] = [];
		for (const box of boxes) {
			if (box === null || box.width <= 0 || box.height <= 0) continue;
			rects.push({ x: box.x, y: box.y, width: box.width, height: box.height });
		}
		if (rects.length === 0) return;
		const key = JSON.stringify(rects);
		if (key === this.sent) return;
		this.sent = key;
		void GoShell.setInputRegion(rects).catch((error: unknown) => {
			console.warn("报输入区域失败", error);
		});
	}
}
