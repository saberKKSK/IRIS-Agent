import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ShellAllowed, ShellDenied, ShellVerdict } from "../src/shell.ts";
import { commandHead, isDangerous, runCommand, ShellGuard, shellTools } from "../src/shell.ts";

const sandbox = mkdtempSync(join(tmpdir(), "iris-shell-"));
after(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

/** 放行 + 收窄类型（assert.equal 会把 ok 收成字面量，后面再判就报 TS2367）。 */
function allowed(verdict: ShellVerdict): ShellAllowed {
	if (!verdict.ok) assert.fail("应该放行，实际被拒：" + verdict.reason);
	return verdict;
}

function denied(verdict: ShellVerdict): ShellDenied {
	if (verdict.ok) assert.fail("应该被拒，实际放行了：" + verdict.command);
	return verdict;
}

function textOf(result: { content: readonly unknown[] }): string {
	const first = result.content[0] as { type?: string; text?: string } | undefined;
	return first !== undefined && first.type === "text" ? (first.text ?? "") : "";
}

test("命令头：取第一个词，去掉路径和扩展名", () => {
	assert.equal(commandHead("git status"), "git");
	assert.equal(commandHead("  C:\\Windows\\System32\\tasklist.exe /FI x"), "tasklist");
	assert.equal(commandHead('"C:\\Program Files\\nodejs\\npm.cmd" install'), "npm");
	assert.equal(commandHead(""), "");
});

test("危险命令：删库、改系统、推远端这类一律算", () => {
	assert.equal(isDangerous("rm -rf tmp"), true);
	assert.equal(isDangerous("Remove-Item -Recurse -Force C:\\x"), true);
	assert.equal(isDangerous("git push origin main"), true);
	assert.equal(isDangerous("reg add HKLM\\x /v y"), true);
	assert.equal(isDangerous("git status"), false);
	assert.equal(isDangerous("npm test"), false);
});

test("只读命令不问人", async () => {
	let asked = 0;
	const guard = new ShellGuard({
		grants: () => [sandbox],
		approve: () => {
			asked += 1;
			return false;
		},
	});
	const verdict = allowed(await guard.check("dir"));
	assert.equal(verdict.via, "ro");
	assert.equal(asked, 0);
});

test("其余命令要问：不同意就不跑", async () => {
	const asked: string[] = [];
	const guard = new ShellGuard({
		grants: () => [sandbox],
		approve: (request) => {
			asked.push(request.command);
			return false;
		},
	});
	const verdict = denied(await guard.check("npm install"));
	assert.equal(verdict.needsPermission, true);
	assert.deepEqual(asked, ["npm install"]);
});

test("按 a 记住命令头：落盘，重启也不用再问", async () => {
	const allowFile = join(sandbox, "exec-allow.json");
	let asked = 0;
	const guard = new ShellGuard({
		grants: () => [sandbox],
		allowFile,
		approve: () => {
			asked += 1;
			guard.remember("git");
			return true;
		},
	});
	const first = allowed(await guard.check("git status"));
	assert.equal(first.via, "asked");
	const second = allowed(await guard.check("git status"));
	assert.equal(second.via, "remembered");
	assert.equal(asked, 1);
	assert.deepEqual(JSON.parse(readFileSync(allowFile, "utf8")), ["git"]);
	const fresh = new ShellGuard({ grants: () => [sandbox], allowFile });
	const remembered = allowed(await fresh.check("git status"));
	assert.equal(remembered.via, "remembered");
});

test("危险命令记住了也没用：照样逐条问", async () => {
	const allowFile = join(sandbox, "exec-allow-2.json");
	let asked = 0;
	const guard = new ShellGuard({
		grants: () => [sandbox],
		allowFile,
		approve: () => {
			asked += 1;
			return true;
		},
	});
	guard.remember("rm");
	const verdict = allowed(await guard.check("rm -rf tmp"));
	assert.equal(verdict.via, "asked");
	assert.equal(asked, 1);
});

test("地方不对就不跑：cwd 必须在她能写的地方", async () => {
	const guard = new ShellGuard({ grants: () => [sandbox], approve: () => true });
	const outside = denied(await guard.check("git status", join(sandbox, "..")));
	assert.equal(outside.kind, "denied");
	assert.equal(outside.needsPermission, false);
});

test("一个地方都没放开：直说没地方跑", async () => {
	const guard = new ShellGuard({ approve: () => true });
	const verdict = denied(await guard.check("dir"));
	assert.match(verdict.reason, /还没有能跑命令的地方/u);
});

test("没人能问就一律拒", async () => {
	const guard = new ShellGuard({ grants: () => [sandbox] });
	const verdict = denied(await guard.check("npm test"));
	assert.equal(verdict.kind, "refused");
	assert.equal(verdict.needsPermission, true);
});

test("跑一条：拿回输出和退出码", async () => {
	const result = await runCommand("echo hello-iris", { cwd: sandbox });
	assert.equal(result.exitCode, 0);
	assert.match(result.output, /hello-iris/u);
	assert.equal(result.timedOut, false);
	assert.equal(result.truncated, false);
});

test("非零退出也照实回", async () => {
	const result = await runCommand("exit 3", { cwd: sandbox });
	assert.equal(result.exitCode, 3);
	assert.equal(result.timedOut, false);
});

test("超时：把进程树掐掉，timedOut 为真", async () => {
	const result = await runCommand("Start-Sleep -Seconds 30", { cwd: sandbox, timeoutMs: 1000 });
	assert.equal(result.timedOut, true);
});

test("输出太长就截断，头尾都留", async () => {
	const result = await runCommand('1..400 | ForEach-Object { Write-Output "line-$_-aaaaaaaaaaaaaaaaaaaaaaaa" }', {
		cwd: sandbox,
		maxOutput: 1000,
	});
	assert.equal(result.truncated, true);
	assert.match(result.output, /中间截掉/u);
	assert.ok(result.output.length < 1400);
});

test("工具层：跑成功，正文带退出码，isError 是假", async () => {
	const guard = new ShellGuard({ grants: () => [sandbox], approve: () => true });
	const tool = shellTools({ guard })[0];
	assert.equal(tool?.name, "run_command");
	const result = await tool?.execute("call-1", { command: "echo ok-iris", cwd: sandbox });
	assert.ok(result !== undefined);
	if (result === undefined) return;
	assert.equal(result.isError, false);
	assert.match(textOf(result), /ok-iris/u);
	assert.match(textOf(result), /退出码 0/u);
});

test("工具层：没人点头就不跑，说清要人看一眼", async () => {
	const guard = new ShellGuard({ grants: () => [sandbox] });
	const tool = shellTools({ guard })[0];
	const result = await tool?.execute("call-2", { command: "npm test", cwd: sandbox });
	assert.ok(result !== undefined);
	if (result === undefined) return;
	assert.equal(result.isError, true);
	assert.match(textOf(result), /要他看一眼才跑/u);
});

test("工具层：退出码非零算错，但输出照样给她", async () => {
	const guard = new ShellGuard({ grants: () => [sandbox], approve: () => true });
	const tool = shellTools({ guard })[0];
	const result = await tool?.execute("call-3", { command: "echo boom; exit 2", cwd: sandbox });
	assert.ok(result !== undefined);
	if (result === undefined) return;
	assert.equal(result.isError, true);
	assert.match(textOf(result), /boom/u);
	assert.match(textOf(result), /退出码 2/u);
});
