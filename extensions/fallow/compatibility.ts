import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { certifiedFallowCapabilities } from "./certified-capabilities";
import { asRecord } from "./data";
import { parseJson } from "./json";
import { fallowToolCommands, getFallowToolCommandSpec, type FallowToolCommandSpec } from "./registry";
import { createFallowRunner } from "./runner";

const MAX_DIAGNOSTICS = 12;
const MAX_NAMES = 8;
const MAX_TEXT = 500;
const MAX_NAME_TEXT = 120;
const ANALYSIS_COMMANDS = new Set(["dead-code", "dupes", "health", "security"]);

type CompatibilityStatus = "compatible" | "incompatible" | "unavailable";
type DiagnosticKind = "commands" | "global flags" | "command flags" | "issue types" | "output formats" | "resources" | "related schemas";

export interface FallowCapabilityDiagnostic {
	capability: string;
	detail: string;
	affectedCommands: string[];
}

export interface FallowCapabilityAddition {
	kind: DiagnosticKind;
	names: string[];
	omitted: number;
}

export interface FallowCompatibilityReport {
	status: CompatibilityStatus;
	installedVersion?: string;
	certifiedVersion: string;
	manifestVersion?: string;
	summary: string;
	counts?: { commands: number; issueTypes: number; outputFormats: number };
	incompatible: FallowCapabilityDiagnostic[];
	incompatibleOmitted: number;
	additions: FallowCapabilityAddition[];
	advisories: string[];
	certifiedReportSchemas: Record<string, string>;
}

type CapabilityRunner = ReturnType<typeof createFallowRunner>;
type DiagnosticCollector = Map<string, { capability: string; detail: string; affected: Set<string> }>;

/** Pure, deterministic comparison. It never gates command execution. */
export function diagnoseFallowCapabilities(installed: unknown): FallowCompatibilityReport {
	const root = asRecord(installed);
	return root ? diagnoseCapabilityRoot(root) : unavailableReport("Installed Fallow returned no capability object.");
}

function diagnoseCapabilityRoot(root: Record<string, any>): FallowCompatibilityReport {
	const diagnostics: DiagnosticCollector = new Map();
	const advisories: string[] = [];
	const commands = recordArray(root.commands);
	const globalFlags = recordArray(root.global_flags);
	const commandMap = uniqueRecordMap(commands, "name", diagnostics, "command manifest", allCommands());
	checkManifestIdentity(root, diagnostics);
	checkModeledCommands(commandMap, globalFlags, diagnostics);
	checkIssueTypes(root, diagnostics);
	checkCertifiedSurfaceRemovals(root, commandMap, advisories);
	return buildCompatibilityReport(root, commands, commandMap, globalFlags, diagnostics, advisories);
}

function buildCompatibilityReport(
	root: Record<string, any>,
	commands: Record<string, any>[],
	commandMap: Map<string, Record<string, any>>,
	globalFlags: Record<string, any>[],
	diagnostics: DiagnosticCollector,
	advisories: string[],
): FallowCompatibilityReport {
	const additions = collectAdditions(root, commandMap, globalFlags);
	const incompatible = boundedDiagnostics(diagnostics);
	const status: CompatibilityStatus = diagnostics.size ? "incompatible" : "compatible";
	return {
		status,
		installedVersion: boundedOptionalName(root.version),
		certifiedVersion: certifiedFallowCapabilities.certifiedVersion,
		manifestVersion: boundedOptionalName(root.manifest_version),
		summary: compatibilitySummary(status, additions),
		counts: { commands: commands.length, issueTypes: arrayLength(root.issue_types), outputFormats: stringArray(root.output_formats).length },
		incompatible,
		incompatibleOmitted: Math.max(0, diagnostics.size - incompatible.length),
		additions,
		advisories: advisories.slice(0, MAX_DIAGNOSTICS),
		certifiedReportSchemas: { ...certifiedFallowCapabilities.reportSchemas },
	};
}

export function createFallowCompatibilityCheck(
	pi: ExtensionAPI,
	runner: CapabilityRunner = createFallowRunner({ allowNpxFallback: false }),
): (cwd: string, signal?: AbortSignal) => Promise<FallowCompatibilityReport> {
	return async (cwd, signal) => {
		try {
			runner.clear(pi);
			const { result } = await runner.execute(pi, ["schema", "--format", "json", "--quiet"], cwd, signal, 30);
			return diagnoseCapabilityExecution(result);
		} catch (error) {
			return unavailableReport(`Capability check unavailable: ${boundedText(errorText(error))}`);
		}
	};
}

export async function sendFallowCompatibilityMessage(
	pi: ExtensionAPI,
	ctx: { cwd: string; signal?: AbortSignal; hasUI: boolean; ui?: { notify(message: string, level: "info" | "warning" | "error"): void } },
	check = createFallowCompatibilityCheck(pi),
): Promise<void> {
	const report = await check(ctx.cwd, ctx.signal);
	pi.sendMessage({
		customType: "fallow-compatibility",
		content: formatFallowCompatibility(report),
		display: true,
		details: report,
	});
	if (ctx.hasUI) ctx.ui?.notify("Fallow compatibility diagnostics added to the transcript.", report.status === "incompatible" ? "warning" : "info");
}

export function formatFallowCompatibility(report: FallowCompatibilityReport): string {
	const lines = [
		"Fallow compatibility",
		"",
		`Installed Fallow: ${report.installedVersion ?? "unavailable"}`,
		`Pi Fallow certified target: ${report.certifiedVersion}`,
		`Compatibility: ${report.summary}`,
	];
	if (report.counts) lines.push(`Surface: ${report.counts.commands} commands · ${report.counts.issueTypes} issue types · ${report.counts.outputFormats} output formats`);
	appendIncompatibleLines(lines, report);
	appendAdditionLines(lines, report.additions);
	if (report.advisories.length) {
		lines.push("", "Certification drift:", ...report.advisories.map((item) => `- ${item}`));
	}
	lines.push(
		"",
		`Certified report fixtures: ${Object.entries(report.certifiedReportSchemas).map(([kind, version]) => `${kind}@${version}`).join(", ")}`,
		"Certification is tested evidence, not an installation or runtime version constraint.",
		"Diagnostics are advisory and never block modeled commands that the installed CLI can still execute.",
	);
	return lines.join("\n");
}

export function renderFallowCompatibilityMessage(message: { content: string; details?: unknown }, _options: unknown, theme: any): Text {
	const status = compatibilityStatus(message.details);
	return new Text(`${theme.fg("toolTitle", theme.bold("Fallow compatibility"))} ${theme.fg(compatibilityTone(status), status)}\n${theme.fg("dim", message.content)}`, 0, 0);
}

function diagnoseCapabilityExecution(result: { stdout: string; stderr: string; code: number; killed?: boolean; terminationReason?: string }): FallowCompatibilityReport {
	if (result.killed) return unavailableReport(terminationSummary(result.terminationReason));
	if (result.code !== 0) return unavailableReport(`Capability check failed (exit ${result.code}): ${boundedText(result.stderr)}`);
	const parsed = parseJson(result.stdout, result.stderr);
	return parsed.parsed ? diagnoseFallowCapabilities(parsed.data) : unavailableReport("Installed Fallow returned an unreadable capability schema.");
}

function terminationSummary(reason: string | undefined): string {
	return reason === "timed-out" ? "Capability check timed out." : "Capability check was cancelled.";
}

function compatibilityStatus(details: unknown): CompatibilityStatus {
	return (details as FallowCompatibilityReport | undefined)?.status ?? "unavailable";
}

function compatibilityTone(status: CompatibilityStatus): "success" | "warning" {
	return status === "compatible" ? "success" : "warning";
}

function checkManifestIdentity(root: Record<string, any>, diagnostics: DiagnosticCollector): void {
	checkManifestName(root.name, diagnostics);
	checkManifestVersion(root.manifest_version, diagnostics);
	checkDefaultCommand(root.default_command, diagnostics);
	checkInstalledVersion(root.version, diagnostics);
	checkJsonOutput(root.output_formats, diagnostics);
}

function checkManifestName(name: unknown, diagnostics: DiagnosticCollector): void {
	if (name !== certifiedFallowCapabilities.name) addDiagnostic(diagnostics, "manifest name", `expected ${certifiedFallowCapabilities.name}`, allCommands());
}

function checkManifestVersion(version: unknown, diagnostics: DiagnosticCollector): void {
	if (version !== certifiedFallowCapabilities.manifestVersion) addDiagnostic(diagnostics, "capability manifest version", `expected ${certifiedFallowCapabilities.manifestVersion}, received ${text(version) ?? "missing"}`, allCommands());
}

function checkDefaultCommand(command: unknown, diagnostics: DiagnosticCollector): void {
	if (command !== certifiedFallowCapabilities.defaultCommand) addDiagnostic(diagnostics, "default command", "the root-command behavior changed", ["fallow_run all", "fallow_run check-changed", "/fallow all"]);
}

function checkInstalledVersion(version: unknown, diagnostics: DiagnosticCollector): void {
	if (!text(version)) addDiagnostic(diagnostics, "Fallow version", "version metadata is missing", allCommands());
}

function checkJsonOutput(formats: unknown, diagnostics: DiagnosticCollector): void {
	if (!stringArray(formats).includes("json")) addDiagnostic(diagnostics, "JSON output", "the installed schema does not advertise JSON", allCommands());
}

function checkModeledCommands(
	commands: Map<string, Record<string, any>>,
	globalFlags: Record<string, any>[],
	diagnostics: DiagnosticCollector,
): void {
	for (const command of fallowToolCommands) checkModeledCommand(commands, globalFlags, getFallowToolCommandSpec(command)!, diagnostics);
}

function checkModeledCommand(
	commands: Map<string, Record<string, any>>,
	globalFlags: Record<string, any>[],
	spec: FallowToolCommandSpec,
	diagnostics: DiagnosticCollector,
): void {
	const command = modeledCommand(commands, spec, diagnostics);
	if (command === null) return;
	const flags = [...recordArray(command?.flags), ...globalFlags];
	checkCommonCommandFlags(flags, spec, diagnostics);
	checkModeledPrefixAndInputs(command, flags, spec, diagnostics);
	checkSelectedCommandFlags(flags, spec, diagnostics);
}

function modeledCommand(
	commands: Map<string, Record<string, any>>,
	spec: FallowToolCommandSpec,
	diagnostics: DiagnosticCollector,
): Record<string, any> | undefined | null {
	const name = spec.cliPrefix[0];
	if (!name) return undefined;
	const command = commands.get(name);
	if (command) return command;
	addDiagnostic(diagnostics, `command ${name}`, "modeled command is missing", affectedToolCommand(spec));
	return null;
}

function checkCommonCommandFlags(flags: Record<string, any>[], spec: FallowToolCommandSpec, diagnostics: DiagnosticCollector): void {
	const affected = affectedToolCommand(spec);
	checkFlag(flags, "--format", "string", "JSON output", affected, diagnostics, supportsJson);
	checkFlag(flags, "--quiet", "bool", "quiet JSON output", affected, diagnostics);
}

function checkModeledPrefixAndInputs(
	command: Record<string, any> | undefined,
	flags: Record<string, any>[],
	spec: FallowToolCommandSpec,
	diagnostics: DiagnosticCollector,
): void {
	const suffix = spec.cliPrefix.slice(1);
	const affected = affectedToolCommand(spec);
	checkFixedPrefix(suffix, flags, spec, affected, diagnostics);
	checkPositionalTarget(command, suffix, spec, affected, diagnostics);
	checkRequiredInputs(flags, spec, affected, diagnostics);
	checkPositionalScanner(flags, spec, affected, diagnostics);
}

function checkSelectedCommandFlags(flags: Record<string, any>[], spec: FallowToolCommandSpec, diagnostics: DiagnosticCollector): void {
	const affected = affectedToolCommand(spec);
	if (spec.name === "check-changed") checkFlag(flags, "--changed-since", "string", "check-changed scope", affected, diagnostics);
	if (["dead-code", "health"].includes(spec.name)) checkTypeAwareFlags(flags, spec.name, affected, diagnostics);
}

function checkPositionalScanner(flags: Record<string, any>[], spec: FallowToolCommandSpec, affected: string[], diagnostics: DiagnosticCollector): void {
	for (const flag of (spec.positionalFlags ?? []).filter((name) => !["--help", "-h"].includes(name))) {
		checkFlag(flags, flag, "bool", `${spec.name} positional scanner ${flag}`, affected, diagnostics);
	}
}

function affectedToolCommand(spec: FallowToolCommandSpec): string[] {
	return [`fallow_run ${spec.name}`];
}

function supportsJson(flag: Record<string, any>): boolean {
	return stringArray(flag.possible_values).includes("json");
}

function checkFixedPrefix(
	suffix: readonly string[],
	flags: Record<string, any>[],
	spec: FallowToolCommandSpec,
	affected: string[],
	diagnostics: DiagnosticCollector,
): void {
	for (const [index, token] of suffix.entries()) checkFixedPrefixToken(token, index, suffix.length, flags, spec, affected, diagnostics);
}

function checkFixedPrefixToken(
	token: string,
	index: number,
	suffixLength: number,
	flags: Record<string, any>[],
	spec: FallowToolCommandSpec,
	affected: string[],
	diagnostics: DiagnosticCollector,
): void {
	if (!token.startsWith("-")) return; // Manifest v1 omits nested coverage commands.
	checkFlag(flags, token, fixedPrefixType(spec, index, suffixLength), `${spec.name} fixed prefix ${token}`, affected, diagnostics);
}

function fixedPrefixType(spec: FallowToolCommandSpec, index: number, suffixLength: number): string {
	return spec.positionalTarget && index === suffixLength - 1 ? "string" : "bool";
}

function checkPositionalTarget(
	command: Record<string, any> | undefined,
	suffix: readonly string[],
	spec: FallowToolCommandSpec,
	affected: string[],
	diagnostics: DiagnosticCollector,
): void {
	if (!hasManifestPositionalTarget(spec, suffix)) return;
	const positionals = recordArray(command?.flags).filter(isPositionalFlag);
	if (!isRequiredStringTarget(positionals)) addDiagnostic(diagnostics, `${spec.name} positional target`, "expected one required string target", affected);
}

function hasManifestPositionalTarget(spec: FallowToolCommandSpec, suffix: readonly string[]): boolean {
	if (!spec.positionalTarget) return false;
	return !suffix.at(-1)?.startsWith("-");
}

function isPositionalFlag(flag: Record<string, any>): boolean {
	return !text(flag.name)?.startsWith("-");
}

function isRequiredStringTarget(positionals: Record<string, any>[]): boolean {
	if (positionals.length !== 1) return false;
	const target = positionals[0]!;
	if (target.type !== "string") return false;
	return target.required === true;
}

function checkRequiredInputs(
	flags: Record<string, any>[],
	spec: FallowToolCommandSpec,
	affected: string[],
	diagnostics: DiagnosticCollector,
): void {
	for (const flag of flags.filter((entry) => entry.required === true)) {
		const name = text(flag.name);
		if (name && !suppliesRequiredInput(spec, name)) addDiagnostic(diagnostics, `${spec.name} required input ${name}`, "installed command requires an input Pi Fallow does not supply", affected);
	}
}

function suppliesRequiredInput(spec: FallowToolCommandSpec, name: string): boolean {
	if (name.startsWith("-")) {
		return [...spec.cliPrefix, "--format", "--quiet", ...(spec.name === "check-changed" ? ["--changed-since"] : [])].includes(name);
	}
	return spec.positionalTarget === true && spec.cliPrefix.length === 1;
}

function checkTypeAwareFlags(
	flags: Record<string, any>[],
	name: string,
	affected: string[],
	diagnostics: DiagnosticCollector,
): void {
	for (const [flag, type] of [
		["--type-aware", "bool"], ["--no-type-aware", "bool"], ["--type-aware-project", "string"],
		["--type-aware-require", "string"], ["--baseline-mode", "string"],
		[name === "dead-code" ? "--symbol-impact" : "--type-coupling", name === "dead-code" ? "string" : "bool"],
	] as const) checkFlag(flags, flag, type, `${name} ${flag}`, affected, diagnostics);
}

function checkFlag(
	flags: Record<string, any>[],
	name: string,
	type: string,
	capability: string,
	affected: string[],
	diagnostics: DiagnosticCollector,
	validate?: (flag: Record<string, any>) => boolean,
): void {
	const flag = flags.find((entry) => entry.name === name || entry.short === name);
	if (!flag) return addDiagnostic(diagnostics, capability, `${name} is missing`, affected);
	checkFlagCompatibility(flag, name, type, capability, affected, diagnostics, validate);
}

function checkFlagCompatibility(
	flag: Record<string, any>,
	name: string,
	type: string,
	capability: string,
	affected: string[],
	diagnostics: DiagnosticCollector,
	validate?: (flag: Record<string, any>) => boolean,
): void {
	if (flag.type !== type) return addDiagnostic(diagnostics, capability, `${name} changed from ${type} to ${text(flag.type) ?? "unknown"}`, affected);
	checkFlagValue(flag, name, capability, affected, diagnostics, validate);
}

function checkFlagValue(
	flag: Record<string, any>,
	name: string,
	capability: string,
	affected: string[],
	diagnostics: DiagnosticCollector,
	validate?: (flag: Record<string, any>) => boolean,
): void {
	if (!validate) return;
	if (!validate(flag)) addDiagnostic(diagnostics, capability, `${name} no longer supports the required value`, affected);
}

function checkIssueTypes(root: Record<string, any>, diagnostics: DiagnosticCollector): void {
	if (!Array.isArray(root.issue_types)) return addDiagnostic(diagnostics, "issue type registry", "installed manifest does not expose issue types", reportCommands());
	const installed = buildIssueTypeMap(recordArray(root.issue_types), diagnostics);
	checkCertifiedIssueTypes(installed, diagnostics);
}

function buildIssueTypeMap(entries: Record<string, any>[], diagnostics: DiagnosticCollector): Map<string, Record<string, any>> {
	const installed = new Map<string, Record<string, any>>();
	for (const entry of entries) addIssueTypeEntry(installed, entry, diagnostics);
	return installed;
}

function addIssueTypeEntry(installed: Map<string, Record<string, any>>, entry: Record<string, any>, diagnostics: DiagnosticCollector): void {
	const id = text(entry.id);
	if (!id) return;
	if (installed.has(id)) addDiagnostic(diagnostics, `issue type ${id}`, "duplicate issue type id", affectedIssueCommands(text(entry.command)));
	else installed.set(id, entry);
}

function checkCertifiedIssueTypes(installed: Map<string, Record<string, any>>, diagnostics: DiagnosticCollector): void {
	const missing = new Map<string, string[]>();
	for (const expected of certifiedFallowCapabilities.issueTypes) checkCertifiedIssueType(installed, expected, missing, diagnostics);
	for (const [command, ids] of missing) addDiagnostic(diagnostics, `${command} issue types`, `missing ${summarizeNames(ids)}`, affectedIssueCommands(command));
}

function checkCertifiedIssueType(
	installed: Map<string, Record<string, any>>,
	expected: readonly [string, string, string | null],
	missing: Map<string, string[]>,
	diagnostics: DiagnosticCollector,
): void {
	const [id, command, resultKey] = expected;
	const current = installed.get(id);
	if (!current) return addMissingIssueType(missing, command, id);
	if (!hasCompatibleIssueMapping(current, command, resultKey)) addDiagnostic(diagnostics, `issue type ${id}`, "command or report-key mapping changed", affectedIssueCommands(command));
}

function addMissingIssueType(missing: Map<string, string[]>, command: string, id: string): void {
	const list = missing.get(command) ?? [];
	list.push(id);
	missing.set(command, list);
}

function hasCompatibleIssueMapping(current: Record<string, any>, command: string, resultKey: string | null): boolean {
	if (current.command !== command) return false;
	return resultKey === null || current.result_key === resultKey;
}

function checkCertifiedSurfaceRemovals(
	root: Record<string, any>,
	commands: Map<string, Record<string, any>>,
	advisories: string[],
): void {
	const modeledRoots = modeledCommandRoots();
	appendMissingAdvisory(advisories, "Certified but unmodeled commands absent", unmodeledMissingCommands(commands, modeledRoots), ".");
	const nonJsonFormats = certifiedFallowCapabilities.outputFormats.filter((name) => name !== "json");
	appendMissingAdvisory(advisories, "Certified non-JSON formats absent", missingValues(nonJsonFormats, stringArray(root.output_formats)), "; Pi Fallow only requires JSON.");
	appendMissingAdvisory(advisories, "Certified reference resources absent", missingValues(certifiedFallowCapabilities.resourceUris, installedResourceUris(root)), "; Pi Fallow does not consume them at runtime.");
	appendMissingAdvisory(advisories, "Certified related-schema commands absent", missingValues(certifiedFallowCapabilities.relatedSchemaCommands, installedRelatedSchemaCommands(root)), "; Pi Fallow does not invoke them.");
}

function modeledCommandRoots(): Set<string | undefined> {
	return new Set(fallowToolCommands.map((name) => getFallowToolCommandSpec(name)?.cliPrefix[0]));
}

function unmodeledMissingCommands(commands: Map<string, Record<string, any>>, modeled: Set<string | undefined>): string[] {
	return Object.keys(certifiedFallowCapabilities.commands).filter((name) => !modeled.has(name) && !commands.has(name));
}

function missingValues(certified: readonly string[], installed: readonly string[]): string[] {
	const available = new Set(installed);
	return certified.filter((value) => !available.has(value));
}

function appendMissingAdvisory(advisories: string[], label: string, missing: string[], suffix: string): void {
	if (missing.length) advisories.push(`${label}: ${summarizeNames(missing)}${suffix}`);
}

function collectAdditions(
	root: Record<string, any>,
	commands: Map<string, Record<string, any>>,
	globalFlags: Record<string, any>[],
): FallowCapabilityAddition[] {
	const additions: Array<[DiagnosticKind, string[]]> = [];
	additions.push(["commands", difference([...commands.keys()], Object.keys(certifiedFallowCapabilities.commands))]);
	additions.push(["global flags", difference(flagNames(globalFlags), certifiedFallowCapabilities.globalFlags)]);
	const commandFlags: string[] = [];
	for (const [name, command] of commands) {
		const known = certifiedFallowCapabilities.commands[name as keyof typeof certifiedFallowCapabilities.commands];
		if (!known) continue;
		for (const flag of difference(flagNames(recordArray(command.flags)), known)) commandFlags.push(`${name} ${flag}`);
	}
	additions.push(["command flags", commandFlags]);
	additions.push(["issue types", difference(recordArray(root.issue_types).map((item) => text(item.id)).filter(isString), certifiedFallowCapabilities.issueTypes.map(([id]) => id))]);
	additions.push(["output formats", difference(stringArray(root.output_formats), certifiedFallowCapabilities.outputFormats)]);
	additions.push(["resources", difference(installedResourceUris(root), certifiedFallowCapabilities.resourceUris)]);
	additions.push(["related schemas", difference(installedRelatedSchemaCommands(root), certifiedFallowCapabilities.relatedSchemaCommands)]);
	return additions.filter(([, names]) => names.length).map(([kind, names]) => ({
		kind,
		names: names.slice(0, MAX_NAMES).map(boundedName),
		omitted: Math.max(0, names.length - MAX_NAMES),
	}));
}

function uniqueRecordMap(
	items: Record<string, any>[],
	key: string,
	diagnostics: DiagnosticCollector,
	capability: string,
	affected: string[],
): Map<string, Record<string, any>> {
	const map = new Map<string, Record<string, any>>();
	for (const item of items) {
		const value = text(item[key]);
		if (!value) continue;
		if (map.has(value)) addDiagnostic(diagnostics, capability, `duplicate ${value}`, affected);
		else map.set(value, item);
	}
	return map;
}

function addDiagnostic(collector: DiagnosticCollector, capability: string, detail: string, affected: string[]): void {
	const key = `${capability}\u0000${detail}`;
	const existing = collector.get(key) ?? { capability, detail, affected: new Set<string>() };
	for (const command of affected) existing.affected.add(command);
	collector.set(key, existing);
}

function boundedDiagnostics(collector: DiagnosticCollector): FallowCapabilityDiagnostic[] {
	return [...collector.values()].slice(0, MAX_DIAGNOSTICS).map((item) => ({
		capability: boundedText(item.capability),
		detail: boundedText(item.detail),
		affectedCommands: boundedAffectedCommands(item.affected),
	}));
}

function boundedAffectedCommands(commands: Set<string>): string[] {
	const values = [...commands];
	if (values.length <= MAX_NAMES) return values;
	return [...values.slice(0, MAX_NAMES - 1), `+${values.length - MAX_NAMES + 1} more Pi commands`];
}

function unavailableReport(summary: string): FallowCompatibilityReport {
	return {
		status: "unavailable",
		certifiedVersion: certifiedFallowCapabilities.certifiedVersion,
		summary: boundedText(summary),
		incompatible: [],
		incompatibleOmitted: 0,
		additions: [],
		advisories: [],
		certifiedReportSchemas: { ...certifiedFallowCapabilities.reportSchemas },
	};
}

function compatibilitySummary(status: CompatibilityStatus, additions: FallowCapabilityAddition[]): string {
	if (status === "incompatible") return "incompatible modeled capability drift detected (execution remains ungated)";
	if (additions.length) return "compatible; additive capabilities are available directly in Fallow";
	return "compatible with the certified modeled surface";
}

function appendIncompatibleLines(lines: string[], report: FallowCompatibilityReport): void {
	if (!report.incompatible.length) return;
	lines.push("", "Modeled incompatibilities:");
	for (const item of report.incompatible) lines.push(`- ${item.capability}: ${item.detail} [affects ${item.affectedCommands.join(", ")}]`);
	if (report.incompatibleOmitted) lines.push(`- … ${report.incompatibleOmitted} additional diagnostics omitted`);
}

function appendAdditionLines(lines: string[], additions: FallowCapabilityAddition[]): void {
	if (!additions.length) return;
	lines.push("", "Additive capabilities (use the Fallow CLI directly until Pi Fallow models them):");
	for (const addition of additions) lines.push(`- ${addition.kind}: ${addition.names.join(", ")}${addition.omitted ? ` (+${addition.omitted} more)` : ""}`);
}

function allCommands(): string[] {
	return ["all fallow_run commands", "/fallow commands"];
}

function reportCommands(): string[] {
	return ["fallow_run all", "fallow_run dead-code", "fallow_run dupes", "fallow_run health", "fallow_run security", "/fallow issues"];
}

function affectedIssueCommands(command: string | undefined): string[] {
	if (!command) return reportCommands();
	return [...new Set([`/fallow ${command}`, ...affectedIssueTools(command), ...aggregateIssueCommand(command)])];
}

function affectedIssueTools(command: string): string[] {
	return fallowToolCommands
		.filter((name) => getFallowToolCommandSpec(name)?.cliPrefix[0] === command)
		.map((name) => `fallow_run ${name}`);
}

function aggregateIssueCommand(command: string): string[] {
	return ANALYSIS_COMMANDS.has(command) ? ["/fallow issues"] : [];
}

function installedResourceUris(root: Record<string, any>): string[] {
	return recordArray(asRecord(root.mcp_resources)?.resources).map((item) => text(item.uri)).filter(isString);
}

function installedRelatedSchemaCommands(root: Record<string, any>): string[] {
	const related = asRecord(root.related_schemas);
	if (!related) return [];
	return Object.entries(related).filter(([key, value]) => key.endsWith("_command") && typeof value === "string").map(([, value]) => value as string);
}

function recordArray(value: unknown): Record<string, any>[] {
	return Array.isArray(value) ? value.map(asRecord).filter((item): item is Record<string, any> => !!item) : [];
}

function arrayLength(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter(isString) : [];
}

function flagNames(flags: Record<string, any>[]): string[] {
	return flags.map((flag) => text(flag.name)).filter(isString);
}

function difference(values: readonly string[], known: readonly string[]): string[] {
	const knownSet = new Set(known);
	return [...new Set(values.filter((value) => !knownSet.has(value)))].sort((left, right) => left.localeCompare(right));
}

function summarizeNames(names: readonly string[]): string {
	return `${names.slice(0, MAX_NAMES).join(", ")}${names.length > MAX_NAMES ? ` (+${names.length - MAX_NAMES} more)` : ""}`;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function boundedOptionalName(value: unknown): string | undefined {
	const name = text(value);
	return name ? boundedName(name) : undefined;
}

function boundedName(value: string): string {
	return sanitizeText(value).slice(0, MAX_NAME_TEXT) || "unavailable";
}

function boundedText(value: string): string {
	return sanitizeText(value).slice(0, MAX_TEXT) || "unavailable";
}

function sanitizeText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
}
