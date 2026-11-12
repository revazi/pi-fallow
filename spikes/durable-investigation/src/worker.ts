import { readFile, stat, writeFile } from "node:fs/promises";
import { DurableInvestigationSpike } from "./durable.ts";

const controlPath = process.argv[2];
if (!controlPath) throw new Error("usage: worker.ts CONTROL.json");
const control = JSON.parse(await readFile(controlPath, "utf8"));
const barrier = control.barrier ? async (name: string) => {
	if (name !== control.barrier.name) return;
	await writeFile(control.barrier.reached, `${process.pid}\n`, { mode: 0o600 });
	while (true) {
		try { await stat(control.barrier.release); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
	}
} : undefined;
const spike = await DurableInvestigationSpike.open({
	root: control.root,
	recoverOwnership: control.recoverOwnership === true,
	taskHost: { barrier, analyzerEnv: control.analyzerEnv },
});
try {
	let investigationId = control.investigationId;
	if (control.request) investigationId = (await spike.admit(control.request)).id;
	if (!investigationId) throw new Error("control must provide request or investigationId");
	await writeFile(control.ready, `${investigationId}\n`, { mode: 0o600 });
	spike.resume();
	const result = await spike.wait(investigationId);
	if (control.result) await writeFile(control.result, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
} finally {
	await spike.close();
}
