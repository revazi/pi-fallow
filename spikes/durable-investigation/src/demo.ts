import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableInvestigationSpike } from "./durable.ts";
import { execArgv } from "./util.ts";

const root = await mkdtemp(join(tmpdir(), "pi-fallow-durable-spike-demo-"));
const repository = join(root, "repository");
const state = join(root, "state");
await mkdir(repository);
await execArgv(["git", "-C", repository, "init", "-q"]);
await execArgv(["git", "-C", repository, "config", "user.email", "demo@example.invalid"]);
await execArgv(["git", "-C", repository, "config", "user.name", "Durable Spike Demo"]);
await writeFile(join(repository, "example.ts"), "// TODO investigate this retained finding\nexport const value = 1;\n");
await writeFile(join(repository, ".fallowrc.json"), "{}\n");
await execArgv(["git", "-C", repository, "add", "."]);
await execArgv(["git", "-C", repository, "commit", "-qm", "demo snapshot"]);

const spike = await DurableInvestigationSpike.open({ root: state });
try {
	const admitted = await spike.admit({
		hostRequestId: "demo-request-1",
		sourceRepository: repository,
		deadlineAt: Date.now() + 60_000,
		selectionLimit: 1,
	});
	const completed = await spike.wait(admitted.id);
	console.log(JSON.stringify({ state, report: completed.report }, null, 2));
} finally {
	await spike.close();
}
