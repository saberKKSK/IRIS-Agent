/**
 * 她能看的文件（ADR-0026）：只读三件 —— ls / read / grep，默认什么都看不到。
 *
 * 为什么只给只读三件：pi 的原生工具（bash / write / edit / powershell）在 coding-agent 里，
 * ADR-0012 裁剪时被删掉了；而 IRIS 自己的红线是「不冒充人类、未授权不动手」（04-consent.md）。
 * 能在他机器上执行任意命令的手要就一次给足、要就一条不给 —— 这里选后者。
 *
 * 授权：默认 fail-closed。路径必须落在 roots（默认家目录 + 当前工作目录）里，
 * 命中 deny 名单直接拒；**第一次碰某个文件夹要问人**，同意之后这个文件夹本次进程内都放行
 * （grant 单位 = 根目录下的第一层目录，例如 C:\Users\Admin\Desktop）。
 * 没人能问的时候（非交互、测试）一律拒，绝不默认放行。
 */

import type { Dirent } from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export type FileAction = "list" | "read" | "search";

export interface FileAccessRequest {
	action: FileAction;
	/** 她实际要碰的路径（绝对路径、已解析软链）。 */
	path: string;
	/** 授权单位：根目录下的第一层目录。同意一次，整个文件夹都放行。 */
	grant: string;
	/** 这个位置属于哪个根目录。他要「整个都放开」时记的就是这一层。 */
	root: string;
	/** 她想看这里的理由（她开口要权限时填），直接给人看。 */
	reason?: string;
}

export const DEFAULT_DENY_NAMES: readonly string[] = [
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	".docker",
	".password-store",
	"id_rsa",
	"id_ed25519",
	"Login Data",
	"Cookies",
	"Local State",
	".env",
];

export const DEFAULT_DENY_EXTENSIONS: readonly string[] = [".pem", ".key", ".pfx", ".p12", ".kdbx", ".keystore"];

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	".nuxt",
	".cache",
	"coverage",
	"__pycache__",
	".venv",
	"venv",
	".idea",
	".vscode",
	".artifacts",
]);

const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".ico",
	".pdf",
	".zip",
	".gz",
	".7z",
	".rar",
	".exe",
	".dll",
	".so",
	".dylib",
	".bin",
	".dat",
	".mp3",
	".mp4",
	".wav",
	".mov",
	".mkv",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".db",
	".sqlite",
	".class",
	".pyc",
	".wasm",
]);

export interface FileGuardOptions {
	/** 允许看的根目录，默认 [家目录, 当前工作目录]。 */
	roots?: readonly string[];
	denyNames?: readonly string[];
	denyExtensions?: readonly string[];
	/** 问人的回调：返回 true 才放行。不提供就是「谁都问不了」= 一律拒。 */
	approve?: (request: FileAccessRequest) => boolean | Promise<boolean>;
	/**
	 * 他说过「以后都放开」的文件夹记在这个文件里（JSON 数组，一行一个绝对路径）。
	 * 给了就整个进程跨重启生效；不给就只在本次进程内记着。
	 */
	grantsFile?: string;
}

export interface FileAllowed {
	ok: true;
	path: string;
	root: string;
	grant: string;
}

export interface FileDenied {
	ok: false;
	reason: string;
	/** 是因为没人同意/没人可问才拒的（区别于路径不合法）。 */
	needsPermission: boolean;
}

export type FileVerdict = FileAllowed | FileDenied;

export type FileErrorKind = "denied" | "missing" | "not-a-file" | "binary" | "bad-pattern" | "too-big";

export interface FileError {
	ok: false;
	kind: FileErrorKind;
	message: string;
	needsPermission?: boolean;
}

export interface FileText {
	ok: true;
	text: string;
	truncated: boolean;
	bytes: number;
}

function lower(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value;
}

/** 桌面、下载、文档这些口语说法对应到家目录下的哪个名字（中文 Windows 的显示名和真实目录名不是一回事）。 */
const SHELL_FOLDERS: Readonly<Record<string, string>> = {
	桌面: "Desktop",
	桌面文件夹: "Desktop",
	下载: "Downloads",
	文档: "Documents",
	我的文档: "Documents",
	图片: "Pictures",
	我的图片: "Pictures",
	音乐: "Music",
	视频: "Videos",
};

/**
 * 把「他嘴上说的路径」翻成真路径：去引号、展开 ~、认「桌面」「下载」这类口语名。
 * 不做存在性检查，也不判断能不能看——那是 FileGuard 的事。
 */
export function expandPath(input: string): string {
	const trimmed = input
		.trim()
		.replace(/^["'“”‘’]+/u, "")
		.replace(/["'“”‘’]+$/u, "")
		.trim();
	if (trimmed === "") return trimmed;

	let rest = trimmed;
	if (rest === "~") return homedir();
	if (rest.startsWith("~/") || rest.startsWith("~\\")) {
		const tail = rest.slice(2).trim();
		rest = tail === "" ? homedir() : join(homedir(), tail);
	}

	const bare = rest.replace(/[\\/]+$/u, "");
	const mapped = SHELL_FOLDERS[bare];
	if (mapped !== undefined) return join(homedir(), mapped);
	return resolve(rest);
}

/**
 * 路径里有「桌面 / 下载 / 文档」这类口语名，但整条路径并不存在时，猜一下他真正指的是哪儿。
 * 只在报错提示里用，不改变判定。
 */
export function suggestPath(input: string): string | null {
	const parts = input.split(/[\\/]+/u).filter((part) => part !== "");
	for (const [index, part] of parts.entries()) {
		const mapped = SHELL_FOLDERS[part];
		if (mapped === undefined) continue;
		const rest = parts.slice(index + 1);
		return rest.length === 0 ? join(homedir(), mapped) : join(homedir(), mapped, ...rest);
	}
	return null;
}

function canonical(path: string): string {
	const absolute = resolve(expandPath(path));
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

function inside(root: string, path: string): boolean {
	if (lower(root) === lower(path)) return true;
	const prefix = root.endsWith(sep) ? root : root + sep;
	return lower(path).startsWith(lower(prefix));
}

/** 判断 path 是不是在 root 里面（大小写不敏感；写工具也要用同一把尺子）。 */
export function pathInside(root: string, path: string): boolean {
	return inside(root, path);
}

/** 授权单位：根目录下第一层。根目录本身、或直接躺在根目录下的文件，授权单位就是根目录。 */
function grantOf(root: string, path: string): string {
	if (lower(root) === lower(path)) return root;
	const rest = path.slice(root.endsWith(sep) ? root.length : root.length + 1);
	const first = rest.split(sep)[0] ?? "";
	if (first === "") return root;
	return root.endsWith(sep) ? root + first : root + sep + first;
}

/** 他放开的文件夹存在哪：IRIS_GRANTS 环境变量优先，否则 ~/.iris/file-roots.json。 */
export function defaultGrantsPath(): string {
	return process.env.IRIS_GRANTS ?? join(homedir(), ".iris", "file-roots.json");
}

/** 读「他放开的文件夹」；文件不在、写坏了，一律当没放开过（fail-closed）。 */
export function readGrantFile(path: string): string[] {
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

export function formatSize(bytes: number): string {
	if (bytes < 1024) return bytes + " B";
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
	return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

export function cut(value: string, max: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : oneLine.slice(0, max) + "…";
}

/** 只读文件的守门人：谁能看、看哪里，全在这里判。 */
export class FileGuard {
	readonly roots: readonly string[];
	private readonly denyNames: Set<string>;
	private readonly denyExtensions: Set<string>;
	private readonly approve: FileGuardOptions["approve"];
	private readonly grantsFile: string | null;
	private readonly granted = new Set<string>();
	/** 他明确说过「以后都放开」的那些，落在这个文件里。 */
	private persisted: string[];
	/** 人工点过名的那个位置：不传路径时从这里看起（比授权单位更具体）。 */
	private preferred: string | null = null;
	/** 这次进程里她真读过哪些文件：写工具用它拦「没看过就覆盖」。 */
	private readonly seen = new Set<string>();

	constructor(options: FileGuardOptions = {}) {
		this.roots = (options.roots ?? [homedir(), process.cwd()]).map((root) => canonical(root));
		this.denyNames = new Set((options.denyNames ?? DEFAULT_DENY_NAMES).map((name) => lower(name)));
		this.denyExtensions = new Set((options.denyExtensions ?? DEFAULT_DENY_EXTENSIONS).map((name) => lower(name)));
		this.approve = options.approve;
		this.grantsFile = options.grantsFile ?? null;
		this.persisted = this.grantsFile === null ? [] : readGrantFile(this.grantsFile);
		for (const grant of this.persisted) this.granted.add(grant);
	}

	/** 已经同意过的文件夹（本次进程内，含他以前放开的）。 */
	get grants(): readonly string[] {
		return [...this.granted];
	}

	/** 他明确放开过、记在文件里的那些。 */
	get storedGrants(): readonly string[] {
		return [...this.persisted];
	}

	/** 不传路径时从哪看起：先看他点过名的地方，其次是他同意过的文件夹，最后才是根目录。 */
	get defaultPath(): string {
		const granted = [...this.granted];
		return this.preferred ?? granted[0] ?? this.roots[0] ?? canonical(".");
	}

	/** 记下「这个文件她读过了」——覆盖前要先看过，别拿自己的版本盖掉他原来写的（ADR-0034）。 */
	noteSeen(target: string): void {
		this.seen.add(lower(canonical(target)));
	}

	hasSeen(target: string): boolean {
		return this.seen.has(lower(canonical(target)));
	}

	/** 该不该让她碰这个路径。不抛错，一律给判定。 */
	async check(action: FileAction, target: string, options: { reason?: string } = {}): Promise<FileVerdict> {
		const absolute = canonical(target);
		const denied = this.deniedReason(absolute);
		if (denied !== null) return { ok: false, reason: denied, needsPermission: false };

		// 家目录 / 当前工作目录只是一开始的起点，不是天花板：他点头了，家目录外面也能放开
		const root = this.roots.find((candidate) => inside(candidate, absolute));
		const grant = root === undefined ? absolute : grantOf(root, absolute);
		// 他放开过更上层（比如整个家目录）时，下面全都算放开
		if (!this.covered(absolute)) {
			if (this.approve === undefined) {
				return { ok: false, reason: "看 " + grant + " 得他先同意，这会儿没人能问我", needsPermission: true };
			}
			const reason = options.reason?.trim() ?? "";
			const request: FileAccessRequest = {
				action,
				path: absolute,
				grant,
				root: root ?? grant,
				...(reason === "" ? {} : { reason }),
			};
			const allowed = await this.approve(request);
			if (!allowed) {
				return {
					ok: false,
					reason: "他没同意我看 " + grant + "（要就开口跟他要，用 request_access；他答应一次，以后就都放开了）",
					needsPermission: true,
				};
			}
			this.granted.add(grant);
		}
		return { ok: true, path: absolute, root: root ?? grant, grant };
	}

	/**
	 * 放行，不再问人。默认记进 grantsFile（他放开的就应该一直算数）。
	 * 记的是授权单位而不是给的这条路径：给他 `...\notes\今天` 放行的是 `...\notes` 那一层；
	 * 给到根目录（家目录）就整棵树都放开。
	 */
	allow(target: string, options: { persist?: boolean } = {}): string {
		const absolute = canonical(target);
		const root = this.roots.find((candidate) => inside(candidate, absolute));
		this.preferred = absolute;
		const grant = root === undefined ? absolute : grantOf(root, absolute);
		this.granted.add(grant);
		if (options.persist !== false) this.persist(grant);
		return grant;
	}

	/** 收回一个放行（他改主意了）。返回是否真的删掉了记录。 */
	disallow(target: string): boolean {
		const absolute = canonical(target);
		const root = this.roots.find((candidate) => inside(candidate, absolute));
		const grant = root === undefined ? absolute : grantOf(root, absolute);
		const before = this.persisted.length;
		this.persisted = this.persisted.filter((item) => lower(item) !== lower(grant));
		this.granted.delete(grant);
		if (this.persisted.length !== before) this.writeGrants();
		return this.persisted.length !== before;
	}

	private covered(path: string): boolean {
		for (const grant of this.granted) {
			if (inside(grant, path)) return true;
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
			// 存不下来不影响这一次的放行
		}
	}

	private deniedReason(path: string): string | null {
		for (const segment of path.split(sep)) {
			if (this.denyNames.has(lower(segment))) return "这类东西（" + segment + "）我不碰";
		}
		const extension = lower(extname(path));
		if (extension !== "" && this.denyExtensions.has(extension)) return "这类文件（" + extension + "）我不碰";
		return null;
	}
}

function asFileError(verdict: FileDenied): FileError {
	return { ok: false, kind: "denied", message: verdict.reason, needsPermission: verdict.needsPermission };
}

export interface FileReadOptions {
	maxBytes?: number;
}

/** 读一个文本文件；二进制与超大文件都拒，不静默截断成乱码。 */
export function readText(path: string, options: FileReadOptions = {}): FileText | FileError {
	const maxBytes = options.maxBytes ?? 200_000;
	const name = path.toLowerCase();
	const extension = extname(name);
	if (BINARY_EXTENSIONS.has(extension)) {
		return { ok: false, kind: "binary", message: "这是 " + extension + " 这类文件，读不出文字" };
	}
	let info: ReturnType<typeof statSync>;
	try {
		info = statSync(path);
	} catch {
		return { ok: false, kind: "missing", message: "这个文件不存在：" + path };
	}
	if (!info.isFile()) return { ok: false, kind: "not-a-file", message: "这不是文件：" + path };
	const bytes = Math.min(info.size, maxBytes);
	const buffer = readFileSync(path).subarray(0, bytes);
	if (buffer.includes(0)) return { ok: false, kind: "binary", message: "这文件里有二进制内容，读不出文字" };
	return {
		ok: true,
		text: buffer.toString("utf8"),
		truncated: info.size > bytes,
		bytes: info.size,
	};
}

export interface ListEntry {
	name: string;
	kind: "dir" | "file" | "link";
	size: number;
}

export interface ListResult {
	ok: true;
	path: string;
	entries: readonly ListEntry[];
	truncated: boolean;
	total: number;
}

/** 列一层目录：目录在前、文件在后，各按名字排。 */
export function listDirectory(path: string, limit = 80): ListResult | FileError {
	let raw: Dirent[];
	try {
		if (!statSync(path).isDirectory()) return { ok: false, kind: "not-a-file", message: "这不是文件夹：" + path };
		raw = readdirSync(path, { withFileTypes: true });
	} catch {
		return { ok: false, kind: "missing", message: "打不开这个文件夹：" + path };
	}
	const entries: ListEntry[] = [];
	for (const entry of raw) {
		if (entry.isSymbolicLink()) {
			entries.push({ name: entry.name, kind: "link", size: 0 });
			continue;
		}
		if (entry.isDirectory()) {
			entries.push({ name: entry.name, kind: "dir", size: 0 });
			continue;
		}
		if (entry.isFile()) {
			let size = 0;
			try {
				size = statSync(join(path, entry.name)).size;
			} catch {
				size = 0;
			}
			entries.push({ name: entry.name, kind: "file", size });
		}
	}
	const order = (entry: ListEntry): number => (entry.kind === "dir" ? 0 : entry.kind === "file" ? 1 : 2);
	entries.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
	const total = entries.length;
	return { ok: true, path, entries: entries.slice(0, limit), truncated: total > limit, total };
}

export function renderListing(result: ListResult): string {
	const lines = [result.path + "（" + result.total + " 项）"];
	for (const entry of result.entries) {
		if (entry.kind === "dir") {
			lines.push("[目录] " + entry.name);
			continue;
		}
		if (entry.kind === "link") {
			lines.push("[链接] " + entry.name);
			continue;
		}
		lines.push("[文件] " + entry.name + "　" + formatSize(entry.size));
	}
	if (result.entries.length === 0) lines.push("（空的）");
	if (result.truncated) lines.push("（只列了前 " + result.entries.length + " 项）");
	return lines.join("\n");
}

export interface ReadSlice {
	ok: true;
	text: string;
	firstLine: number;
	lastLine: number;
	totalLines: number;
}

/** 按行切一段，带行号（行号是给模型对齐用的，她不会照着念）。 */
export function sliceLines(text: string, offset = 1, limit = 200): ReadSlice {
	const lines = text.split("\n");
	const start = Math.max(1, Math.min(offset, lines.length === 0 ? 1 : lines.length));
	const end = Math.min(lines.length, start + Math.max(1, limit) - 1);
	const numbered: string[] = [];
	for (let index = start; index <= end; index += 1) {
		numbered.push(index + "\t" + (lines[index - 1] ?? ""));
	}
	return { ok: true, text: numbered.join("\n"), firstLine: start, lastLine: end, totalLines: lines.length };
}

function walkFiles(root: string, maxFiles: number): string[] {
	const out: string[] = [];
	const queue: string[] = [root];
	while (queue.length > 0 && out.length < maxFiles) {
		const dir = queue.shift() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (out.length >= maxFiles) break;
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				queue.push(join(dir, entry.name));
				continue;
			}
			if (entry.isFile()) out.push(join(dir, entry.name));
		}
	}
	return out;
}

export interface GrepHit {
	path: string;
	line: number;
	text: string;
}

export interface GrepResult {
	ok: true;
	pattern: string;
	hits: readonly GrepHit[];
	files: number;
	truncated: boolean;
}

export interface GrepOptions {
	include?: string;
	maxResults?: number;
	maxFiles?: number;
	maxFileBytes?: number;
}

function matchesInclude(name: string, include: string | undefined): boolean {
	if (include === undefined || include === "") return true;
	const patterns = include
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (patterns.length === 0) return true;
	for (const pattern of patterns) {
		if (pattern.startsWith("*.")) {
			if (name.toLowerCase().endsWith(pattern.slice(1).toLowerCase())) return true;
			continue;
		}
		if (name.toLowerCase().endsWith(pattern.toLowerCase())) return true;
	}
	return false;
}

/** 在文件或目录里搜正则；二进制、跳过目录、超大文件都不碰。 */
export function searchFiles(path: string, pattern: string, options: GrepOptions = {}): GrepResult | FileError {
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, "i");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, kind: "bad-pattern", message: "这个正则不合法：" + message };
	}
	const maxResults = options.maxResults ?? 60;
	const maxFiles = options.maxFiles ?? 400;
	const maxFileBytes = options.maxFileBytes ?? 1_000_000;

	let files: string[];
	try {
		const info = statSync(path);
		if (info.isFile()) files = [path];
		else files = walkFiles(path, maxFiles);
	} catch {
		return { ok: false, kind: "missing", message: "这个位置不存在：" + path };
	}

	const hits: GrepHit[] = [];
	let scanned = 0;
	let truncated = false;
	for (const file of files) {
		if (hits.length >= maxResults) {
			truncated = true;
			break;
		}
		if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) continue;
		if (!matchesInclude(file.slice(file.lastIndexOf(sep) + 1), options.include)) continue;
		let info: ReturnType<typeof statSync>;
		try {
			info = statSync(file);
		} catch {
			continue;
		}
		if (!info.isFile() || info.size > maxFileBytes) continue;
		scanned += 1;
		let text: string;
		try {
			const buffer = readFileSync(file);
			if (buffer.includes(0)) continue;
			text = buffer.toString("utf8");
		} catch {
			continue;
		}
		const lines = text.split("\n");
		for (const [index, line] of lines.entries()) {
			if (!regex.test(line)) continue;
			hits.push({ path: file, line: index + 1, text: cut(line, 200) });
			if (hits.length >= maxResults) {
				truncated = true;
				break;
			}
		}
	}
	return { ok: true, pattern, hits, files: scanned, truncated };
}

export function renderGrep(result: GrepResult, root: string): string {
	const head =
		"在 " +
		root +
		" 里搜「" +
		result.pattern +
		"」：命中 " +
		result.hits.length +
		" 处（翻了 " +
		result.files +
		" 个文件）";
	const lines = [head];
	for (const hit of result.hits) {
		const relative = hit.path.startsWith(root) ? hit.path.slice(root.length).replace(/^[\\/]/, "") : hit.path;
		lines.push(relative + ":" + hit.line + ": " + hit.text);
	}
	if (result.hits.length === 0) lines.push("（一处都没有）");
	if (result.truncated) lines.push("（到这里就停了，后面还有）");
	return lines.join("\n");
}

export interface FileToolDetails {
	ok: boolean;
	action: FileAction | "access";
	path?: string;
	entries?: number;
	hits?: number;
	/** 这次确实放开的授权单位（request_access 用）。 */
	grant?: string;
	needsPermission?: boolean;
	error?: string;
	kind?: FileErrorKind;
}

export interface FileToolOptions extends FileGuardOptions {
	/** 一个文件最多读多少字节，默认 200 000。 */
	maxReadBytes?: number;
	/** 列目录最多列多少项，默认 80。 */
	maxListEntries?: number;
	/** 搜的时候最多返多少处，默认 60。 */
	maxResults?: number;
	/** 搜的时候最多翻多少个文件，默认 400。 */
	maxFiles?: number;
	/** 直接用现成的守门人（REPL 要共享授权状态时用）。 */
	guard?: FileGuard;
}

/** 路径里出现了口语文件夹名，就把它翻成真路径一起给出。 */
function suggestHint(input: string): string {
	const suggested = suggestPath(input);
	return suggested === null ? "" : "；你说的那个是不是 " + suggested;
}

/** 只在「压根没这个路径」时补一句怎么找，别的错误原样返回。 */
function withHint(error: FileError, hint: string): FileError {
	return error.kind === "missing" ? { ...error, message: error.message + hint } : error;
}

function failed(error: FileError, action: FileAction | "access", path?: string): AgentToolResult<FileToolDetails> {
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

/** 给 pi 用的只读文件工具：ls / read / grep。 */
export function fileTools(options: FileToolOptions = {}): AgentTool[] {
	const guard = options.guard ?? new FileGuard(options);

	const ls: AgentTool = {
		name: "ls",
		label: "看文件夹",
		description:
			"看看某个文件夹里有什么。只能看他同意过的文件夹；没同意的会问你。他提到某个文件名、让你念点什么的时候，先 ls 看看手上那几个文件夹里有没有，再 read，别猜。不传路径就看已经同意过的那个文件夹。",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"文件夹路径，可省。写「桌面」「下载」这种也行，~/notes 也认；不传就从你手边那个文件夹开始列",
				},
			},
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<FileToolDetails>> => {
			const args = params as { path?: unknown };
			const asked =
				typeof args.path === "string" && args.path.trim().length > 0 ? args.path.trim() : guard.defaultPath;
			const verdict = await guard.check("list", asked);
			if (!verdict.ok) return failed(asFileError(verdict), "list", asked);
			const listed = listDirectory(verdict.path, options.maxListEntries ?? 80);
			if (listed.ok === false)
				return failed(withHint(listed, "（不传路径就从 " + guard.defaultPath + " 开始列）"), "list", verdict.path);
			return {
				content: [{ type: "text", text: renderListing(listed) }],
				details: { ok: true, action: "list", path: verdict.path, entries: listed.total },
			};
		},
	};

	const read: AgentTool = {
		name: "read",
		label: "看一个文件",
		description:
			"读一个文本文件。默认从头读 200 行，可以指定从第几行开始、读多少行。只能读他同意过的文件夹里的文件。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "文件路径" },
				offset: { type: "integer", minimum: 1, description: "从第几行开始，从 1 数，可省" },
				limit: { type: "integer", minimum: 1, maximum: 500, description: "读多少行，默认 200" },
			},
			required: ["path"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<FileToolDetails>> => {
			const args = params as { path?: unknown; offset?: unknown; limit?: unknown };
			const asked = typeof args.path === "string" ? args.path.trim() : "";
			if (asked.length === 0) {
				return failed({ ok: false, kind: "missing", message: "没给路径" }, "read");
			}
			const verdict = await guard.check("read", asked);
			if (!verdict.ok) return failed(asFileError(verdict), "read", asked);
			const text = readText(verdict.path, { maxBytes: options.maxReadBytes ?? 200_000 });
			if (text.ok === false) {
				return failed(
					withHint(text, "（路径不对就先 ls 看看那个文件夹里有什么" + suggestHint(asked) + "）"),
					"read",
					verdict.path,
				);
			}
			const offset = typeof args.offset === "number" ? Math.floor(args.offset) : 1;
			const limit = typeof args.limit === "number" ? Math.floor(args.limit) : 200;
			guard.noteSeen(verdict.path);
			const slice = sliceLines(text.text, offset, limit);
			const lines = [
				verdict.path +
					"（共 " +
					slice.totalLines +
					" 行，这次看第 " +
					slice.firstLine +
					" 到 " +
					slice.lastLine +
					" 行）",
			];
			lines.push(slice.text);
			if (slice.lastLine < slice.totalLines)
				lines.push("（后面还有 " + (slice.totalLines - slice.lastLine) + " 行）");
			if (text.truncated) lines.push("（文件太大，只读了前面一段）");
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { ok: true, action: "read", path: verdict.path },
			};
		},
	};

	const grep: AgentTool = {
		name: "grep",
		label: "搜文件内容",
		description:
			"在他同意过的文件夹里搜关键词或正则，返回命中的行。找「哪个文件里提过这件事」用它，比一个个文件翻快得多。",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "要找的内容，普通词就行，也认正则" },
				path: { type: "string", description: "从哪个文件夹开始搜，可省（默认家目录）" },
				include: { type: "string", description: "只看这类文件，例如 *.md 或 .ts，可省" },
			},
			required: ["pattern"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<FileToolDetails>> => {
			const args = params as { pattern?: unknown; path?: unknown; include?: unknown };
			const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
			if (pattern.length === 0) {
				return failed({ ok: false, kind: "bad-pattern", message: "没给要找的东西" }, "search");
			}
			const asked =
				typeof args.path === "string" && args.path.trim().length > 0 ? args.path.trim() : guard.defaultPath;
			const verdict = await guard.check("search", asked);
			if (!verdict.ok) return failed(asFileError(verdict), "search", asked);
			const result = searchFiles(verdict.path, pattern, {
				...(typeof args.include === "string" ? { include: args.include } : {}),
				maxResults: options.maxResults ?? 60,
				maxFiles: options.maxFiles ?? 400,
			});
			if (result.ok === false) return failed(result, "search", verdict.path);
			return {
				content: [{ type: "text", text: renderGrep(result, verdict.path) }],
				details: { ok: true, action: "search", path: verdict.path, hits: result.hits.length },
			};
		},
	};

	const access: AgentTool = {
		name: "request_access",
		label: "跟他要权限",
		description:
			"他还没放给你的文件夹，用这个直接跟他要：说清是哪个文件夹、为什么想看。他答应一次，那个文件夹以后就都放开了，不用每次问。被他挡下来的时候用这个，别反复 ls 撞同一堵墙，也别让他自己去拼路径。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "想看的文件夹路径，写「桌面」「下载」这种也行" },
				reason: { type: "string", description: "为什么想看，一句话，会原样给他看" },
			},
			required: ["path"],
			additionalProperties: false,
		},
		execute: async (_toolCallId, params): Promise<AgentToolResult<FileToolDetails>> => {
			const args = params as { path?: unknown; reason?: unknown };
			const asked = typeof args.path === "string" ? args.path.trim() : "";
			if (asked.length === 0) {
				return failed({ ok: false, kind: "missing", message: "没给路径" }, "access");
			}
			const reason = typeof args.reason === "string" ? args.reason.trim() : "";
			const verdict = await guard.check("list", asked, reason === "" ? {} : { reason });
			if (!verdict.ok) return failed(asFileError(verdict), "access", asked);
			// 他刚亲口答应了，就记下来：以后不用再问（ADR-0033）
			const grant = guard.allow(verdict.grant, { persist: true });
			return {
				content: [{ type: "text", text: "他放开了 " + grant + "，现在可以看 " + verdict.path + " 了。" }],
				details: { ok: true, action: "access", path: verdict.path, grant },
			};
		},
	};

	return [ls, read, grep, access];
}
