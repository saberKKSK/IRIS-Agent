import { Live2DModel } from "@naari3/pixi-live2d-display/cubism5";
import { Application, Graphics, Ticker } from "pixi.js";

/**
 * 大肥鱼的驱动层。
 *
 * 动作文件只有一套特效（vfx_ambient）和一组道具开关，没有呼吸、眨眼、视线——
 * 这些全部在这里程序化生成（ADR-0039）：
 *   呼吸  ParamBodyAngleZ / ParamBodyAngleX 低频正弦
 *   眨眼  ParamEyeLOpen / ParamEyeROpen 随机间隔，说话时不眨
 *   视线  model.focus()，指针在窗口里指哪儿看哪儿
 *   说话  头微侧 + ParamMouthOpenY 按包络起伏（等 TTS 接进来换成 AudioAnalyzer）
 */

/** 模型文件名（生成的 model3，原始那个没有 expressions/motions）。 */
const MODEL_FILE = "大肥鱼.iris.model3.json";
const DEG = Math.PI / 180;

type CoreModel = {
	setParameterValueById(id: string, value: number, weight?: number): void;
};

/** 这个 fork 的 internalModel 在 d.ts 里是可选的、也缺 renderer，这里补上我们真用到的部分。 */
type InternalLike = {
	coreModel: unknown;
	renderer: unknown;
	originalWidth?: number;
	originalHeight?: number;
	draw(gl: WebGL2RenderingContext): void;
	on(event: string, listener: () => void): void;
};

function internalOf(model: Live2DModel): InternalLike {
	const internal = (model as unknown as { internalModel?: InternalLike }).internalModel;
	if (internal === undefined) throw new Error("这个 fork 的模型没有 internalModel");
	return internal;
}

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface StageOptions {
	/** 模型根 URL，末尾不带斜杠。MyGo 里是 live2d://localhost，浏览器里是 /live2d。 */
	base: string;
	onStatus?: (text: string) => void;
}

export class Stage {
	private app: Application | null = null;
	private host: HTMLElement | null = null;
	private model: Live2DModel | null = null;
	private core: CoreModel | null = null;
	private status: (text: string) => void = () => {};
	private base = "/live2d";

	/** 指针给的目标（-1..1），以及缓动后的现值。 */
	private gaze = { x: 0, y: 0 };
	private focus = { x: 0, y: 0 };
	private mouth = 0;
	private talking = false;
	private tilt = 0;
	private tiltTarget = 0;
	private nextBlink = 0;
	private blinkAt = -1;
	private bornAt = performance.now();
	private lastDrive = performance.now();
	/** 上一次排版时的画布尺寸（窗口从 0 长到真实尺寸时要重排，否则人缩在左下角）。 */
	private laidW = -1;
	private laidH = -1;

	get ready(): boolean {
		return this.model !== null;
	}

	/** 排查用：往舞台上糊一个红方块，确认 Pixi 这一层到底画不画。 */
	debugRect(): void {
		const app = this.app;
		if (app === null) return;
		const g = new Graphics();
		g.rect(40, 40, 260, 260).fill(0xff2244);
		app.stage.addChild(g);
	}

	/** 排查用：模型摆在哪、比例多少、屏幕多大。 */
	diagnostics(): Record<string, unknown> {
		const app = this.app;
		const model = this.model;
		if (app === null || model === null) return { mounted: false };
		return {
			mounted: true,
			screen: [app.screen.width, app.screen.height],
			canvas: [app.canvas.width, app.canvas.height],
			position: [model.x, model.y],
			scale: [model.scale.x, model.scale.y],
			size: [model.width, model.height],
			original: [
				(model.internalModel as unknown as { originalWidth?: number }).originalWidth,
				(model.internalModel as unknown as { originalHeight?: number }).originalHeight,
			],
			visible: model.visible,
			alpha: model.alpha,
			stageChildren: app.stage.children.length,
		};
	}

	/** 她在窗口里占的那一块，用来告诉窗口「这儿吃鼠标，别的地方放过去」。 */
	bodyBox(): Box | null {
		const app = this.app;
		const model = this.model;
		if (app === null || model === null) return null;
		const b = model.getBounds() as { minX: number; minY: number; maxX: number; maxY: number };
		const width = b.maxX - b.minX;
		const height = b.maxY - b.minY;
		if (!(width > 0) || !(height > 0)) return null;
		const padX = 14;
		const padTop = 56;
		const x = Math.max(0, Math.floor(b.minX - padX));
		const y = Math.max(0, Math.floor(b.minY - padTop));
		return {
			x,
			y,
			width: Math.min(app.screen.width - x, Math.ceil(width + padX * 2)),
			height: Math.min(app.screen.height - y, Math.ceil(height + padTop)),
		};
	}

	async mount(host: HTMLElement, options: StageOptions): Promise<void> {
		this.host = host;
		this.base = options.base.replace(/\/+$/u, "");
		this.status = options.onStatus ?? (() => {});
		this.bornAt = performance.now();
		this.lastDrive = this.bornAt;
		this.nextBlink = this.bornAt + 1400 + Math.random() * 2600;

		const app = new Application();
		await app.init({
			resizeTo: host,
			backgroundAlpha: 0,
			antialias: true,
			autoDensity: true,
			// 必须是 1：这个 fork 用 renderer.screen（CSS 尺寸）设 gl.viewport，
			// 一旦 canvas 后备缓冲是它的 2 倍，人就被画成一半大、挤在左下角。
			resolution: 1,
			preference: "webgl",
		});
		host.appendChild(app.canvas);
		this.app = app;

		Live2DModel.registerTicker(Ticker);

		const url = this.base + "/" + encodeURIComponent(MODEL_FILE);
		this.status("加载模型…");
		const model = await Live2DModel.from(url, { autoInteract: false, autoUpdate: true });
		this.model = model;
		const internal = internalOf(model);
		this.core = internal.coreModel as unknown as CoreModel;

		// 默认的「贴图版遮罩」在 Pixi v8 这里画不出来（嘴巴/口内整块糊在脸上，边缘也带白边），
		// 换成高精度遮罩（逐 drawable 的裁剪矩阵）就正常了。这个 fork 没暴露 setter，只能写字段。
		const renderer = internal.renderer as { _useHighPrecisionMask?: boolean };
		renderer._useHighPrecisionMask = true;

		// 这个 fork 的绘制回调（_onRenderCallback）先读 model.renderer，没有就退到
		// globalThis.app / window.app。我们两样都没给 → 它每帧第一句就 return，
		// 于是模型在、纹理在、GL 没报错，画面却一个像素都没有。必须显式塞 renderer 进去。
		(model as unknown as { setRenderer(r: unknown): void }).setRenderer(app.renderer);

		// Cubism 画完之后把 gl.clearColor 留在 (1,1,1,1)，Pixi 下一帧清屏就照着白清 ——
		// 画布变成一整块不透明白底（模型边缘还会带白边）。每帧画完把清屏色还原成透明。
		const rawDraw = internal.draw.bind(internal);
		internal.draw = (gl: WebGL2RenderingContext): void => {
			rawDraw(gl);
			gl.clearColor(0, 0, 0, 0);
		};

		app.stage.addChild(model);
		this.layout();

		// 每帧在 model.update() 之前写参数：这一层压在 motion / physics 之上，
		// 我们说了算；但只在没有动作文件动这些参数的时候才成立（现在没有）。
		internal.on("beforeModelUpdate", () => this.drive());

		(window as unknown as { __stage?: unknown }).__stage = this;
		window.addEventListener("resize", () => this.layout());
		new ResizeObserver(() => this.layout()).observe(host);
		app.ticker.add(() => this.updateFocus());
		this.status("");
	}

	/** 指针位置（-1..1，屏幕中心是 0）；上方为负。 */
	followPointer(nx: number, ny: number): void {
		this.gaze.x = Math.max(-1, Math.min(1, nx));
		this.gaze.y = Math.max(-1, Math.min(1, -ny));
	}

	setTalking(on: boolean): void {
		this.talking = on;
		if (on) {
			this.blinkAt = -1;
			this.tiltTarget = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 2.5);
			this.nextBlink = Number.POSITIVE_INFINITY;
		} else {
			this.tiltTarget = 0;
			this.blinkAt = -1;
			this.nextBlink = performance.now() + 900 + Math.random() * 2200;
			this.mouth = 0;
		}
	}

	/** 切换表情（表达式 id 见 model3 的 Expressions）。失败就当没这个表情。 */
	async setExpression(id: string): Promise<void> {
		const model = this.model;
		if (model === null) return;
		try {
			await model.expression(id);
		} catch {
			/* 模型里没有这个表情，忽略 */
		}
	}

	private layout(): void {
		const app = this.app;
		const model = this.model;
		if (app === null || model === null) return;
		const w = app.screen.width;
		const h = app.screen.height;
		if (w <= 0 || h <= 0) return;
		this.laidW = w;
		this.laidH = h;
		// 底下那条字幕/输入条大约 96 px，人别站到它后面去；脚贴底边留一点余量。
		const usable = Math.max(240, h - 96);
		const scale = usable / Math.max(1, internalOf(model).originalHeight ?? 1);
		model.scale.set(scale);
		model.x = w / 2;
		model.y = h - 56;
		const anchor = (model as unknown as { anchor?: { set(x: number, y: number): void } }).anchor;
		if (anchor !== undefined && typeof anchor.set === "function") {
			anchor.set(0.5, 1);
		} else {
			model.x -= model.width / 2;
			model.y -= model.height;
		}
	}

	private updateFocus(): void {
		const model = this.model;
		if (model === null) return;
		// Pixi 的 resizeTo 只在 ResizeObserver 里改 renderer.screen；窗口 show 出来之后
		// 尺寸才定，所以每帧比一下最省事。
		const app = this.app;
		if (app !== null && (app.screen.width !== this.laidW || app.screen.height !== this.laidH)) this.layout();
		const k = 0.14;
		this.focus.x += (this.gaze.x - this.focus.x) * k;
		this.focus.y += (this.gaze.y - this.focus.y) * k;
		try {
			model.focus(this.focus.x, this.focus.y);
		} catch {
			/* focus 不是必需能力，抛了就算了 */
		}
	}

	private drive(): void {
		const core = this.core;
		if (core === null) return;
		const now = performance.now();
		const dt = Math.min(0.1, Math.max(0, (now - this.lastDrive) / 1000));
		this.lastDrive = now;
		const t = (now - this.bornAt) / 1000;

		// 呼吸：两个不同周期叠着，看不出节拍
		const bodyZ = Math.sin((t * 2 * Math.PI) / 3.9) * 1.15;
		const bodyX = Math.sin((t * 2 * Math.PI) / 6.3) * 0.75;

		// 说话时头微侧，300ms 缓过去
		this.tilt += (this.tiltTarget - this.tilt) * Math.min(1, dt * 6);
		const angleZ = Math.sin((t * 2 * Math.PI) / 5.1) * 0.7 + this.tilt;

		core.setParameterValueById("ParamBodyAngleZ", bodyZ);
		core.setParameterValueById("ParamBodyAngleX", bodyX);
		core.setParameterValueById("ParamAngleZ", angleZ);

		// 眨眼：随机间隔，偶尔连眨两下；说话时不眨
		let eye = 1;
		if (!this.talking) {
			if (this.blinkAt < 0 && now >= this.nextBlink) {
				this.blinkAt = now;
				const double = Math.random() < 0.18;
				this.nextBlink = now + (double ? 260 : 2400 + Math.random() * 4200);
			}
			if (this.blinkAt >= 0) {
				const p = (now - this.blinkAt) / 150;
				if (p >= 1) {
					this.blinkAt = -1;
					if (this.nextBlink - now > 2000) this.nextBlink = now + 2400 + Math.random() * 4200;
				} else {
					eye = p < 0.45 ? 1 - (p / 0.45) * 1.0 : (p - 0.45) / 0.55;
				}
			}
		}
		core.setParameterValueById("ParamEyeLOpen", eye);
		core.setParameterValueById("ParamEyeROpen", eye);

		// 口型：先在包络上凑合，TTS 进来后换成 AudioAnalyzer 的真 RMS
		const target = this.talking
			? 0.24 + 0.3 * (0.5 + 0.5 * Math.sin(t * 13.7)) * (0.55 + 0.45 * Math.sin(t * 4.1 + 1.2))
			: 0;
		this.mouth += (target - this.mouth) * Math.min(1, dt * 18);
		core.setParameterValueById("ParamMouthOpenY", Math.max(0, Math.min(0.85, this.mouth)));
	}
}
