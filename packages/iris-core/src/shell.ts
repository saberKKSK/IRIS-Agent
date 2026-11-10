/**
 * 她能自己跑命令（ADR-0035）：run_command。
 *
 * 为什么要一张嘴：她要写日记、要改文件夹名，下一步要帮我配那台云端机器——光有 ls/read/grep/write 不够，
 * 装个依赖、看个端口、跑个脚本都得靠命令。pi 的 coding-agent 里本来就有 bash / powershell 两个工具（ADR-0012 裁掉了），
 * 这里按 IRIS 的授权模型重做一份，只留一个 run_command。
 *
 * 三道闸，全部 fail-closed：
 * 1. 地方：工作目录必须在**她已经能写**的文件夹里（授权沿用 WriteGuard，不放新的账本）。
 * 2. 内容：看得出是只读的那几个命令头直接跑（ls / cat / git status 之类）；其余每一条都要人看一眼。
 * 3. 记住：他同意了某一条，可以顺手说「以后这个命令头都放给她」，记在 ~/.iris/exec-allow.json。
 *    危险命令（删库、改系统、关机、拉远端脚本执行……）永远逐条问，不给记住的机会。
 *
 * 这不是沙箱：她能跑的命令就是当前用户能跑的命令。能拦的只有「她没被允许的那几条」，拦不住「她聪明反被聪明误」。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { pathInside } from "./files.ts";

export type ShellVerdictKind = "ro" | "remembered" | "asked" | "refused" | "danger" | "denied";

export interface ShellRequest {
	/** 完整的命令行，原样给人看。 */
	command: string;
	/** 在哪个目录里跑。 */
	cwd: string;
	/** 命令头（第一个词，去掉路径和扩展名），记住的就是它。 */
	head: string;
}

export interface ShellAllowed {
	ok: true;
	command: string;
	cwd: string;
	head: string;
	via: "ro" | "remembered" | "asked";
}

export interface ShellDenied {
	ok: false;
	reason: string;
	needsPermission: boolean;
	kind: ShellVerdictKind;
}

export type ShellVerdict = ShellAllowed | ShellDenied;

export interface ShellGuardOptions {
	/** 现在能写哪些目录（默认空，等于哪儿都不能跑）。 */
	grants?: () => readonly string[];
	/** 问人：返回 true 才跑。没人能问就别传（等于一律拒）。 */
	approve?: (request: ShellRequest) => Promise<boolean> | boolean;
	/** 「以后这个命令头都放给她」记在哪；null 或省略 = 不记。 */
	allowFile?: string | null;
}

/** 看得出是只读的命令头：直接跑，不打扰人。故意收得很窄，改不了任何东西。 */
export const DEFAULT_READ_ONLY_HEADS: readonly string[] = [
	"ls",
	"dir",
	"cat",
	"type",
	"head",
	"tail",
	"pwd",
	"whoami",
	"hostname",
	"date",
	"where",
	"which",
	"get-childitem",
	"get-content",
	"get-location",
	"get-date",
	"get-item",
	"get-itemproperty",
	"select-string",
	"measure-object",
	"resolve-path",
	"test-path",
];

/** 危险命令：永远逐条问，问过也不许记住。 */
export const DANGER_PATTERNS: readonly RegExp[] = [
	/rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r/i,
	/remove-item[^\n]*-recurse[^\n]*-force/i,
	/del\s+\/[sq]/i,
	/rd\s+\/[sq]/i,
	/rmdir\s+\/[sq]/i,
	/\bformat\b\s+[a-z]:/i,
	/\bdiskpart\b/i,
	/\bbcdedit\b/i,
	/\bshutdown\b/i,
	/\brestart-computer\b/i,
	/\bstop-computer\b/i,
	/\breg\s+(add|delete|import)\b/i,
	/\bnet\s+user\b/i,
	/\bsc(\.exe)?\s+(create|delete|config)\b/i,
	/\bschtasks\b/i,
	/\btakeown\b/i,
	/\bicacls\b/i,
	/\bset-executionpolicy\b/i,
	/\binvoke-expression\b/i,
	/\biex\b/i,
	/-encodedcommand\b/i,
	/\b(curl|wget|invoke-webrequest|iwr)\b[^\n]*\|/i,
	/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)/i,
	/\bnpm\s+publish\b/i,
	/\bdocker\s+(rm|rmi|system\s+prune)\b/i,
	/\bkubectl\s+delete\b/i,
	/\bdd\s+if=/i,
	/\bmkfs\b/i,
];

/** 记住的命令头存在哪：IRIS_EXEC_ALLOW 优先，否则 ~/.iris/exec-allow.json。 */
export function defaultShellAllowPath(): string {
	return process.env.IRIS_EXEC_ALLOW ?? join(homedir(), ".iris", "exec-allow.json");
}

/**
 * 命令头：第一个词（带引号的整条路径算一个词），去掉路径前缀和 .exe/.cmd 后缀，转小写。
 * 记住的就是它：记住「git」，git status / git log 都不再问。
 */
export function commandHead(command: string): string {
	const text = command.trim();
	if (text === "") return "";
	let first: string;
	const quote = text.slice(0, 1);
	if (quote === '"' || quote === "\x27") {
		const close = text.indexOf(quote, 1);
		first = close < 0 ? text.slice(1) : text.slice(1, close);
	} else {
		first = text.split(/\s+/u)[0] ?? "";
	}
	const name = first.split(/[\\/]/u).pop() ?? first;
	return name.replace(/\.(exe|cmd|bat|ps1)$/iu, "").toLowerCase();
}

/** 这条命令是不是危险命令（软拦：只决定「要不要人看一眼」，不做沙箱）。 */
export function isDangerous(command: string): boolean {
	return DANGER_PATTERNS.some((pattern) => pattern.test(command));
}

const READ_ONLY = new Set(DEFAULT_READ_ONLY_HEADS.map((head) => head.toLowerCase()));

function fold(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

function readList(path: string): string[] {
	try {
		if (!existsSync(path)) return [];
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw.filter((item): item is string => typeof item === "string" && item.trim() !== "");
	} catch {
		return [];
	}
}

/** 跑命令的守门人：地方、内容、记住，三道闸。 */
export class ShellGuard {
	private readonly grantFn: () => readonly string[];
	private readonly approve: ShellGuardOptions["approve"];
	private readonly allowFile: string | null;
	private rememberedList: string[];

	constructor(options: ShellGuardOptions = {}) {
		this.grantFn = options.grants ?? (() => []);
		this.approve = options.approve;
		this.allowFile = options.allowFile === undefined ? null : options.allowFile;
		this.rememberedList = this.allowFile === null ? [] : readList(this.allowFile);
	}

	/** 她现在能在哪些目录里跑命令（就是能写的那些）。 */
	get grants(): readonly string[] {
		return this.grantFn();
	}

	/** 已经记住的命令头。 */
	get remembered(): readonly string[] {
		return [...this.rememberedList];
	}

	remember(head: string): void {
		const clean = head.trim().toLowerCase();
		if (clean === "") return;
		if (this.rememberedList.includes(clean)) return;
		this.rememberedList.push(clean);
		this.save();
	}

	forget(head: string): boolean {
		const clean = head.trim().toLowerCase();
		const next = this.rememberedList.filter((item) => item !== clean);
		if (next.length === this.rememberedList.length) return false;
		this.rememberedList = next;
		this.save();
		return true;
	}

	private save(): void {
		if (this.allowFile === null) return;
		try {
			mkdirSync(dirname(this.allowFile), { recursive: true });
			writeFileSync(this.allowFile, JSON.stringify(this.rememberedList, null, 2) + "\n", "utf8");
		} catch {
			/* 记不住不影响这一次跑 */
		}
	}

	/** 她现在能在哪个目录里跑命令：默认取第一个能写的地方。 */
	get defaultCwd(): string | null {
		const grants = this.grants;
		return grants[0] ?? null;
	}

	async check(command: string, cwd?: string): Promise<ShellVerdict> {
		const text = command.trim();
		if (text === "") return { ok: false, reason: "空命令。", needsPermission: false, kind: "denied" };
		const grants = this.grants;
		if (grants.length === 0) {
			return {
				ok: false,
				reason: "她还没有能跑命令的地方：先在一个文件夹上放行写权限。",
				needsPermission: false,
				kind: "denied",
			};
		}
		const here = resolve(cwd ?? grants[0] ?? ".");
		const allowedHere = grants.some((grant) => pathInside(grant, here));
		if (!allowedHere) {
			return {
				ok: false,
				reason: "这个目录她还没能写，不能在那儿跑命令：" + here,
				needsPermission: false,
				kind: "denied",
			};
		}
		const head = commandHead(text);
		const dangerous = isDangerous(text);
		if (!dangerous && READ_ONLY.has(head)) {
			return { ok: true, command: text, cwd: here, head, via: "ro" };
		}
		if (!dangerous && this.rememberedList.includes(head)) {
			return { ok: true, command: text, cwd: here, head, via: "remembered" };
		}
		if (this.approve === undefined) {
			return {
				ok: false,
				reason: "没人能问，这条命令就不跑。",
				needsPermission: true,
				kind: "refused",
			};
		}
		const yes = await this.approve({ command: text, cwd: here, head });
		if (yes !== true) {
			return {
				ok: false,
				reason: "他没同意这条命令。",
				needsPermission: true,
				kind: dangerous ? "danger" : "refused",
			};
		}
		return { ok: true, command: text, cwd: here, head, via: "asked" };
	}
}

export interface RunOptions {
	cwd?: string;
	/** 超时毫秒，默认 30 s。 */
	timeoutMs?: number;
	/** 输出最多留多少字符（头尾各留一半），默认 20 000。 */
	maxOutput?: number;
	/** 指定 shell 可执行文件，一般不用传。 */
	shell?: string;
}

export interface RunResult {
	exitCode: number | null;
	/** stdout 与 stderr 合在一起。 */
	output: string;
	truncated: boolean;
	timedOut: boolean;
	ms: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_OUTPUT = 20_000;

/** 用哪个 shell 跑：IRIS_SHELL 优先，其次 PowerShell 7，再退回 Windows PowerShell / bash。 */
export function shellPath(): string {
	const override = (process.env.IRIS_SHELL ?? "").trim();
	if (override !== "") return override;
	if (process.platform === "win32") {
		const pwsh7 = join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
		if (existsSync(pwsh7)) return pwsh7;
		return "powershell.exe";
	}
	return "/bin/bash";
}

function shellArgs(shell: string, command: string): string[] {
	if (/bash(\.exe)?$/iu.test(shell)) return ["-lc", command];
	return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
}

function cut(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	const half = Math.floor(max / 2);
	const head = text.slice(0, half);
	const tail = text.slice(text.length - half);
	return { text: head + "\n…（中间截掉 " + String(text.length - max) + " 个字符）…\n" + tail, truncated: true };
}

function killTree(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		/* 已经退出了 */
	}
}

/** 跑一条命令，等它结束。不抛：超时、非零退出都当成结果返回。 */
export async function runCommand(command: string, options: RunOptions = {}): Promise<RunResult> {
	const started = Date.now();
	const shell = options.shell ?? shellPath();
	const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
	const maxOutput = Math.max(options.maxOutput ?? DEFAULT_MAX_OUTPUT, 1_000);
	const cwd = options.cwd ?? process.cwd();
	return await new Promise<RunResult>((done) => {
		let output = "";
		let timedOut = false;
		let finished = false;
		const child = spawn(shell, shellArgs(shell, command), {
			cwd,
			windowsHide: true,
			env: process.env,
		});
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child.pid);
		}, timeoutMs);
		const finish = (exitCode: number | null): void => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			const trimmed = cut(output, maxOutput);
			done({
				exitCode,
				output: trimmed.text.replace(/\r\n/gu, "\n").trimEnd(),
				truncated: trimmed.truncated,
				timedOut,
				ms: Date.now() - started,
			});
		};
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => {
			output += "\n" + error.message;
			finish(null);
		});
		child.on("close", (code: number | null) => finish(code));
	});
}

export interface ShellToolDetails {
	ok: boolean;
	action: "run";
	command?: string;
	cwd?: string;
	exitCode?: number | null;
	ms?: number;
	truncated?: boolean;
	timedOut?: boolean;
	via?: ShellAllowed["via"];
	needsPermission?: boolean;
	kind?: ShellVerdictKind;
	error?: string;
}

export interface ShellToolOptions extends ShellGuardOptions {
	guard?: ShellGuard;
	/** 不给 cwd 时在哪儿跑；默认取第一个能写的目录。 */
	defaultCwd?: string;
	timeoutMs?: number;
	maxOutput?: number;
	shell?: string;
}

function failed(details: ShellToolDetails): AgentToolResult<ShellToolDetails> {
	return {
		content: [{ type: "text", text: details.error ?? "跑不了。" }],
		details,
		isError: true,
	};
}

const NEED_APPROVAL_HINT = "；这条要他看一眼才跑，你可以先跟他说明你要干什么";

/** 三个工具之外多给一件：run_command。 */
export function shellTools(options: ShellToolOptions = {}): AgentTool[] {
	const guard =
		options.guard ??
		new ShellGuard({ grants: options.grants, approve: options.approve, allowFile: options.allowFile });

	const run: AgentTool = {
		name: "run_command",
		label: "跑命令",
		description: [
			"在自己的文件夹里跑一条 PowerShell 命令，拿回输出和退出码。",
			"只读命令（ls / cat / git status 这类）直接跑；其余每一条他都会先看一眼。",
			"一次一条，别开需要人按键的交互式程序（vim / more / pause / 不停刷新的监视），别挂后台常驻进程。",
		].join(""),
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "要执行的命令行" },
				cwd: { type: "string", description: "在哪个文件夹里跑，可省（默认你手边那个）" },
				timeout_s: { type: "number", description: "最多等几秒，默认 30，最大 300" },
			},
			required: ["command"],
		},
		async execute(_toolCallId, params) {
			const input = (params ?? {}) as { command?: unknown; cwd?: unknown; timeout_s?: unknown };
			const command = typeof input.command === "string" ? input.command : "";
			const cwd = typeof input.cwd === "string" && input.cwd.trim() !== "" ? input.cwd : undefined;
			const seconds = typeof input.timeout_s === "number" ? input.timeout_s : undefined;
			const verdict = await guard.check(command, cwd ?? options.defaultCwd ?? guard.defaultCwd ?? undefined);
			if (verdict.ok === false) {
				const suffix = verdict.needsPermission ? NEED_APPROVAL_HINT : "";
				return failed({
					ok: false,
					action: "run",
					command,
					cwd: verdict.kind === "denied" ? undefined : cwd,
					needsPermission: verdict.needsPermission,
					kind: verdict.kind,
					error: verdict.reason + suffix,
				});
			}
			const result = await runCommand(verdict.command, {
				cwd: verdict.cwd,
				timeoutMs: seconds === undefined ? options.timeoutMs : Math.round(seconds * 1000),
				maxOutput: options.maxOutput,
				shell: options.shell,
			});
			const lines: string[] = [];
			lines.push(result.output === "" ? "（没有输出）" : result.output);
			if (result.timedOut) {
				lines.push("（超时，进程树已经被掐掉）");
			} else {
				lines.push("（退出码 " + String(result.exitCode ?? "null") + " · " + String(result.ms) + " ms）");
			}
			if (result.truncated) lines.push("（输出太长，中间一段被截掉了）");
			const details: ShellToolDetails = {
				ok: result.exitCode === 0,
				action: "run",
				command: verdict.command,
				cwd: verdict.cwd,
				exitCode: result.exitCode,
				ms: result.ms,
				truncated: result.truncated,
				timedOut: result.timedOut,
				via: verdict.via,
			};
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details,
				isError: result.exitCode !== 0,
			};
		},
	};

	return [run];
}
