import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { FALLOW_VERSION } from "../src/fallow-schema.ts";
import { execArgv } from "../src/util.ts";

// Only an explicitly selected already-installed native binary is eligible.
export async function selectedNativeFallow(path = process.env.FALLOW_SPIKE_3_36_BIN): Promise<string | undefined> {
	if (!path || !isAbsolute(path)) return undefined;
	try {
		await access(path);
		const version = await execArgv([path, "--version"], { env: { PATH: "/usr/bin:/bin" }, maxBytes: 4096 });
		return version.code === 0 && version.stdout.trim() === `fallow ${FALLOW_VERSION}` ? path : undefined;
	} catch {
		return undefined;
	}
}
