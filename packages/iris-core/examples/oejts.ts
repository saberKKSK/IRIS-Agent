/**
 * OEJTS 1.2（Open Extended Jungian Type Scales）—— 32 道双极题，每道 1–5 分（1 = 完全像左边，5 = 完全像右边）。
 *
 * 出处：Eric Jorgenson / Open Psychometrics，https://openpsychometrics.org/tests/OEJTS/
 * 题面与中文译文取自 @openjung/core（https://github.com/openjung/core）的 src/questions.ts，
 * 题目数据按其 LICENSE-DATA 以 CC BY-NC-SA 4.0 授权；本文件只做搬运与计分实现，未改题面。
 *
 * 计分规则同 @openjung/core README：每维 8 题求和，区间 8–40，中位 24；
 * 分数 > 24 取高分极，恰好 24 取低分极；高分极百分比 = (score - 8) / 32 * 100，另一极取余数。
 * 注意 TF 维的低分极是 F、高分极是 T（其余三维低分极分别是 E / S / J）。
 */

export type OejtsDimension = "EI" | "SN" | "TF" | "JP";

export type Pole = "E" | "I" | "S" | "N" | "T" | "F" | "J" | "P";

export interface OejtsItem {
	id: number;
	dimension: OejtsDimension;
	title: string;
	left: string;
	right: string;
}

export const OEJTS_ITEMS: readonly OejtsItem[] = [
	{ id: 1, dimension: "JP", title: "你如何记录任务？", left: "制定清单", right: "依靠记忆" },
	{ id: 2, dimension: "TF", title: "你如何看待新信息？", left: "愿意相信", right: "持怀疑态度" },
	{ id: 3, dimension: "EI", title: "你对独处有什么感受？", left: "独处时感到无聊", right: "需要独处时间" },
	{ id: 4, dimension: "SN", title: "你如何看待现状？", left: "接受事物的本来面目", right: "对现状不满足" },
	{ id: 5, dimension: "JP", title: "你如何整理空间？", left: "保持房间整洁", right: "随手放置东西" },
	{ id: 6, dimension: "TF", title: "你如何看待逻辑思维？", left: '认为"像机器人"是侮辱', right: "追求机械般的思维" },
	{ id: 7, dimension: "EI", title: "你的能量状态如何？", left: "精力充沛", right: "平静温和" },
	{ id: 8, dimension: "SN", title: "你喜欢什么类型的考试？", left: "喜欢选择题", right: "喜欢论述题" },
	{ id: 9, dimension: "JP", title: "你如何形容自己的生活方式？", left: "有条理", right: "随性混乱" },
	{ id: 10, dimension: "TF", title: "你如何应对批评？", left: "容易受伤", right: "脸皮厚" },
	{ id: 11, dimension: "EI", title: "你在什么环境下工作最好？", left: "在团队中表现最佳", right: "独自工作表现最佳" },
	{ id: 12, dimension: "SN", title: "你的时间焦点在哪里？", left: "关注过去", right: "关注未来" },
	{ id: 13, dimension: "JP", title: "你何时制定计划？", left: "提前规划", right: "最后一刻才计划" },
	{ id: 14, dimension: "TF", title: "你希望从他人那里得到什么？", left: "渴望他人的爱", right: "渴望他人的尊重" },
	{ id: 15, dimension: "EI", title: "聚会让你感觉如何？", left: "因聚会而兴奋", right: "因聚会而疲惫" },
	{ id: 16, dimension: "SN", title: "在群体中，你倾向于...", left: "融入群体", right: "与众不同" },
	{ id: 17, dimension: "JP", title: "你如何做决定？", left: "做出承诺", right: "保留选择" },
	{ id: 18, dimension: "TF", title: "你想擅长什么？", left: "想擅长帮助他人", right: "想擅长修理事物" },
	{ id: 19, dimension: "EI", title: "在交谈中，你更倾向于...", left: "话比较多", right: "更善于倾听" },
	{ id: 20, dimension: "SN", title: "讲故事时，你会...", left: "描述发生了什么", right: "描述这意味着什么" },
	{ id: 21, dimension: "JP", title: "你何时完成任务？", left: "立即完成工作", right: "拖延" },
	{ id: 22, dimension: "TF", title: "你如何做决定？", left: "跟随内心", right: "跟随理性" },
	{ id: 23, dimension: "EI", title: "周末你更喜欢做什么？", left: "喜欢外出活动", right: "喜欢待在家里" },
	{ id: 24, dimension: "SN", title: "学习新事物时，你想要什么？", left: "想要细节", right: "想要大局观" },
	{ id: 25, dimension: "JP", title: "你如何应对新情况？", left: "提前准备", right: "即兴发挥" },
	{ id: 26, dimension: "TF", title: "道德的基础是什么？", left: "道德基于同情", right: "道德基于正义" },
	{ id: 27, dimension: "EI", title: "你的自然音量如何？", left: "自然而然大声说话", right: "很难大声喊叫" },
	{ id: 28, dimension: "SN", title: "你如何获取知识？", left: "经验主义", right: "理论主义" },
	{ id: 29, dimension: "JP", title: "什么更能驱动你？", left: "努力工作", right: "尽情玩乐" },
	{ id: 30, dimension: "TF", title: "你如何看待情感？", left: "重视情感", right: "对情感感到不自在" },
	{ id: 31, dimension: "EI", title: "你对成为焦点有什么感受？", left: "喜欢表演", right: "避免公开演讲" },
	{ id: 32, dimension: "SN", title: "什么问题最让你感兴趣？", left: '想知道"谁/什么/何时"', right: '想知道"为什么"' },
];

export const OEJTS_TOTAL = OEJTS_ITEMS.length;

const POLES: Readonly<Record<OejtsDimension, { low: Pole; high: Pole }>> = {
	EI: { low: "E", high: "I" },
	SN: { low: "S", high: "N" },
	TF: { low: "F", high: "T" },
	JP: { low: "J", high: "P" },
};

const DIMENSIONS: readonly OejtsDimension[] = ["EI", "SN", "TF", "JP"];

const SCORE_MIN = 8;
const SCORE_MAX = 40;
const MIDPOINT = 24;

export type OejtsScores = Readonly<Record<OejtsDimension, number>>;

export interface OejtsPole {
	dimension: OejtsDimension;
	pole: Pole;
	percent: number;
}

export interface OejtsResult {
	type: string;
	scores: OejtsScores;
	percentages: Readonly<Record<Pole, number>>;
	poles: readonly OejtsPole[];
}

/**
 * 计分。没答的题按中性 3 分算（与上游一致）。
 */
export function scoreOejts(answers: Readonly<Record<number, number>>): OejtsResult {
	const sums: Record<OejtsDimension, number> = { EI: 0, SN: 0, TF: 0, JP: 0 };
	for (const item of OEJTS_ITEMS) {
		const raw = answers[item.id];
		const value = typeof raw === "number" && raw >= 1 && raw <= 5 ? raw : 3;
		sums[item.dimension] += value;
	}

	const scores: Record<OejtsDimension, number> = { EI: 0, SN: 0, TF: 0, JP: 0 };
	const percentages: Record<Pole, number> = { E: 0, I: 0, S: 0, N: 0, T: 0, F: 0, J: 0, P: 0 };
	const poles: OejtsPole[] = [];
	let type = "";

	for (const dimension of DIMENSIONS) {
		const score = sums[dimension];
		scores[dimension] = score;
		const { low, high } = POLES[dimension];
		const highPercent = Math.round(((score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)) * 100);
		percentages[high] = highPercent;
		percentages[low] = 100 - highPercent;
		const winner = score > MIDPOINT ? high : low;
		type += winner;
		poles.push({ dimension, pole: winner, percent: percentages[winner] });
	}

	return { type, scores, percentages, poles };
}

/** Keirsey 四气质，只用来给四个字母配个中文说法，不是测试的一部分。 */
export function temperamentOf(type: string): string {
	const nt = type.includes("N") && type.includes("T");
	const nf = type.includes("N") && type.includes("F");
	if (nt) return "理性者（NT）";
	if (nf) return "理想主义者（NF）";
	if (type.includes("S") && type.includes("J")) return "护卫者（SJ）";
	return "工匠（SP）";
}
