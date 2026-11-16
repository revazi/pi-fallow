import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runFallowCommandHandler } = await jiti.import("../extensions/fallow/command/handler.ts");
const { executeFallowResult, openFallowOverviewNavigator } = await jiti.import("../extensions/fallow/command/result-flow.ts");
const fixture = fileURLToPath(new URL("./fixtures/process-fixture.mjs", import.meta.url));
const state = () => ({ lastArgs: null, baseRefs: new Map(), history: { nextId: 1, entries: [] }, similarCodeReuseCache: false });
function context(hasUI = true) {
 const notices = [], statuses = [];
 return { cwd: process.cwd(), mode: "rpc", hasUI, notices, statuses, ui: {
  notify: (message, level) => notices.push([message, level]),
  setStatus: (key, value) => statuses.push([key, value]),
 } };
}

test("handler reports invalid input and missing rerun, or throws without UI", async () => {
 const ctx = context();
 await runFallowCommandHandler({}, ctx, state(), "explain");
 await runFallowCommandHandler({}, ctx, state(), "rerun");
 assert.match(ctx.notices[0][0], /explain requires/);
 assert.equal(ctx.notices[0][1], "error");
 assert.match(ctx.notices[1][0], /No previous/);
 await assert.rejects(runFallowCommandHandler({}, context(false), state(), "explain"), /explain requires/);
});

test("result flow executes fixture, remembers arguments, and reports findings or errors", async () => {
 const oldBin = process.env.FALLOW_BIN, oldMode = process.env.PI_FALLOW_PROCESS_FIXTURE_MODE;
 process.env.FALLOW_BIN = fixture;
 try {
  for (const [mode, label, level] of [["findings", /found issues/, "info"], ["error", /error/, "error"]]) {
   process.env.PI_FALLOW_PROCESS_FIXTURE_MODE = mode;
   const ctx = context(), messages = [], completed = [], remembered = [];
   const result = await executeFallowResult({ sendMessage: (message) => messages.push(message) }, ctx, ["dead-code"], true, (args) => remembered.push(args), undefined, (value, args) => completed.push([value, args]));
   assert.equal(result, null);
   assert.deepEqual(remembered, [["dead-code", "--format", "json", "--quiet"]]);
   assert.deepEqual(ctx.statuses.map(([, value]) => value), ["fallow running…", undefined]);
   assert.match(ctx.notices[0][0], label);
   assert.equal(ctx.notices[0][1], level);
   assert.equal(messages[0].customType, "fallow-result");
   assert.equal(messages[0].details.compact, false);
   assert.deepEqual(completed[0][1], remembered[0]);
  }
 } finally {
  if (oldBin === undefined) delete process.env.FALLOW_BIN; else process.env.FALLOW_BIN = oldBin;
  if (oldMode === undefined) delete process.env.PI_FALLOW_PROCESS_FIXTURE_MODE; else process.env.PI_FALLOW_PROCESS_FIXTURE_MODE = oldMode;
 }
});

test("navigator is not opened outside TUI or without an overview", async () => {
 assert.equal(await openFallowOverviewNavigator(context(), { sections: [] }, { command: "fallow", commandArgs: [] }), null);
 assert.equal(await openFallowOverviewNavigator({ mode: "tui" }, undefined, { command: "fallow", commandArgs: [] }), null);
});
