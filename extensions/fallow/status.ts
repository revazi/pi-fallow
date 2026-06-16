import { detectFallowGitState, formatFallowStatus } from "./project/git";

export async function setFallowReadyStatus(ctx: { cwd: string; ui: { setStatus(key: string, text: string): void } }) {
	try {
		ctx.ui.setStatus("fallow", formatFallowStatus(await detectFallowGitState(ctx.cwd)));
	} catch {
		ctx.ui.setStatus("fallow", "fallow ready");
	}
}
