/**
 * 只读文件三件（ADR-0026）：谁能看、看哪里、看不到怎么说。
 * 全部在临时目录里跑，不碰真家目录。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	expandPath,
	FileGuard,
	fileTools,
	listDirectory,
	readGrantFile,
	readText,
	searchFiles,
	sliceLines,
	suggestPath,
} from "../src/files.ts";

const sandbox = mkdtempSync(join(tmpdir(), "iris-files-"));
after(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

/** 造一份固定的目录树：notes/ 下两个文件，根下两个文件。 */
function seed(): string {
	const dir = mkdtempSync(join(sandbox, "case-"));
	mkdirSync(join(dir, "notes"));
	writeFileSync(join(dir, "notes", "todo.md"), "# 待办\n买花生\n改周报\n", "utf8");
	writeFileSync(join(dir, "notes", "code.ts"), "const a = 1;\n// 花生在这里\n", "utf8");
	writeFileSync(join(dir, "plain.txt"), "第一行\n第二行\n", "utf8");
	writeFileSync(join(dir, "b.txt"), "别的内容\n", "utf8");
	return dir;
}

/** 工具结果里的第一段文字（content 的类型是文本或图片的联合）。 */
function textOf(result: { content: readonly unknown[] } | undefined): string {
	const first = result?.content[0] as { type?: string; text?: string } | undefined;
	return first?.type === "text" ? (first.text ?? "") : "";
}

test("没人在场就不放行：needsPermission 为真，且不问任何人", async () => {
	const dir = seed();
	const guard = new FileGuard({ roots: [dir] });
	const verdict = await guard.check("read", join(dir, "plain.txt"));
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false ? verdict.needsPermission : null, true);
	assert.deepEqual(guard.grants, []);
});

test("问一次、同意一次，同一个文件夹后面不再问", async () => {
	const dir = seed();
	const asked: string[] = [];
	const guard = new FileGuard({
		roots: [dir],
		approve: (request) => {
			asked.push(request.grant);
			return true;
		},
	});
	const first = await guard.check("read", join(dir, "notes", "todo.md"));
	const second = await guard.check("read", join(dir, "notes", "code.ts"));
	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(asked.length, 1);
	assert.equal(guard.grants.length, 1);
	// 授权单位是根目录下第一层，不是文件本身
	assert.equal(first.ok === true ? first.grant : "", join(dir, "notes"));
});

test("他不同意就看不到，而且说的是他不同意", async () => {
	const dir = seed();
	const guard = new FileGuard({ roots: [dir], approve: () => false });
	const verdict = await guard.check("list", join(dir, "notes"));
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false ? verdict.needsPermission : null, true);
	assert.match(verdict.ok === false ? verdict.reason : "", /没同意/);
});

test("事先放行：给的是深处路径，记的是它那一层，也不再问人", async () => {
	const dir = seed();
	let asked = 0;
	const guard = new FileGuard({
		roots: [dir],
		approve: () => {
			asked += 1;
			return true;
		},
	});
	guard.allow(join(dir, "notes", "todo.md"));
	assert.deepEqual(guard.grants, [join(dir, "notes")]);
	// 点过名的地方就是不传路径时的起点（比授权单位更具体）
	assert.equal(guard.defaultPath, join(dir, "notes", "todo.md"));
	const verdict = await guard.check("read", join(dir, "notes", "code.ts"));
	assert.equal(verdict.ok, true);
	assert.equal(asked, 0);
});

test("根目录之外不再直接挡死：他会问一句，点头就放开（ADR-0033 补记）", async () => {
	const dir = seed();
	const outside = join(mkdtempSync(join(sandbox, "outside0-")), "notes.txt");
	writeFileSync(outside, "外面\n", "utf8");
	const asked: string[] = [];
	const guard = new FileGuard({
		roots: [dir],
		approve: (request) => {
			asked.push(request.grant);
			return false;
		},
	});
	const denied = await guard.check("read", outside);
	assert.equal(denied.ok, false);
	assert.equal(denied.ok === false ? denied.needsPermission : false, true);
	assert.equal(asked.length, 1);
});

test("不碰的目录与扩展名：.ssh 与 .pem 一律拒", async () => {
	const dir = seed();
	mkdirSync(join(dir, ".ssh"));
	writeFileSync(join(dir, ".ssh", "config"), "Host *\n", "utf8");
	writeFileSync(join(dir, "server.pem"), "-----BEGIN-----\n", "utf8");
	const guard = new FileGuard({ roots: [dir], approve: () => true });
	const secret = await guard.check("read", join(dir, ".ssh", "config"));
	const key = await guard.check("read", join(dir, "server.pem"));
	assert.equal(secret.ok, false);
	assert.match(secret.ok === false ? secret.reason : "", /\.ssh/);
	assert.equal(key.ok, false);
	assert.match(key.ok === false ? key.reason : "", /\.pem/);
});

test("二进制文件不硬读成乱码：看扩展名，也看有没有 NUL", () => {
	const dir = seed();
	writeFileSync(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(join(dir, "weird.txt"), Buffer.from([0x41, 0x00, 0x42]));
	const byExtension = readText(join(dir, "shot.png"));
	const byContent = readText(join(dir, "weird.txt"));
	const missing = readText(join(dir, "nope.txt"));
	assert.equal(byExtension.ok, false);
	assert.equal(byExtension.ok === false ? byExtension.kind : "", "binary");
	assert.equal(byContent.ok, false);
	assert.equal(byContent.ok === false ? byContent.kind : "", "binary");
	assert.equal(missing.ok, false);
	assert.equal(missing.ok === false ? missing.kind : "", "missing");
});

test("按行切一段：行号、边界与总行数", () => {
	const text = "a\nb\nc\nd";
	const slice = sliceLines(text, 2, 2);
	assert.equal(slice.firstLine, 2);
	assert.equal(slice.lastLine, 3);
	assert.equal(slice.totalLines, 4);
	assert.equal(slice.text, "2\tb\n3\tc");
	// 越界的起点收敛到末行，不会返回空段
	const tail = sliceLines(text, 99, 2);
	assert.equal(tail.firstLine, 4);
	assert.equal(tail.lastLine, 4);
});

test("列目录：目录排前面，超量就截断并说明总数", () => {
	const dir = seed();
	const listed = listDirectory(dir, 2);
	assert.equal(listed.ok, true);
	assert.equal(listed.ok === true ? listed.total : -1, 3);
	assert.equal(listed.entries.length, 2);
	assert.equal(listed.truncated, true);
	assert.equal(listed.entries[0]?.kind, "dir");
	assert.equal(listed.entries[0]?.name, "notes");
});

test("搜内容：命中行号、按扩展名过滤、跳过 node_modules、坏正则不炸", () => {
	const dir = seed();
	mkdirSync(join(dir, "node_modules"));
	writeFileSync(join(dir, "node_modules", "x.ts"), "// 花生\n", "utf8");

	const all = searchFiles(dir, "花生");
	assert.equal(all.ok, true);
	const allHits = all.ok === true ? all.hits : [];
	assert.equal(allHits.length, 2);
	assert.ok(allHits.some((hit) => hit.path.endsWith("todo.md") && hit.line === 2));
	assert.ok(!allHits.some((hit) => hit.path.includes("node_modules")));

	const onlyTs = searchFiles(dir, "花生", { include: "*.ts" });
	assert.equal(onlyTs.ok, true);
	assert.equal(onlyTs.ok === true ? onlyTs.hits.length : -1, 1);

	const bad = searchFiles(dir, "[");
	assert.equal(bad.ok, false);
	assert.equal(bad.ok === false ? bad.kind : "", "bad-pattern");
});

test("四个工具：名字对齐 pi、没同意就报错不抛、同意了真能看", async () => {
	const dir = seed();
	const tools = fileTools({ roots: [dir] });
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["ls", "read", "grep", "request_access"],
	);

	const ls = tools[0];
	const read = tools[1];
	const grep = tools[2];
	assert.ok(ls !== undefined && read !== undefined && grep !== undefined);
	const denied = await ls.execute("call-1", { path: dir });
	assert.equal(denied.isError, true);
	assert.equal(denied.details.needsPermission, true);

	const allowed = fileTools({ roots: [dir], approve: () => true });
	const listing = await allowed[0]?.execute("call-2", { path: dir });
	assert.equal(listing?.isError, undefined);
	assert.match(textOf(listing), /\[目录\] notes/);

	const file = await allowed[1]?.execute("call-3", { path: join(dir, "plain.txt") });
	assert.match(textOf(file), /第一行/);

	const hits = await allowed[2]?.execute("call-4", { pattern: "花生", path: dir });
	assert.match(textOf(hits), /命中 2 处/);
});

test("他放开过就记住：落盘，重启后不用再问", async () => {
	const dir = seed();
	const grantsFile = join(dir, "..", "file-roots.json");
	const asked: string[] = [];
	const first = new FileGuard({
		roots: [dir],
		grantsFile,
		approve: (request) => {
			asked.push(request.grant);
			return true;
		},
	});
	const before = await first.check("list", join(dir, "notes"));
	assert.equal(before.ok, true);
	assert.equal(asked.length, 1);
	// 「就这次」不落盘：这次进程内算数，重启就忘
	assert.deepEqual(first.storedGrants, []);
	// 「a = 以后都放开」才落盘
	assert.equal(first.allow(join(dir, "notes"), { persist: true }), join(dir, "notes"));
	assert.deepEqual(first.storedGrants, [join(dir, "notes")]);
	assert.deepEqual(readGrantFile(grantsFile), [join(dir, "notes")]);

	// 新进程：同一个文件，问人的回调直接拒，也应该放行
	const second = new FileGuard({
		roots: [dir],
		grantsFile,
		approve: () => false,
	});
	const again = await second.check("read", join(dir, "notes", "todo.md"));
	assert.equal(again.ok, true);
	assert.equal(second.disallow(join(dir, "notes")), true);
	assert.equal(readGrantFile(grantsFile).length, 0);

	const third = new FileGuard({ roots: [dir], grantsFile, approve: () => false });
	const afterForget = await third.check("read", join(dir, "notes", "todo.md"));
	assert.equal(afterForget.ok, false);
	assert.equal(afterForget.ok === false ? afterForget.needsPermission : false, true);
});

test("放开整个根目录：下面全算放开", async () => {
	const dir = seed();
	const guard = new FileGuard({ roots: [dir] });
	guard.allow(dir);
	const verdict = await guard.check("read", join(dir, "notes", "todo.md"));
	assert.equal(verdict.ok, true);
});

test("request_access：她开口要，他答应之后那个文件夹就一直开着", async () => {
	const dir = seed();
	const asked: string[] = [];
	const guard = new FileGuard({
		roots: [dir],
		approve: (request) => {
			asked.push(request.reason ?? "");
			return true;
		},
	});
	const tools = fileTools({ guard });
	const access = tools.find((tool) => tool.name === "request_access");
	assert.ok(access !== undefined);
	const result = await access.execute("call-a", { path: join(dir, "notes"), reason: "想看看那份便签" });
	assert.equal(result.isError, undefined);
	assert.match(textOf(result), /现在可以看/u);
	assert.equal(asked.length, 1);
	assert.equal(asked[0], "想看看那份便签");
	// 要过之后不用再问：换一个没挂 approve 的守门人也能看（同一个 guard 已经记着）
	const ls = tools.find((tool) => tool.name === "ls");
	const listing = await ls?.execute("call-b", { path: join(dir, "notes") });
	assert.match(textOf(listing), /todo\.md/u);
});

test("request_access：他拒绝了就说没给，不假装看到", async () => {
	const dir = seed();
	const tools = fileTools({ roots: [dir], approve: () => false });
	const access = tools.find((tool) => tool.name === "request_access");
	const result = await access?.execute("call-c", { path: join(dir, "notes"), reason: "想看" });
	assert.equal(result?.isError, true);
	assert.match(textOf(result), /没同意/u);
});

test("口语路径：~ 展开到家目录，桌面/下载/文档 认成真名", () => {
	assert.equal(expandPath("~/notes/todo.md"), join(homedir(), "notes", "todo.md"));
	assert.equal(expandPath("~"), homedir());
	assert.equal(expandPath("桌面"), join(homedir(), "Desktop"));
	assert.equal(expandPath("下载"), join(homedir(), "Downloads"));
	assert.equal(expandPath("文档"), join(homedir(), "Documents"));
});

test("口语路径不绕过守门人：~ 后面不在根里也算没放开，得先问", async () => {
	const dir = seed();
	const guard = new FileGuard({ roots: [dir] });
	const verdict = await guard.check("list", "~/notes");
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false ? verdict.needsPermission : false, true);
	assert.match(verdict.ok === false ? verdict.reason : "", /得他先同意/u);
});

test("家目录外面也能放开：他点头，整个那个文件夹就算她的了", async () => {
	const dir = seed();
	const outside = mkdtempSync(join(sandbox, "outside-"));
	mkdirSync(join(outside, "DSH"));
	writeFileSync(join(outside, "DSH", "艾拉.md"), "# 艾拉\n", "utf8");
	const asked: Array<{ grant: string; root: string; reason?: string }> = [];
	const guard = new FileGuard({
		roots: [dir],
		approve: (request) => {
			asked.push({ grant: request.grant, root: request.root, reason: request.reason });
			return true;
		},
	});
	const verdict = await guard.check("list", join(outside, "DSH"), { reason: "想读那篇笔记" });
	assert.equal(verdict.ok, true);
	assert.equal(asked.length, 1);
	// 授权单位就是那个文件夹本身（它不在任何根目录下，没有「第一层」可分）
	assert.equal(asked[0].grant, join(outside, "DSH"));
	assert.equal(asked[0].reason, "想读那篇笔记");
	// 里面随便什么都能看
	const nested = await guard.check("read", join(outside, "DSH", "艾拉.md"));
	assert.equal(nested.ok, true);
	assert.equal(asked.length, 1);
});

test("家目录外的放行也能落盘：重启（新守门人）不用再问", async () => {
	const dir = seed();
	const outside = mkdtempSync(join(sandbox, "outside2-"));
	mkdirSync(join(outside, "DSH"));
	writeFileSync(join(outside, "DSH", "艾拉.md"), "# 艾拉\n", "utf8");
	const grantsFile = join(dir, "file-roots.json");
	const first = fileTools({ roots: [dir], grantsFile, approve: () => true });
	const access = first.find((tool) => tool.name === "request_access");
	assert.ok(access !== undefined);
	const asked = await access.execute("call-p", { path: join(outside, "DSH"), reason: "想看那篇笔记" });
	assert.equal(asked.isError, undefined);
	assert.deepEqual(readGrantFile(grantsFile), [join(outside, "DSH")]);

	// 新进程：不挂 approve，照样能看（他点头那一次已经算数了）
	const second = new FileGuard({ roots: [dir], grantsFile });
	assert.deepEqual(second.storedGrants, [join(outside, "DSH")]);
	const again = await second.check("read", join(outside, "DSH", "艾拉.md"));
	assert.equal(again.ok, true);
});

test("request_access 对家目录外的文件夹同样管用", async () => {
	const dir = seed();
	const outside = mkdtempSync(join(sandbox, "outside3-"));
	mkdirSync(join(outside, "vault"));
	writeFileSync(join(outside, "vault", "笔记.md"), "# 笔记\n", "utf8");
	const guard = new FileGuard({ roots: [dir], approve: () => true });
	const tools = fileTools({ guard });
	const access = tools.find((tool) => tool.name === "request_access");
	assert.ok(access !== undefined);
	const result = await access.execute("call-x", { path: join(outside, "vault"), reason: "想看那篇笔记" });
	assert.equal(result.isError, undefined);
	assert.match(textOf(result), /现在可以看/u);
	const read = tools.find((tool) => tool.name === "read");
	const file = await read?.execute("call-y", { path: join(outside, "vault", "笔记.md") });
	assert.equal(file?.isError, undefined);
	assert.match(textOf(file), /笔记/u);
});

test("路径打错时提示从哪儿列起", async () => {
	const dir = seed();
	const guard = new FileGuard({ roots: [dir] });
	guard.allow(join(dir, "notes"));
	const tools = fileTools({ guard });
	const ls = tools.find((tool) => tool.name === "ls");
	assert.ok(ls !== undefined);
	const result = await ls.execute("t1", { path: join(dir, "notes", "不存在的文件夹") });
	assert.equal(result.isError, true);
	assert.match(textOf(result), /不传路径就从/u);
});

test("路径里带口语名但整条不存在时，猜出真路径", () => {
	assert.equal(suggestPath(String.raw`C:\Users\Admin\桌面`), join(homedir(), "Desktop"));
	assert.equal(suggestPath(String.raw`桌面\便签.txt`), join(homedir(), "Desktop", "便签.txt"));
	assert.equal(suggestPath("/home/x/下载"), join(homedir(), "Downloads"));
	assert.equal(suggestPath(join(homedir(), "Desktop")), null);
});
