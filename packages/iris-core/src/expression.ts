/**
 * 她的脸：正文里写 `<脸红>`，壳子把它换成一张 Live2D 表情（ADR-0041）。
 *
 * 为什么走正文标记：她要摆什么脸只有写这句话的人自己知道，再问一次模型既慢又容易
 * 跟台词对不上。标记单独占位、不进字幕、不进归档，看到它的只有壳子。
 *
 * 为什么只认这八张：模型那 23 个「表情」其实是作者的部件开关（key1..key13、Clothes*），
 * fork 的 ExpressionManager 又是叠加语义，开多了眼睛会被遮成灰洞（ADR-0040 修法九）。
 * 这一层只负责认出「她想摆哪张」，真正互斥地写参数在壳子里做。
 */

export interface IrisExpression {
	/** 她在正文里写的那个词（`<脸红>` 里的「脸红」）。 */
	tag: string;
	/** 壳子认的表情 id（= `Exp3/<id>.exp3.json`）。 */
	id: string;
	/** 什么时候用它（进 system prompt 的短说明）。 */
	when: string;
}

export const IRIS_EXPRESSIONS: readonly IrisExpression[] = [
	{ tag: "脸红", id: "blush", when: "被戳中、被夸、不好意思" },
	{ tag: "爱心眼", id: "heart_eyes", when: "真的喜欢、看得上眼" },
	{ tag: "圈圈眼", id: "swirl_eyes", when: "被绕晕、听到离谱的话" },
	{ tag: "冷汗", id: "cold_sweat", when: "无语、替他尴尬" },
	{ tag: "黑脸", id: "dark_face", when: "不高兴、压着火" },
	{ tag: "眼泪", id: "tears", when: "委屈、被戳痛" },
	{ tag: "得意", id: "smug_eyes", when: "看穿他在装、觉得自己赢了" },
	{ tag: "崩溃", id: "distressed_eyes", when: "被烦到不行" },
];

const BY_TAG = new Map(IRIS_EXPRESSIONS.map((item) => [item.tag, item.id]));

/** 标记名 → 表情 id；不认识的返回 null（那片 `<...>` 会原样吐出去）。 */
export function expressionId(tag: string): string | null {
	return BY_TAG.get(tag.trim()) ?? null;
}

/** 标记名最长这几个字，超了就不可能是标记，当正文里的普通 `<` 处理。 */
const MAX_TAG = 8;

/**
 * 流式的标记过滤器：边收边吐，标记本身不进字幕。
 *
 * 增量会把 `<脸红>` 劈成 `<脸` 和 `红>`，所以末尾那个没闭合的 `<` 压住等下一片；
 * 一轮结束时 `flush()` 把压住的尾巴原样交出来。只吞认识的标记：她要是写 `<div>`，
 * 原样还给她（`expressionId` 认不出就当正文）。
 */
export class ExpressionStream {
	private pending = "";
	private latest: string | null = null;

	/** 这一轮最后一个被认出来的表情；没写过就是 null。 */
	get expression(): string | null {
		return this.latest;
	}

	push(chunk: string): string {
		this.pending += chunk;
		let out = "";
		for (;;) {
			const open = this.pending.indexOf("<");
			if (open < 0) {
				out += this.pending;
				this.pending = "";
				return out;
			}
			out += this.pending.slice(0, open);
			this.pending = this.pending.slice(open);
			const close = this.pending.indexOf(">");
			if (close < 0) {
				if (this.pending.length > MAX_TAG + 2) {
					out += "<";
					this.pending = this.pending.slice(1);
					continue;
				}
				return out;
			}
			const id = expressionId(this.pending.slice(1, close));
			const raw = this.pending.slice(0, close + 1);
			this.pending = this.pending.slice(close + 1);
			if (id === null) out += raw;
			else this.latest = id;
		}
	}

	flush(): string {
		const rest = this.pending;
		this.pending = "";
		return rest;
	}
}

/** 非流式的等价物：整段进去，干净正文和表情一起出来。 */
export function splitExpression(text: string): { text: string; expression: string | null } {
	const stream = new ExpressionStream();
	const cleaned = stream.push(text) + stream.flush();
	return { text: cleaned, expression: stream.expression };
}
