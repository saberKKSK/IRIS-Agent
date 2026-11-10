/**
 * 她能动手写（ADR-0034）：写权限与读权限分两本账，覆盖前必须先读过，写完回读核对。
 * 全部在临时目录里跑，不碰真家目录。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { FileGuard, fileTools } from "../src/files.ts";
import { type WriteAllowed, WriteGuard, type WriteVerdict, writeTools } from "../src/write.ts";

const sandbox = mkdtempSync(join(tmpdir(), "iris-write-"));
after(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function seed(): string {
	const dir = mkdtempSync(join(sandbox, "case-"));
	mkdirSync(join(dir, "notes"));
	writeFileSync(join(dir, "notes", "todo.md"), "# 待办\n买花生\n", "utf8");
	return dir;
}

function allowed(verdict: WriteVerdict): WriteAllowed {
	if (verdict.ok === false) throw new Error("本来该放行：" + verdict.reason);
	return verdict;
}

function textOf(result: { content: readonly unknown[] } | undefined): string {
	const first = result?.content[0] as { type?: string; text?: string } | undefined;
	return first?.type === "text" ? (first.text ?? "") : "";
}

function pick(tools: readonly AgentTool[], name: string): AgentTool {
	const found = tools.find((tool) => tool.name === name);
	if (found === undefined) throw new Error("没有这个工具：" + name);
	return found;
}

test("没人在场就不放行：needsPermission 为真，且不问任何人", async () => {
	const dir = seed();
	const guard = new WriteGuard({ roots: [dir] });
	const verdict = await guard.check(join(dir, "notes", "todo.md"));
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ok === false ? verdict.needsPermission : null, true);
	assert.deepEqual(guard.grants, []);
});

test("问一次、同意一次，同一个文件夹后面不再问", async () => {
	const dir = seed();
	const asked: string[] = [];
	const guard = new WriteGuard({
		roots: [dir],
		approve: (request) => {
			asked.push(request.grant);
			return true;
		},
	});
	const first = await guard.check(join(dir, "notes", "todo.md"));
	const second = await guard.check(join(dir, "notes", "code.ts"));
	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(asked.length, 1);
	// 授权单位是根目录下第一层，不是文件本身
	assert.equal(allowed(first).grant, join(dir, "notes"));
});

test("他点头就落盘：下次启动（新守门人）不用再问", async () => {
	const dir = seed();
	const file = join(sandbox, "grants-write.json");
	const guard = new WriteGuard({ roots: [dir], grantsFile: file });
	guard.allow(join(dir, "notes", "todo.md"));
	assert.equal(existsSync(file), true);

	const fresh = new WriteGuard({ roots: [dir], grantsFile: file });
	const verdict = await fresh.check(join(dir, "notes", "todo.md"));
	assert.equal(verdict.ok, true);
	assert.deepEqual(fresh.storedGrants, [join(dir, "notes")]);
});

test("覆盖已经有内容的文件：没读过就拒绝，读过才放行", async () => {
	const dir = seed();
	const file = join(dir, "notes", "todo.md");
	const reads = new FileGuard({ roots: [dir], approve: () => true });
	const tools = writeTools({ guard: new WriteGuard({ roots: [dir], approve: () => true }), reads });
	const write = pick(tools, "write_file");

	const refused = await write.execute("c1", { path: file, content: "整份换掉" });
	assert.equal((refused.details as { kind?: string }).kind, "unread");
	assert.equal(readFileSync(file, "utf8"), "# 待办\n买花生\n");

	// 真的读过一次，才算见过它
	const read = pick(fileTools({ guard: reads }), "read");
	await read.execute("c2", { path: file });

	const done = await write.execute("c3", { path: file, content: "整份换掉\n" });
	assert.equal((done.details as { ok?: boolean }).ok, true);
	assert.equal(readFileSync(file, "utf8"), "整份换掉\n");
});

test("新文件直接写：自动建父目录，不留临时文件，内容一致", async () => {
	const dir = seed();
	const tools = writeTools({ guard: new WriteGuard({ roots: [dir], approve: () => true }) });
	const file = join(dir, "notes", "deep", "new.md");
	const result = await pick(tools, "write_file").execute("c1", { path: file, content: "第一行\n第二行\n" });
	assert.equal((result.details as { ok?: boolean }).ok, true);
	assert.equal(readFileSync(file, "utf8"), "第一行\n第二行\n");
	// 原子写的临时文件不该留下
	const leftovers = readdirSync(join(dir, "notes", "deep")).filter((name) => name.startsWith(".iris-tmp-"));
	assert.deepEqual(leftovers, []);
});

test("append_file：没有就新建，有就加在末尾", async () => {
	const dir = seed();
	const tools = writeTools({ guard: new WriteGuard({ roots: [dir], approve: () => true }) });
	const append = pick(tools, "append_file");
	const diary = join(dir, "notes", "diary.md");

	await append.execute("c1", { path: diary, text: "11月10日 晴\n" });
	await append.execute("c2", { path: diary, text: "今天把名字改了\n" });
	assert.equal(readFileSync(diary, "utf8"), "11月10日 晴\n今天把名字改了\n");
});

test("make_dir：嵌套建目录，已经有就算成功", async () => {
	const dir = seed();
	const tools = writeTools({ guard: new WriteGuard({ roots: [dir], approve: () => true }) });
	const make = pick(tools, "make_dir");
	const deep = join(dir, "notes", "a", "b");

	const first = await make.execute("c1", { path: deep });
	assert.equal((first.details as { ok?: boolean }).ok, true);
	assert.equal(existsSync(deep), true);

	const again = await make.execute("c2", { path: deep });
	assert.equal((again.details as { ok?: boolean }).ok, true);
	assert.match(textOf(again), /本来就有/u);
});

test("move_path：改名成功；目标位置已经有东西就拒绝，不覆盖", async () => {
	const dir = seed();
	writeFileSync(join(dir, "notes", "占位.md"), "别人的\n", "utf8");
	const tools = writeTools({ guard: new WriteGuard({ roots: [dir], approve: () => true }) });
	const move = pick(tools, "move_path");

	const okResult = await move.execute("c1", {
		from: join(dir, "notes", "todo.md"),
		to: join(dir, "notes", "done.md"),
	});
	assert.equal((okResult.details as { ok?: boolean }).ok, true);
	assert.equal(existsSync(join(dir, "notes", "todo.md")), false);
	assert.equal(readFileSync(join(dir, "notes", "done.md"), "utf8"), "# 待办\n买花生\n");

	const clash = await move.execute("c2", { from: join(dir, "notes", "done.md"), to: join(dir, "notes", "占位.md") });
	assert.equal((clash.details as { kind?: string }).kind, "exists");
	assert.equal(readFileSync(join(dir, "notes", "占位.md"), "utf8"), "别人的\n");
});

test("有些东西不写：.ssh 这类目录、可执行文件", async () => {
	const dir = seed();
	const guard = new WriteGuard({ roots: [dir], approve: () => true });
	const secret = await guard.check(join(dir, ".ssh", "config"));
	assert.equal(secret.ok, false);
	assert.equal(secret.ok === false ? secret.needsPermission : null, false);

	const binary = await guard.check(join(dir, "notes", "run.exe"));
	assert.equal(binary.ok, false);
});

test("request_write：她开口要，他答应之后那个文件夹就一直开着", async () => {
	const dir = seed();
	const asked: { path: string; grant: string; reason?: string }[] = [];
	const file = join(sandbox, "grants-request.json");
	const guard = new WriteGuard({
		roots: [dir],
		grantsFile: file,
		approve: (request) => {
			asked.push({ path: request.path, grant: request.grant, reason: request.reason });
			return true;
		},
	});
	const access = pick(writeTools({ guard }), "request_write");
	const result = await access.execute("c1", {
		path: join(dir, "notes"),
		reason: "想把今天的事记下来",
	});

	assert.equal((result.details as { ok?: boolean }).ok, true);
	assert.equal(asked.length, 1);
	assert.equal(asked[0]?.reason, "想把今天的事记下来");
	assert.equal(asked[0]?.grant, join(dir, "notes"));
	assert.deepEqual(guard.storedGrants, [join(dir, "notes")]);
});

test("request_write 被拒绝：说没给，不假装能写", async () => {
	const dir = seed();
	const guard = new WriteGuard({ roots: [dir], approve: () => false });
	const access = pick(writeTools({ guard }), "request_write");
	const result = await access.execute("c1", { path: join(dir, "notes"), reason: "想改个名" });
	assert.equal((result.details as { ok?: boolean }).ok, false);
	assert.equal(result.isError, true);
	assert.match(textOf(result), /没同意/u);
});

test("家目录外面也能放开：写的授权单位就是那条路径本身", async () => {
	const outside = mkdtempSync(join(tmpdir(), "iris-write-out-"));
	try {
		const dir = seed();
		const guard = new WriteGuard({ roots: [dir], approve: () => true });
		const verdict = await guard.check(join(outside, "note.md"));
		assert.equal(verdict.ok, true);
		assert.equal(allowed(verdict).grant, join(outside, "note.md"));
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
});
