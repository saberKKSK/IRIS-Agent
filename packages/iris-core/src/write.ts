/**
 * 她能动手写（ADR-0034）：write_file / append_file / make_dir / move_path / request_write。
 *
 * 为什么现在才给：ADR-0026 当时只给只读三件，理由是「能改机器的手要就一次给足、要就一条不给」。
 * 2026-11-10 她要写日记、要把 80-艾拉 那个文件夹改成自己的名字，在屋里当场被挡下来（她没有手），
 * 于是把「写」单独做一套闸门，而不是把 bash / powershell 放进来。
 *
 * 授权与只读**分开**：能看一个文件夹不等于能写它。写权限记在 ~/.iris/write-roots.json（IRIS_WRITE_GRANTS 可覆盖），
 * 默认空，第一次碰某个文件夹要问人（y 就这次 / a 以后整个都放给她），没人能问就一律拒（fail-closed）。
 *
 * 比只读多两道闸：
 * 1. 覆盖一个已经存在的文件之前，她必须这次进程里 read 过它（FileGuard.noteSeen），否则拒绝。
 * 2. 写完立刻回读比对，字节不一致就报错——避免「嘴上说写了，其实没落盘」。
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { DEFAULT_DENY_EXTENSIONS, DEFAULT_DENY_NAMES, type FileGuard, formatSize, pathInside } from "./files.ts";

export type WriteAction = "write" | "append" | "mkdir" | "move" | "access";

export interface WriteAccessRequest {
	action: WriteAction;
	/** 她要动的那条路径（绝对路径）。 */
	path: string;
	/** 授权单位：同意一次，整个文件夹都放行。 */
	grant: string;
	/** 这个位置属于哪个根目录；家目录外面时等于 grant 本身。 */
	root: string;
	/** 她想写这里的理由，直接给人看。 */
	reason?: string;
}

export const DEFAULT_WRITE_DENY_NAMES: readonly string[] = [
	...DEFAULT_DENY_NAMES,
	".git",
	"node_modules",
	"Windows",
	"Program Files",
	"Program Files (x86)",
	"System32",
	"$Recycle.Bin",
];

export const DEFAULT_WRITE_DENY_EXTENSIONS: readonly string[] = [
	...DEFAULT_DENY_EXTENSIONS,
	".exe",
	".dll",
	".sys",
	".com",
	".bat",
	".cmd",
	".ps1",
	".sh",
	".vbs",
	".scr",
	".msi",
	".lnk",
];

export interface WriteAllowed {
	ok: true;
	path: string;
	root: string;
	grant: string;
}

export interface WriteDenied {
	ok: false;
	reason: string;
	needsPermission: boolean;
}

export type WriteVerdict = WriteAllowed | WriteDenied;

export interface WriteGuardOptions {
	/** 一开始就当起点的地方，默认家目录。 */
	roots?: readonly string[];
	denyNames?: readonly string[];
	denyExtensions?: readonly string[];
	/** 第一次碰某个文件夹时问人；不给就一律拒。 */
	approve?: (request: WriteAccessRequest) => Promise<boolean> | boolean;
	/** 放行记录落在哪；null 表示只在内存里。 */
	grantsFile?: string | null;
}

export type WriteErrorKind = "denied" | "unread" | "exists" | "missing" | "too-big" | "bad-path" | "failed";

export interface WriteError {
	ok: false;
	kind: WriteErrorKind;
	message: string;
	needsPermission?: boolean;
}

function lower(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value;
}

function canonical(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

/** 他放开的「能写」的文件夹存在哪：IRIS_WRITE_GRANTS 优先，否则 ~/.iris/write-roots.json。 */
export function defaultWriteGrantsPath(): string {
	return process.env.IRIS_WRITE_GRANTS ?? join(homedir(), ".iris", "write-roots.json");
}

function readGrantFile(path: string): string[] {
	try {
		if (!existsSync(path)) return [];
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw
			.filter((item): item is string => typeof item === "string" && item.trim() !== "")
			.map((item) => canonical(item));
	} catch {
		return [];
	}
}

/** 写文件的守门人。和只读那套是两本账，能看不等于能写。 */
export class WriteGuard {
	readonly roots: readonly string[];
	private readonly denyNames: Set<string>;
	private readonly denyExtensions: Set<string>;
	private readonly approve: WriteGuardOptions["approve"];
	private readonly grantsFile: string | null;
	private readonly granted = new Set<string>();
	private persisted: string[];
	private preferred: string | null = null;

	constructor(options: WriteGuardOptions = {}) {
		this.roots = (options.roots ?? [homedir()]).map((root) => canonical(root));
		this.denyNames = new Set((options.denyNames ?? DEFAULT_WRITE_DENY_NAMES).map((name) => lower(name)));
		this.denyExtensions = new Set(
			(options.denyExtensions ?? DEFAULT_WRITE_DENY_EXTENSIONS).map((name) => lower(name)),
		);
		this.approve = options.approve;
		this.grantsFile = options.grantsFile === undefined ? null : options.grantsFile;
		this.persisted = this.grantsFile === null ? [] : readGrantFile(this.grantsFile);
		for (const grant of this.persisted) this.granted.add(grant);
	}

	get grants(): readonly string[] {
		return [...this.granted];
	}

	get storedGrants(): readonly string[] {
		return [...this.persisted];
	}

	get defaultPath(): string {
		const granted = [...this.granted];
		return this.preferred ?? granted[0] ?? this.roots[0] ?? canonical(".");
	}

	async check(target: string, options: { reason?: string } = {}): Promise<WriteVerdict> {
		const absolute = canonical(target);
		const denied = this.deniedReason(absolute);
		if (denied !== null) return { ok: false, reason: denied, needsPermission: false };

		const root = this.roots.find((candidate) => pathInside(candidate, absolute));
		const grant = root === undefined ? absolute : grantOf(root, absolute);
		if (!this.covered(absolute)) {
			if (this.approve === undefined) {
				return { ok: false, reason: "写 " + grant + " 得他先同意，这会儿没人能问我", needsPermission: true };
			}
			const reason = options.reason?.trim() ?? "";
			const request: WriteAccessRequest = {
				action: "write",
				path: absolute,
				grant,
				root: root ?? grant,
				...(reason === "" ? {} : { reason }),
			};
			const allowed = await this.approve(request);
			if (!allowed) {
				return {
					ok: false,
					reason: "他没同意我写 " + grant + "（要就开口跟他要，用 request_write）",
					needsPermission: true,
				};
			}
			this.granted.add(grant);
		}
		return { ok: true, path: absolute, root: root ?? grant, grant };
	}

	allow(target: string, options: { persist?: boolean } = {}): string {
		const absolute = canonical(target);
		const root = this.roots.find((candidate) => pathInside(candidate, absolute));
		this.preferred = absolute;
		const grant = root === undefined ? absolute : grantOf(root, absolute);
		this.granted.add(grant);
		if (options.persist !== false) this.persist(grant);
		return grant;
	}

	disallow(target: string): boolean {
		const absolute = canonical(target);
		const root = this.roots.find((candidate) => pathInside(candidate, absolute));
		const grant = root === undefined ? absolute : grantOf(root, absolute);
		const before = this.persisted.length;
		this.persisted = this.persisted.filter((item) => lower(item) !== lower(grant));
		this.granted.delete(grant);
		const changed = this.persisted.length !== before;
		if (changed) this.writeGrants();
		return changed;
	}

	private covered(path: string): boolean {
		for (const grant of this.granted) {
			if (pathInside(grant, path)) return true;
		}
		return false;
	}

	private persist(grant: string): void {
		if (this.grantsFile === null) return;
		if (this.persisted.some((item) => lower(item) === lower(grant))) return;
		this.persisted.push(grant);
		this.writeGrants();
	}

	private writeGrants(): void {
		if (this.grantsFile === null) return;
		try {
			mkdirSync(dirname(this.grantsFile), { recursive: true });
			writeFileSync(this.grantsFile, JSON.stringify(this.persisted, null, 2) + "\n", "utf8");
		} catch {
			// 存不下来不影响这一次
		}
	}

	private deniedReason(path: string): string | null {
		for (const segment of path.split(sep)) {
			if (this.denyNames.has(lower(segment))) return "这类东西（" + segment + "）我不写";
		}
		const extension = lower(extname(path));
		if (extension !== "" && this.denyExtensions.has(extension)) return "这种文件（" + extension + "）我不写";
		return null;
	}
}

function grantOf(root: string, path: string): string {
	if (lower(root) === lower(path)) return root;
	const rest = path.slice(root.endsWith(sep) ? root.length : root.length + 1);
	const first = rest.split(sep)[0] ?? "";
	if (first === "") return root;
	return root.endsWith(sep) ? root + first : root + sep + first;
}

function asWriteError(verdict: WriteDenied): WriteError {
	return { ok: false, kind: "denied", message: verdict.reason, needsPermission: verdict.needsPermission };
}

function tooBig(bytes: number, max: number): WriteError {
	return {
		ok: false,
		kind: "too-big",
		message: "这次要写的太多（" + formatSize(bytes) + "，一次最多 " + formatSize(max) + "），拆开分几次写",
	};
}

/** 先写临时文件再改名：中途断电也不会留下半个文件。 */
function atomicWrite(path: string, content: string): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const temp = join(dir, ".iris-tmp-" + String(process.pid) + "-" + String(Date.now()));
	writeFileSync(temp, content, "utf8");
	try {
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// 临时文件删不掉也没关系
		}
		throw error;
	}
}

export interface WriteToolDetails {
	ok: boolean;
	action: WriteAction;
	path?: string;
	/** 改名后的新位置。 */
	target?: string;
	bytes?: number;
	grant?: string;
	needsPermission?: boolean;
	error?: string;
	kind?: WriteErrorKind;
}

export interface WriteToolOptions extends WriteGuardOptions {
	/** 她这次进程里读过哪些文件（FileGuard）——覆盖前必须看过。 */
	reads?: FileGuard;
	/** 一次最多写多少字节，默认 250 000。 */
	maxBytes?: number;
	/** 直接用现成的守门人（REPL 要共享写权限状态时用）。 */
	guard?: WriteGuard;
}

function failed(error: WriteError, action: WriteAction, path?: string): AgentToolResult<WriteToolDetails> {
	return {
		content: [{ type: "text", text: error.message }],
		details: {
			ok: false,
			action,
			...(path === undefined ? {} : { path }),
			error: error.message,
			kind: error.kind,
			...(error.needsPermission === true ? { needsPermission: true } : {}),
		},
		isError: true,
	};
}

function linesOf(text: string): number {
	if (text === "") return 0;
	return text.split("\n").length;
}

function sameContent(path: string, content: string): boolean {
	try {
		return readFileSync(path, "utf8") === content;
	} catch {
		return false;
	}
}

/** 给她用的写工具：write_file / append_file / make_dir / move_path / request_write。 */
export function writeTools(options: WriteToolOptions = {}): AgentTool[] {
	const guard = options.guard ?? new WriteGuard(options);
	const maxBytes = options.maxBytes ?? 250_000;

	const write: AgentTool = {
		name: "write_file",
		label: "写一个文件",
		description:
			"把内容整个写进一个文件（没有就新建，有就覆盖）。只能写他放开给你的文件夹。**覆盖已经有内容的文件之前必须先 read 一遍**，没看过的东西不要拿自己的版本盖掉。写完会自己回读核对，你不用再读一遍。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "文件路径，可以写「桌面」这类口语名" },
				content: { type: "string", description: "要写的全部内容（会整个替换原文件）" },
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<WriteToolDetails>> => {
			const args = params as { path?: unknown; content?: unknown };
			const asked = typeof args.path === "string" ? args.path.trim() : "";
			if (asked.length === 0) return failed({ ok: false, kind: "bad-path", message: "没给路径" }, "write");
			const content = typeof args.content === "string" ? args.content : "";
			const bytes = Buffer.byteLength(content, "utf8");
			if (bytes > maxBytes) return failed(tooBig(bytes, maxBytes), "write", asked);

			const verdict = await guard.check(asked);
			if (!verdict.ok) return failed(asWriteError(verdict), "write", asked);

			const exists = existsSync(verdict.path);
			if (exists) {
				let isDirectory = false;
				try {
					isDirectory = statSync(verdict.path).isDirectory();
				} catch {
					isDirectory = false;
				}
				if (isDirectory) {
					return failed({ ok: false, kind: "bad-path", message: "那是个文件夹，不是文件" }, "write", verdict.path);
				}
				if (options.reads !== undefined && !options.reads.hasSeen(verdict.path)) {
					return failed(
						{
							ok: false,
							kind: "unread",
							message:
								"这个文件已经存在，你还没读过它。先 read 一遍，确认你要写的东西不会把它原来的内容冲掉，再回来写；要是只想加几句，用 append_file。",
						},
						"write",
						verdict.path,
					);
				}
			}

			try {
				atomicWrite(verdict.path, content);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return failed({ ok: false, kind: "failed", message: "没写进去：" + message }, "write", verdict.path);
			}
			if (!sameContent(verdict.path, content)) {
				return failed(
					{ ok: false, kind: "failed", message: "写完回读对不上，落盘可能没成功，等他来看一眼" },
					"write",
					verdict.path,
				);
			}
			return {
				content: [
					{
						type: "text",
						text:
							"写好了：" + verdict.path + "（" + String(linesOf(content)) + " 行，" + formatSize(bytes) + "）",
					},
				],
				details: { ok: true, action: "write", path: verdict.path, bytes },
			};
		},
	};

	const append: AgentTool = {
		name: "append_file",
		label: "往后加一段",
		description:
			"在一个文件末尾加内容（没有就新建）。加日记、记一笔、往清单后面续一条用它，比覆盖整份文件安全。只能写他放开给你的文件夹。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "文件路径" },
				text: { type: "string", description: "要加在末尾的内容（一般自己带换行）" },
			},
			required: ["path", "text"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<WriteToolDetails>> => {
			const args = params as { path?: unknown; text?: unknown };
			const asked = typeof args.path === "string" ? args.path.trim() : "";
			if (asked.length === 0) return failed({ ok: false, kind: "bad-path", message: "没给路径" }, "append");
			const text = typeof args.text === "string" ? args.text : "";
			const bytes = Buffer.byteLength(text, "utf8");
			if (bytes > maxBytes) return failed(tooBig(bytes, maxBytes), "append", asked);

			const verdict = await guard.check(asked);
			if (!verdict.ok) return failed(asWriteError(verdict), "append", asked);
			try {
				mkdirSync(dirname(verdict.path), { recursive: true });
				appendFileSync(verdict.path, text, "utf8");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return failed({ ok: false, kind: "failed", message: "没加上：" + message }, "append", verdict.path);
			}
			let total = 0;
			try {
				total = statSync(verdict.path).size;
			} catch {
				total = bytes;
			}
			return {
				content: [
					{
						type: "text",
						text:
							"加好了：" +
							verdict.path +
							"（这次 " +
							formatSize(bytes) +
							"，现在整份 " +
							formatSize(total) +
							"）",
					},
				],
				details: { ok: true, action: "append", path: verdict.path, bytes },
			};
		},
	};

	const mkdir: AgentTool = {
		name: "make_dir",
		label: "建个文件夹",
		description: "新建一个文件夹（需要的话连父目录一起建）。已经有了就算成功。只能建在他放开给你的地方。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "文件夹路径" },
			},
			required: ["path"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<WriteToolDetails>> => {
			const args = params as { path?: unknown };
			const asked = typeof args.path === "string" ? args.path.trim() : "";
			if (asked.length === 0) return failed({ ok: false, kind: "bad-path", message: "没给路径" }, "mkdir");
			const verdict = await guard.check(asked);
			if (!verdict.ok) return failed(asWriteError(verdict), "mkdir", asked);
			const before = existsSync(verdict.path);
			try {
				mkdirSync(verdict.path, { recursive: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return failed({ ok: false, kind: "failed", message: "没建成：" + message }, "mkdir", verdict.path);
			}
			return {
				content: [{ type: "text", text: before ? "本来就有：" + verdict.path : "建好了：" + verdict.path }],
				details: { ok: true, action: "mkdir", path: verdict.path },
			};
		},
	};

	const move: AgentTool = {
		name: "move_path",
		label: "改名 / 搬家",
		description:
			"把文件或整个文件夹改名或搬到别处（两边都要在他放开给你的地方）。目标位置已经存在就拒绝，不会覆盖。改名是动他的东西，做完要说一声。",
		parameters: {
			type: "object",
			properties: {
				from: { type: "string", description: "现在的位置" },
				to: { type: "string", description: "改成什么 / 搬到哪" },
			},
			required: ["from", "to"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<WriteToolDetails>> => {
			const args = params as { from?: unknown; to?: unknown };
			const asked = typeof args.from === "string" ? args.from.trim() : "";
			const target = typeof args.to === "string" ? args.to.trim() : "";
			if (asked.length === 0 || target.length === 0) {
				return failed({ ok: false, kind: "bad-path", message: "得给 from 和 to 两个路径" }, "move");
			}
			const source = await guard.check(asked);
			if (!source.ok) return failed(asWriteError(source), "move", asked);
			const destination = await guard.check(target);
			if (!destination.ok) return failed(asWriteError(destination), "move", target);
			if (!existsSync(source.path)) {
				return failed(
					{ ok: false, kind: "missing", message: "要改的那个东西不存在：" + source.path },
					"move",
					source.path,
				);
			}
			if (existsSync(destination.path)) {
				return failed(
					{ ok: false, kind: "exists", message: "目标位置已经有东西了：" + destination.path + "，换个名字" },
					"move",
					destination.path,
				);
			}
			try {
				mkdirSync(dirname(destination.path), { recursive: true });
				renameSync(source.path, destination.path);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return failed({ ok: false, kind: "failed", message: "没搬成：" + message }, "move", source.path);
			}
			if (!existsSync(destination.path) || existsSync(source.path)) {
				return failed(
					{ ok: false, kind: "failed", message: "搬完核对不对，可能没成功，等他来看一眼" },
					"move",
					source.path,
				);
			}
			return {
				content: [{ type: "text", text: "改好了：" + source.path + " → " + destination.path }],
				details: { ok: true, action: "move", path: source.path, target: destination.path },
			};
		},
	};

	const access: AgentTool = {
		name: "request_write",
		label: "跟他要写权限",
		description:
			"他还没放开给你写的文件夹，用这个跟他要：说清哪个文件夹、为什么想在那里写。他答应一次，那个文件夹以后就能写了。被挡住的时候用这个，别反复撞同一堵墙。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "想写的文件夹路径" },
				reason: { type: "string", description: "为什么想写，一句话，会原样给他看" },
			},
			required: ["path"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<WriteToolDetails>> => {
			const args = params as { path?: unknown; reason?: unknown };
			const asked = typeof args.path === "string" ? args.path.trim() : "";
			if (asked.length === 0) return failed({ ok: false, kind: "bad-path", message: "没给路径" }, "access");
			const reason = typeof args.reason === "string" ? args.reason.trim() : "";
			const verdict = await guard.check(asked, reason === "" ? {} : { reason });
			if (!verdict.ok) return failed(asWriteError(verdict), "access", asked);
			const grant = guard.allow(verdict.grant, { persist: true });
			return {
				content: [{ type: "text", text: "他放开了 " + grant + "，现在可以在 " + verdict.path + " 里写了。" }],
				details: { ok: true, action: "access", path: verdict.path, grant },
			};
		},
	};

	return [write, append, mkdir, move, access];
}
