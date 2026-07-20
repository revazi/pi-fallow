import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const { fallowCompletions } = await jiti.import("../extensions/fallow/autocomplete.ts");
const { needsFallowBaseDetection, normalizeFallowArgs } = await jiti.import("../extensions/fallow/command/args.ts");
const { resolveFallowCommandBaseRef } = await jiti.import("../extensions/fallow/command/base.ts");
const { detectFallowBaseRef } = await jiti.import("../extensions/fallow/project/git.ts");
const { registerFallowSessionStart } = await jiti.import("../extensions/fallow/session.ts");

function labels(items) {
	return items?.map((item) => item.label) ?? [];
}

function completionLabels(input) {
	return labels(fallowCompletions.getFallowArgumentCompletions(input));
}

function gitResult(stdout, code = 0) {
	return { stdout, stderr: "", code, killed: false };
}

function commandState() {
	return { lastArgs: null, baseRefs: new Map() };
}

function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("Fallow autocomplete", () => {
	it("returns command, flag, and fixed-value completions", () => {
		assert.ok(labels(fallowCompletions.getFallowRootCommandCompletions()).includes("health"));
		assert.ok(completionLabels("").includes("audit PR (main)"));
		assert.ok(completionLabels("health --").includes("--group-by"));
		assert.deepEqual(completionLabels("health --group-by o"), ["owner"]);
		assert.ok(completionLabels("health --group-by=o").includes("--group-by=owner"));
		assert.deepEqual(completionLabels("coverage "), ["analyze"]);
		assert.equal(fallowCompletions.getFallowArgumentCompletions("rerun "), null);
	});

	it("returns static refs immediately while asynchronously loading project refs", async () => {
		let finishGit;
		const calls = [];
		const pi = {
			exec(command, args, options) {
				calls.push({ command, args, options });
				return new Promise((resolvePromise) => { finishGit = resolvePromise; });
			},
		};
		const cwd = resolve(root, ".tmp-autocomplete-project-a");
		const refresh = fallowCompletions.preloadGitReferences(pi, cwd);
		const immediate = completionLabels("audit --base ");
		assert.ok(immediate.includes("origin/main"));
		assert.equal(immediate.includes("feature/async-refs"), false);
		assert.deepEqual(calls, [{
			command: "git",
			args: ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
			options: { cwd, timeout: 1200 },
		}]);

		finishGit(gitResult("feature/async-refs\norigin/main\norigin/HEAD\nHEAD\n"));
		await refresh;
		const refreshed = completionLabels("audit --base ");
		assert.ok(refreshed.includes("feature/async-refs"));
		assert.equal(refreshed.includes("origin/HEAD"), false);
		assert.equal(refreshed.includes("HEAD"), false);
	});

	it("keys cached refs by Pi's cwd and preserves them after refresh failures", async () => {
		const firstCwd = resolve(root, ".tmp-autocomplete-project-b");
		await fallowCompletions.preloadGitReferences({ exec: async () => gitResult("feature/first\n") }, firstCwd);
		assert.ok(completionLabels("audit --base ").includes("feature/first"));

		const secondCwd = resolve(root, ".tmp-autocomplete-project-c");
		let finishSecond;
		const secondRefresh = fallowCompletions.preloadGitReferences({
			exec: () => new Promise((resolvePromise) => { finishSecond = resolvePromise; }),
		}, secondCwd);
		assert.equal(completionLabels("audit --base ").includes("feature/first"), false);
		finishSecond(gitResult("feature/second\n"));
		await secondRefresh;
		assert.ok(completionLabels("audit --base ").includes("feature/second"));

		await fallowCompletions.preloadGitReferences({ exec: async () => gitResult("", 1) }, secondCwd);
		assert.ok(completionLabels("audit --base ").includes("feature/second"));
	});

	it("preloads refs from Pi's TUI session cwd only", () => {
		let sessionStart;
		const calls = [];
		let providers = 0;
		const pi = {
			on(event, handler) { if (event === "session_start") sessionStart = handler; },
			exec(command, args, options) {
				calls.push({ command, args, options });
				return Promise.resolve(gitResult("feature/session\n"));
			},
		};
		const previous = process.env.PI_FALLOW_DISABLE_UPDATE_NOTICE;
		process.env.PI_FALLOW_DISABLE_UPDATE_NOTICE = "1";
		try {
			registerFallowSessionStart(pi);
			sessionStart({}, { mode: "rpc", cwd: "/rpc-project", ui: { addAutocompleteProvider() { providers++; } } });
			sessionStart({}, { mode: "tui", cwd: "/tui-project", ui: { addAutocompleteProvider() { providers++; } } });
		} finally {
			if (previous === undefined) delete process.env.PI_FALLOW_DISABLE_UPDATE_NOTICE;
			else process.env.PI_FALLOW_DISABLE_UPDATE_NOTICE = previous;
		}
		assert.equal(calls.length, 1);
		assert.equal(calls[0].options.cwd, resolve("/tui-project"));
		assert.equal(providers, 1);
	});

	it("contains no synchronous Git or process.cwd call in the completion path", async () => {
		const source = await readFile(resolve(root, "extensions/fallow/autocomplete.ts"), "utf8");
		assert.doesNotMatch(source, /execFileSync/);
		assert.doesNotMatch(source, /process\.cwd\(\)/);
	});
});

describe("Fallow command base detection", () => {
	it("only detects a base for pr without an explicit base", () => {
		assert.equal(needsFallowBaseDetection(["health"]), false);
		assert.equal(needsFallowBaseDetection(["pr", "--help"]), false);
		assert.equal(needsFallowBaseDetection(["pr", "--base", "main"]), false);
		assert.equal(needsFallowBaseDetection(["pr", "--base=main"]), false);
		assert.equal(needsFallowBaseDetection(["pr"]), true);
	});

	it("skips Git for ordinary commands and explicit PR bases", async () => {
		const state = commandState();
		let detections = 0;
		const detector = async () => { detections++; return "origin/main"; };
		assert.equal(await resolveFallowCommandBaseRef(["health"], "/project", state, detector), "main");
		assert.equal(await resolveFallowCommandBaseRef(["pr", "--base", "release"], "/project", state, detector), "main");
		assert.equal(detections, 0);
	});

	it("caches the detected PR base per project", async () => {
		const state = commandState();
		let detections = 0;
		const detector = async (cwd) => { detections++; return cwd.endsWith("one") ? "origin/main" : undefined; };
		assert.equal(await resolveFallowCommandBaseRef(["pr"], "/project/one", state, detector), "origin/main");
		assert.equal(await resolveFallowCommandBaseRef(["pr"], "/project/one", state, detector), "origin/main");
		assert.equal(await resolveFallowCommandBaseRef(["pr"], "/project/two", state, detector), "main");
		assert.equal(await resolveFallowCommandBaseRef(["pr"], "/project/two", state, detector), "main");
		assert.equal(detections, 2);
	});

	it("detects the first available base ref without probing unrelated Git state", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-fallow-base-"));
		try {
			git(workspace, ["init", "-q"]);
			git(workspace, ["config", "user.email", "test@example.invalid"]);
			git(workspace, ["config", "user.name", "Pi Fallow Test"]);
			await writeFile(join(workspace, "index.ts"), "export const value = true;\n", "utf8");
			git(workspace, ["add", "index.ts"]);
			git(workspace, ["commit", "-qm", "initial"]);
			git(workspace, ["branch", "-M", "main"]);
			git(workspace, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
			assert.equal(await detectFallowBaseRef(workspace), "origin/main");
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("keeps normalization behavior for detected and explicit bases", () => {
		const notify = () => {};
		assert.deepEqual(normalizeFallowArgs(["pr"], "origin/main", null, notify), [
			"audit", "--base", "origin/main", "--gate", "new-only",
		]);
		assert.deepEqual(normalizeFallowArgs(["pr", "--base", "release"], "main", null, notify), [
			"audit", "--base", "release", "--gate", "new-only",
		]);
	});
});
