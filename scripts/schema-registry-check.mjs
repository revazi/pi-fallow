import assert from "node:assert/strict";

function requireFlag(flags, name, type, context) {
	const flag = flags.find((entry) => entry.name === name || entry.short === name);
	assert.ok(flag, `${context}: schema is missing ${name}`);
	assert.equal(flag.type, type, `${context}: ${name} must remain ${type}`);
	return flag;
}

// Development certification only: this does not run during extension loading or
// constrain the version of a separately installed Fallow executable.
export function assertRegistrySchema(schema, specs) {
	assert.equal(schema.name, "fallow");
	assert.equal(schema.manifest_version, "1", "Review the changed capability manifest format");
	assert.ok(Array.isArray(schema.commands), "schema.commands must be an array");
	assert.ok(Array.isArray(schema.global_flags), "schema.global_flags must be an array");
	assert.ok(schema.output_formats?.includes("json"), "schema must support JSON output");
	const commands = new Map(schema.commands.map((command) => [command.name, command]));
	assert.equal(commands.size, schema.commands.length, "schema contains duplicate command names");

	for (const spec of specs) assertCommandSchema(schema, commands, spec);
}

function resolveCommand(schema, commands, root, context) {
	if (!root) {
		assert.equal(schema.default_command, null, `${context}: review changed default command`);
		return { flags: [] };
	}
	const command = commands.get(root);
	assert.ok(command, `${context}: schema is missing command ${root}`);
	assert.ok(Array.isArray(command.flags), `${context}: command flags must be an array`);
	return command;
}

function assertCommandSchema(schema, commands, spec) {
	const [root, ...suffix] = spec.cliPrefix;
	const context = `${spec.name} -> ${root ?? "(default)"}`;
	const command = resolveCommand(schema, commands, root, context);
	// Local definitions take precedence, so an incompatible shadow of a
	// managed global flag cannot silently pass this check.
	const flags = [...command.flags, ...schema.global_flags];
	assertManagedOutput(flags, context);
	assertPrefix(suffix, flags, spec, context);
	assertTarget(command, suffix, spec, context);
	assertRequiredArguments(flags, spec, context);
	assertPositionalFlags(flags, spec, context);
	if (spec.name === "check-changed") requireFlag(flags, "--changed-since", "string", context);
	if (["dead-code", "health"].includes(spec.name)) assertTypeAwareFlags(flags, spec.name, context);
}

function assertManagedOutput(flags, context) {
	const format = requireFlag(flags, "--format", "string", context);
	assert.ok(format.possible_values?.includes("json"), `${context}: --format must accept json`);
	requireFlag(flags, "--quiet", "bool", context);
}

function assertPrefix(suffix, flags, spec, context) {
	for (const [index, token] of suffix.entries()) {
		const takesTarget = spec.positionalTarget && index === suffix.length - 1;
		assertPrefixToken(token, flags, takesTarget, spec, context);
	}
}

function assertPrefixToken(token, flags, takesTarget, spec, context) {
	if (!token.startsWith("-")) {
		// Manifest v1 lists coverage but omits its nested commands. Keep this
		// sole exception explicit; smoke:fallow separately checks analyze help.
		assert.deepEqual(spec.cliPrefix, ["coverage", "analyze"], `${context}: unverified nested CLI prefix`);
		return;
	}
	requireFlag(flags, token, takesTarget ? "string" : "bool", context);
}

function assertTarget(command, suffix, spec, context) {
	if (!spec.positionalTarget || suffix.at(-1)?.startsWith("-")) return;
	const positionals = command.flags.filter((flag) => !flag.name.startsWith("-"));
	assert.equal(positionals.length, 1, `${context}: expected one positional target`);
	assert.equal(positionals[0].type, "string", `${context}: positional target must remain string`);
	assert.equal(positionals[0].required, true, `${context}: review changed positional target requirement`);
}

function assertRequiredArguments(flags, spec, context) {
	for (const flag of flags.filter((entry) => entry.required)) {
		assert.ok(suppliesRequiredArgument(spec, flag), `${context}: new required argument ${flag.name}`);
	}
}

function suppliesRequiredArgument(spec, flag) {
	const normalizedFlags = spec.name === "check-changed" ? ["--changed-since"] : [];
	if (flag.name.startsWith("-")) return [...spec.cliPrefix, "--format", "--quiet", ...normalizedFlags].includes(flag.name);
	return spec.positionalTarget === true && spec.cliPrefix.length === 1;
}

function assertPositionalFlags(flags, spec, context) {
	for (const flag of spec.positionalFlags ?? []) {
		// Clap's built-in help flags are not advertised in manifest v1.
		if (["--help", "-h"].includes(flag)) continue;
		requireFlag(flags, flag, "bool", context);
	}
}

function assertTypeAwareFlags(flags, name, context) {
	for (const [flag, type] of [
		["--type-aware", "bool"], ["--no-type-aware", "bool"],
		["--type-aware-project", "string"], ["--type-aware-require", "string"],
		["--baseline-mode", "string"],
		[name === "dead-code" ? "--symbol-impact" : "--type-coupling", name === "dead-code" ? "string" : "bool"],
	]) requireFlag(flags, flag, type, context);
}
