/**
 * 情绪状态机（ADR-0042）。
 *
 * 视频里那句批评正好戳中我们原来的做法：「从一个预设表情切到另一个预设表情……一句话结束
 * 表情立刻消失，回到没有上下文的初始状态」。所以这里不再让标记直接等于一张脸：
 * 她说 `<脸红>` 只是往「愉悦度 / 唤醒度」上推一把，脸由当下状态最近的**原型**决定，
 * 事件结束后按指数衰减回基线。两个效果是白拿的：中间会自然过渡，走完还会残留一会儿。
 */

export interface MoodFace {
	/** Exp3/<id>.exp3.json，也就是 iris-core 那边 `IRIS_EXPRESSIONS` 的 id。 */
	id: string;
	/** 她在正文里写的那两个字（只给调试看）。 */
	tag: string;
	/** 愉悦度 -1..1：越正越舒服。 */
	v: number;
	/** 唤醒度 -1..1：越正越「起来」（激动、炸毛、被吓）。 */
	a: number;
}

/**
 * 八张脸在 V/A 平面上的位置。数值是拍的，但顺序有依据：
 * 眼泪比黑脸更难受（v 更低）、更沉（a 更低）；崩溃最炸；得意是「冷静地赢」（a 低）。
 */
export const MOOD_FACES: readonly MoodFace[] = [
	{ id: "blush", tag: "脸红", v: 0.55, a: 0.35 },
	{ id: "heart_eyes", tag: "爱心眼", v: 0.85, a: 0.75 },
	{ id: "smug_eyes", tag: "得意", v: 0.45, a: 0.05 },
	{ id: "swirl_eyes", tag: "圈圈眼", v: -0.1, a: 0.8 },
	{ id: "cold_sweat", tag: "冷汗", v: -0.4, a: -0.1 },
	{ id: "dark_face", tag: "黑脸", v: -0.7, a: 0.45 },
	{ id: "tears", tag: "眼泪", v: -0.8, a: -0.4 },
	{ id: "distressed_eyes", tag: "崩溃", v: -0.85, a: 0.9 },
];

/** 这八张是情绪脸（走状态机）；其余的 body_、Clothes、Movement 那几组开关仍旧直接摆。 */
export const MOOD_IDS: ReadonlySet<string> = new Set(MOOD_FACES.map((face) => face.id));

/** 一次情绪事件什么都不发生也能撑多久（毫秒），之后开始衰减。 */
const MOOD_HOLD_MS = 3200;
/** 衰减时间常数（秒）：越大越「念念不忘」。 */
const MOOD_TAU = 4.5;
/** 状态小到这个量级就算回基线，脸悄悄收回 body_default。 */
const MOOD_FLOOR = 0.1;
/** 认脸半径：离所有原型都超过它，就一张情绪脸都不摆。 */
const MOOD_REACH = 0.42;
/** 换脸的迟滞：新原型要比现在这张近这么多才换，否则两张脸会来回抖。 */
const MOOD_HYSTERESIS = 0.06;

function clamp(value: number, lo: number, hi: number): number {
	return value < lo ? lo : value > hi ? hi : value;
}

function distance(face: MoodFace, v: number, a: number): number {
	const dv = face.v - v;
	const da = face.a - a;
	return Math.sqrt(dv * dv + da * da);
}

/** 一次情绪事件：往哪张原型推、推多狠、撑到什么时候。 */
interface Impulse {
	v: number;
	a: number;
	/** 0.2..1，越狠越压得住别的事件。 */
	strength: number;
	/** 这个时刻之后开始衰减。 */
	holdUntil: number;
}

export class Mood {
	/** 还活着的事件，最多留四件（再往上加老人要被挤掉）。 */
	private impulses: Impulse[] = [];
	/** 当下的 V / A。 */
	private v = 0;
	private a = 0;
	private face: string | null = null;
	/** 上一次有事件进来是什么时候：壳子靠它拼「刚起来 / 正在落回去」（ADR-0044）。 */
	private lastHitAt = 0;

	get valence(): number {
		return this.v;
	}

	get arousal(): number {
		return this.a;
	}

	/** 现在摆的是哪张脸（null = 没情绪脸）。 */
	get shown(): string | null {
		return this.face;
	}

	/**
	 * 她写了一个情绪词：记一件「事件」，不是直接切脸。
	 * 返回 false = 这不是情绪词（调用方照旧直接摆）。
	 */
	hit(id: string, strength = 1, holdMs = MOOD_HOLD_MS): boolean {
		const match = MOOD_FACES.find((face) => face.id === id);
		if (match === undefined) return false;
		// 新事件压过旧事件（不然连着两句不同情绪会被平均成一张谁都不像的脸），
		// 旧事件不删，留个 0.55 的尾巴——这就是「残留」。
		for (const alive of this.impulses) alive.strength *= 0.55;
		this.impulses = this.impulses.filter((alive) => alive.strength > 0.15);
		this.impulses.push({
			v: match.v,
			a: match.a,
			strength: clamp(strength, 0.2, 1),
			holdUntil: performance.now() + holdMs,
		});
		if (this.impulses.length > 4) this.impulses.shift();
		this.lastHitAt = performance.now();
		return true;
	}

	/** 距离上一次情绪事件多久了（秒）；一次都没发生过就是 Infinity。 */
	get sinceHit(): number {
		if (this.lastHitAt === 0) return Number.POSITIVE_INFINITY;
		return (performance.now() - this.lastHitAt) / 1000;
	}

	/**
	 * 每帧：把还活着的事件按权重取平均得到目标，再让现值追过去，最后挑脸。
	 * 权重 = 强度 × 衰减；总权重同时当包络——所以只剩一件事件时，目标就是那张原型，
	 * 它衰减到零的过程里目标也一起回零，不需要额外的定时收回。
	 */
	step(dt: number): string | null {
		const now = performance.now();
		let wv = 0;
		let wa = 0;
		let wsum = 0;
		const alive: Impulse[] = [];
		for (const impulse of this.impulses) {
			const late = now - impulse.holdUntil;
			const weight = impulse.strength * (late <= 0 ? 1 : Math.exp(-late / 1000 / MOOD_TAU));
			if (weight < 0.02) continue;
			alive.push(impulse);
			wv += impulse.v * weight;
			wa += impulse.a * weight;
			wsum += weight;
		}
		this.impulses = alive;
		const idle = wsum < 1e-4;
		const envelope = Math.min(1, wsum);
		const tv = idle ? 0 : (wv / wsum) * envelope;
		const ta = idle ? 0 : (wa / wsum) * envelope;
		const k = Math.min(1, dt * 5);
		this.v += (tv - this.v) * k;
		this.a += (ta - this.a) * k;
		// 只有「没有事件在推」且已经落到噪声底，才算回到基线。
		// （少了 idle 这一半，事件刚起的第一帧 v 才 0.04，会被当成回落直接清零，永远爬不起来。）
		if (idle && Math.abs(this.v) < MOOD_FLOOR && Math.abs(this.a) < MOOD_FLOOR) {
			this.v = 0;
			this.a = 0;
			this.face = null;
			return null;
		}
		this.face = this.pick();
		return this.face;
	}

	private pick(): string | null {
		let best: MoodFace | null = null;
		let bestD = Number.POSITIVE_INFINITY;
		let currentD = Number.POSITIVE_INFINITY;
		for (const face of MOOD_FACES) {
			const d = distance(face, this.v, this.a);
			if (d < bestD) {
				bestD = d;
				best = face;
			}
			if (face.id === this.face) currentD = d;
		}
		if (best === null) return null;
		// 一下子认不出来就先不摆脸，等状态走到某张原型附近
		if (this.face === null) return bestD <= MOOD_REACH ? best.id : null;
		// 迟滞：新原型只近一点点不换，免得两张脸来回抖
		if (best.id !== this.face && bestD + MOOD_HYSTERESIS < currentD) return best.id;
		if (currentD > MOOD_REACH + 0.2) return bestD <= MOOD_REACH ? best.id : null;
		return this.face;
	}
}
