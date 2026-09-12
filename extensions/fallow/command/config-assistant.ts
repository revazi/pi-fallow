import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createFallowConfigAssistant,
	formatFallowConfigApply,
	formatFallowConfigPreview,
	sendConfigMessage,
	sendFallowConfigInspection,
} from "../config-assistant";
import type { FallowCommandContext } from "./types";

type ConfigAssistant = ReturnType<typeof createFallowConfigAssistant>;
type ConfigRequest = { kind: "inspect" } | { kind: "preview-rule" | "apply-rule"; rule: string; severity: string };

export async function runFallowConfigAssistantCommand(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	args: string[],
	assistant = createFallowConfigAssistant(pi),
): Promise<void> {
	const request = parseConfigRequest(args);
	if (request.kind === "inspect") return sendFallowConfigInspection(pi, ctx, assistant);
	return runRuleRequest(pi, ctx, request, assistant);
}

function parseConfigRequest(args: string[]): ConfigRequest {
	const subcommand = args[1] || "inspect";
	if (subcommand === "inspect") return parseInspectRequest(args);
	return parseRuleConfigRequest(args, subcommand);
}

function parseInspectRequest(args: string[]): ConfigRequest {
	if (args.length > 2) throw usageError();
	return { kind: "inspect" };
}

function parseRuleConfigRequest(args: string[], subcommand: string): ConfigRequest {
	if (args.length !== 4) throw usageError();
	const kind = configRuleRequestKind(subcommand);
	return { kind, rule: args[2]!, severity: args[3]! };
}

function configRuleRequestKind(value: string): "preview-rule" | "apply-rule" {
	if (value === "preview-rule" || value === "apply-rule") return value;
	throw usageError();
}

async function runRuleRequest(
	pi: ExtensionAPI,
	ctx: FallowCommandContext,
	request: Exclude<ConfigRequest, { kind: "inspect" }>,
	assistant: ConfigAssistant,
): Promise<void> {
	const plan = await assistant.previewRule(ctx.cwd, request.rule, request.severity, ctx.signal);
	sendConfigMessage(pi, formatFallowConfigPreview(plan.preview), plan.preview);
	if (request.kind === "preview-rule") return;
	if (plan.preview.status === "unchanged") return;
	assertInteractive(ctx);
	return confirmAndApply(pi, ctx, plan, assistant);
}

async function confirmAndApply(
	pi: ExtensionAPI,
	ctx: FallowCommandContext & { hasUI: true },
	plan: Awaited<ReturnType<ConfigAssistant["previewRule"]>>,
	assistant: ConfigAssistant,
): Promise<void> {
	if (ctx.signal?.aborted) return reportCancellation(ctx);
	const confirmed = await ctx.ui.confirm(
		"Apply Fallow configuration change?",
		`${plan.preview.schemaPath}: ${plan.preview.change}\n\n${plan.preview.backupPolicy}\nA fresh drift check runs before the atomic write.`,
	);
	return finishConfirmedApply(pi, ctx, plan, assistant, confirmed);
}

async function finishConfirmedApply(
	pi: ExtensionAPI,
	ctx: FallowCommandContext & { hasUI: true },
	plan: Awaited<ReturnType<ConfigAssistant["previewRule"]>>,
	assistant: ConfigAssistant,
	confirmed: boolean,
): Promise<void> {
	if (!confirmed) return reportCancellation(ctx);
	if (ctx.signal?.aborted) return reportCancellation(ctx);
	const result = await assistant.apply(plan, ctx.cwd, { confirmed: true, signal: ctx.signal });
	sendConfigMessage(pi, formatFallowConfigApply(result), result);
	ctx.ui.notify(configApplyNotice(result), "info");
}

function configApplyNotice(result: { status: string; summary: string }): string {
	return result.status === "applied" ? "Confirmed Fallow configuration change applied." : result.summary;
}

function assertInteractive(ctx: FallowCommandContext): asserts ctx is FallowCommandContext & { hasUI: true } {
	if (!ctx.hasUI) throw new Error("Applying Fallow configuration requires an interactive TUI confirmation. Use preview-rule in non-interactive modes.");
}

function usageError(): Error {
	return new Error("Usage: /fallow config-assist [inspect|preview-rule RULE error|warn|off|apply-rule RULE error|warn|off]");
}

function reportCancellation(ctx: FallowCommandContext): void {
	ctx.ui.notify("Fallow configuration apply cancelled; no config write was performed.", "info");
}
