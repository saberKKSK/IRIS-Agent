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
	getParameterCount(): number;
	getParameterId(index: number): unknown;
	setParameterValueByIndex(index: number, value: number, weight?: number): void;
};

/**
 * 参数名 → 下标。
 *
 * 这个 fork 的 setParameterValueById(id) 只认 CubismId **对象**：它的 getParameterIndex
 * 拿传进来的字符串跟 _parameterIds.at(i)（CubismId 实例）做 != 比较，永远不等，于是
 * 悄悄在 _notExistParameterId 里编一个新下标、把值写进一张假表——读回来是自己刚写的数，
 * 真模型一个参数都没动（2026-11-10 实测：写 ParamMouthOpenY=1、ParamEyeLOpen=0、
 * ParamAngleZ=25，眼睛照睁、嘴照闭、头照直）。所以这里自己按 index 建表。
 */
function buildParams(core: CoreModel): Map<string, number> {
	const map = new Map<string, number>();
	const count = core.getParameterCount();
	for (let i = 0; i < count; i += 1) {
		const raw = core.getParameterId(i) as { getString?: () => { s?: string } } | undefined;
		const name = raw?.getString?.()?.s;
		if (typeof name === "string") map.set(name, i);
	}
	return map;
}

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
	/** 参数名 → 下标（fork 只认 CubismId 对象，字符串 id 会静默失效，见 buildParams 注释）。 */
	private params: Map<string, number> | null = null;
	/** 表情的当前值 / 目标值（参数名 → 数值），以及 exp3.json 的解析缓存。 */
	private exprValues = new Map<string, number>();
	private exprTargets = new Map<string, number>();
	private exprCache = new Map<string, Map<string, number>>();
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
			dpr: this.dpr(),
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
		// 舞台的坐标是设备像素，窗口要的是 DIP（= CSS px），换回去。
		const dpr = this.dpr();
		const padX = 14;
		const padTop = 56;
		const x = Math.max(0, Math.floor((b.minX - padX) / dpr));
		const y = Math.max(0, Math.floor((b.minY - padTop) / dpr));
		return {
			x,
			y,
			width: Math.min(Math.floor(app.screen.width / dpr) - x, Math.ceil((width + padX * 2) / dpr)),
			height: Math.min(Math.floor(app.screen.height / dpr) - y, Math.ceil((height + padTop) / dpr)),
		};
	}

	async mount(host: HTMLElement, options: StageOptions): Promise<void> {
		this.host = host;
		this.base = options.base.replace(/\/+$/u, "");
		this.status = options.onStatus ?? (() => {});
		this.bornAt = performance.now();
		this.lastDrive = this.bornAt;
		this.nextBlink = this.bornAt + 1400 + Math.random() * 2600;

		// 画布按「设备像素」开，不是按 CSS 像素：这台机器是 200% 缩放，开成 CSS 尺寸
		// 等于先画 520×840 再被浏览器拉大一倍，模型边缘糊成一片。
		// resolution 必须是 1 —— 这个 fork 用 renderer.width（画布真实像素）设 GL
		// viewport，却用 renderer.screen（CSS 尺寸）算投影矩阵；resolution=2 时两者差
		// 一倍，人被画成一半大、挤在左下角。这里让 screen 直接等于真实像素，再把 CSS
		// 尺寸交给样式表（100%），浏览器按 1:1 显示。
		const dpr = this.dpr();
		const app = new Application();
		await app.init({
			width: Math.max(1, Math.round(host.clientWidth * dpr)),
			height: Math.max(1, Math.round(host.clientHeight * dpr)),
			backgroundAlpha: 0,
			antialias: true,
			autoDensity: false,
			resolution: 1,
			preference: "webgl",
		});
		app.canvas.style.width = "100%";
		app.canvas.style.height = "100%";
		host.appendChild(app.canvas);
		this.app = app;

		Live2DModel.registerTicker(Ticker);

		const url = this.base + "/" + encodeURIComponent(MODEL_FILE);
		this.status("加载模型…");
		const model = await Live2DModel.from(url, { autoInteract: false, autoUpdate: true });
		this.model = model;
		const internal = internalOf(model);
		this.core = internal.coreModel as unknown as CoreModel;
		this.params = buildParams(this.core);

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
		window.addEventListener("resize", () => this.syncSize());
		new ResizeObserver(() => this.syncSize()).observe(host);
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

	/**
	 * 切换表情（id 见 model3 的 Expressions，比如 blush / heart_eyes / dark_face）。
	 *
	 * 不调 fork 的 model.expression()：那个 ExpressionManager 是「加在上一张脸上」的语义，
	 * 连开几个之后 key1..key13 会全部留在 1（作者用这些 key 当部件开关），眼睛被一层层
	 * 遮罩盖住，实测变成两个灰洞、调 body_default 也回不来。这里自己读 exp3.json、
	 * 互斥地写这些开关参数，没被这张表情用到的 key 一律收回 0。
	 */
	async setExpression(id: string): Promise<void> {
		const targets = await this.loadExpression(id);
		if (targets === null) return;
		const names = new Set<string>([...this.exprValues.keys(), ...this.exprTargets.keys(), ...targets.keys()]);
		const next = new Map<string, number>();
		for (const name of names) {
			next.set(name, targets.get(name) ?? 0);
			if (!this.exprValues.has(name)) this.exprValues.set(name, 0);
		}
		this.exprTargets = next;
	}

	/** 读一张表情的 exp3.json，缓存下来；模型里没这张就返回 null。 */
	private async loadExpression(id: string): Promise<Map<string, number> | null> {
		const cached = this.exprCache.get(id);
		if (cached !== undefined) return cached;
		const settings = (
			this.model as unknown as {
				internalModel?: { settings?: { expressions?: { Name?: string; File?: string }[] } };
			} | null
		)?.internalModel?.settings?.expressions;
		const entry = settings?.find((item) => item.Name === id);
		if (entry?.File === undefined) return null;
		const url = this.base + "/" + entry.File.split("/").map((part) => encodeURIComponent(part)).join("/");
		const response = await fetch(url);
		if (!response.ok) return null;
		const json = (await response.json()) as { Parameters?: { Id?: string; Value?: number }[] };
		const values = new Map<string, number>();
		for (const item of json.Parameters ?? []) {
			if (typeof item.Id === "string" && typeof item.Value === "number") values.set(item.Id, item.Value);
		}
		this.exprCache.set(id, values);
		return values;
	}

	/** 这块屏幕的像素比（200% 缩放是 2）。 */
	private dpr(): number {
		return Math.max(1, Math.min(3, window.devicePixelRatio || 1));
	}

	/** 画布跟着 #stage 的 CSS 尺寸走，换算成设备像素。 */
	private syncSize(): void {
		const app = this.app;
		const host = this.host;
		if (app === null || host === null) return;
		const dpr = this.dpr();
		const w = Math.max(1, Math.round(host.clientWidth * dpr));
		const h = Math.max(1, Math.round(host.clientHeight * dpr));
		if (app.renderer.screen.width === w && app.renderer.screen.height === h) return;
		app.renderer.resize(w, h);
		app.canvas.style.width = "100%";
		app.canvas.style.height = "100%";
		this.layout();
	}

	private layout(): void {
		const app = this.app;
		const model = this.model;
		if (app === null || model === null) return;
		const dpr = this.dpr();
		const w = app.screen.width;
		const h = app.screen.height;
		if (w <= 0 || h <= 0) return;
		this.laidW = w;
		this.laidH = h;
		// 底下那条字幕/输入条大约 96 CSS px，人别站到它后面去；脚贴底边留一点余量。
		const usable = Math.max(240 * dpr, h - 96 * dpr);
		const scale = usable / Math.max(1, internalOf(model).originalHeight ?? 1);
		model.scale.set(scale);
		model.x = w / 2;
		model.y = h - 56 * dpr;
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
		// 窗口 show 出来后尺寸才定，ResizeObserver 偶尔漏一拍，每帧比一下最省事。
		const app = this.app;
		if (app !== null && (app.screen.width !== this.laidW || app.screen.height !== this.laidH)) this.layout();
		const k = 0.14;
		this.focus.x += (this.gaze.x - this.focus.x) * k;
		this.focus.y += (this.gaze.y - this.focus.y) * k;
	}

	/** 按名字写一个参数（名字不存在就当没这个参数）。 */
	private put(name: string, value: number): void {
		const core = this.core;
		const index = this.params?.get(name);
		if (core === null || index === undefined) return;
		core.setParameterValueByIndex(index, value, 1);
	}

	private drive(): void {
		if (this.core === null || this.params === null) return;
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

		this.put("ParamBodyAngleZ", bodyZ);
		this.put("ParamBodyAngleX", bodyX);
		this.put("ParamAngleZ", angleZ);

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

		// 视线：这个 fork 的 model.focus(x, y) 要的是 Pixi 世界坐标，传 -1..1 会被
		// toModelPosition 折算到模型中心附近，等于没动（2026-11-10 实测：光标拉到屏幕两端，
		// 头一毫米都不转）。这里直接写角度——写在 updateFocus/physics 之后，谁也盖不掉。
		this.put("ParamAngleX", this.focus.x * 26);
		this.put("ParamAngleY", this.focus.y * 20);
		this.put("ParamEyeBallX", this.focus.x);
		this.put("ParamEyeBallY", this.focus.y);

		this.put("ParamEyeLOpen", eye);
		this.put("ParamEyeROpen", eye);

		// 口型：先在包络上凑合，TTS 进来后换成 AudioAnalyzer 的真 RMS
		const target = this.talking
			? 0.24 + 0.3 * (0.5 + 0.5 * Math.sin(t * 13.7)) * (0.55 + 0.45 * Math.sin(t * 4.1 + 1.2))
			: 0;
		this.mouth += (target - this.mouth) * Math.min(1, dt * 18);
		this.put("ParamMouthOpenY", Math.max(0, Math.min(0.85, this.mouth)));

		// 表情：这些开关参数（key*/Clothes*/Movement*）没人跟我们抢，淡过去就行
		if (this.exprTargets.size > 0) {
			const k = Math.min(1, dt * 6);
			for (const [name, goal] of this.exprTargets) {
				const current = this.exprValues.get(name) ?? 0;
				const next = current + (goal - current) * k;
				this.exprValues.set(name, next);
				this.put(name, next);
			}
		}
	}
}
