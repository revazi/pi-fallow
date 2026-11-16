import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DurableInvestigationSpike } from "./durable.ts";
import { execArgv } from "./util.ts";

const analyzerPath = process.argv[2];
if (!analyzerPath || !isAbsolute(analyzerPath)) throw new Error("usage: npm run demo -- /absolute/path/to/already-installed-native-fallow");

const root = await mkdtemp(join(tmpdir(), "pi-fallow-durable-spike-demo-"));
const repository = join(root, "repository");
const state = join(root, "state");
await mkdir(repository);
await execArgv(["git", "-C", repository, "init", "-q"]);
await execArgv(["git", "-C", repository, "config", "user.email", "demo@example.invalid"]);
await execArgv(["git", "-C", repository, "config", "user.name", "Durable Spike Demo"]);
await writeFile(join(repository, "package.json"), '{"name":"synthetic-demo","version":"1.0.0","type":"module"}\n');
await writeFile(join(repository, ".fallowrc.json"), '{"entry":["index.js"]}\n');
await writeFile(join(repository, "index.js"), 'import { used } from "./lib.js"; console.log(used);\n');
await writeFile(join(repository, "lib.js"), "export const used = 1;\nexport const unused = 2;\n");
await writeFile(join(repository, "orphan.js"), "export const orphan = 1;\n");
await execArgv(["git", "-C", repository, "add", "."]);
await execArgv(["git", "-C", repository, "commit", "-qm", "demo snapshot"]);

const spike = await DurableInvestigationSpike.open({ root: state, analyzerPath });
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
