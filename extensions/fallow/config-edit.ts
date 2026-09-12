type JsonNode = JsonObjectNode | JsonArrayNode | JsonValueNode;

type JsonMember = {
	key: string;
	keyStart: number;
	value: JsonNode;
	hasComma: boolean;
};

type JsonObjectNode = {
	type: "object";
	start: number;
	end: number;
	members: JsonMember[];
	trailingTriviaStart: number;
};

type JsonArrayNode = { type: "array"; start: number; end: number };
type JsonValueNode = { type: "value"; start: number; end: number; value: unknown };

type TomlLine = { text: string; index: number; offset: number; table?: string };
type TomlRule = { start: number; end: number; severity: string };

export type ConfigTextEdit = {
	content: string;
	previous: string | undefined;
	changed: boolean;
	format: "jsonc" | "toml";
};

/** Updates only one rule severity. No unrelated config value is returned to callers. */
export function editFallowRuleConfig(source: string, fileName: string, rule: string, severity: string): ConfigTextEdit {
	return isTomlFile(fileName) ? editTomlRule(source, rule, severity) : editJsonRule(source, rule, severity);
}

export function createFallowRuleConfig(rule: string, severity: string, inheritedSource?: string): ConfigTextEdit {
	const extendsLine = inheritedSource ? `  "extends": ${JSON.stringify(inheritedSource)},\n` : "";
	const content = `{
  "$schema": "https://unpkg.com/fallow/schema.json",
${extendsLine}  "rules": {
    ${JSON.stringify(rule)}: ${JSON.stringify(severity)}
  }
}
`;
	return { content, previous: undefined, changed: true, format: "jsonc" };
}

function isTomlFile(fileName: string): boolean {
	return fileName.endsWith(".toml");
}

function editJsonRule(source: string, rule: string, severity: string): ConfigTextEdit {
	const root = new JsoncParser(source).parse();
	assertObjectNode(root, "$", "configuration root must be an object");
	const rulesMember = memberNamed(root, "rules");
	return rulesMember
		? editJsonRulesMember(source, rulesMember, rule, severity)
		: addedJsonEdit(source, root, `"rules": { ${JSON.stringify(rule)}: ${JSON.stringify(severity)} }`);
}

function editJsonRulesMember(source: string, rulesMember: JsonMember, rule: string, severity: string): ConfigTextEdit {
	assertObjectNode(rulesMember.value, "$.rules", "must be an object");
	const ruleMember = memberNamed(rulesMember.value, rule);
	return ruleMember
		? replaceJsonSeverity(source, ruleMember, rule, severity)
		: addedJsonEdit(source, rulesMember.value, `${JSON.stringify(rule)}: ${JSON.stringify(severity)}`);
}

function replaceJsonSeverity(source: string, member: JsonMember, rule: string, severity: string): ConfigTextEdit {
	const value = member.value;
	assertStringNode(value, `$.rules.${rule}`);
	if (value.value === severity) return { content: source, previous: severity, changed: false, format: "jsonc" };
	return {
		content: `${source.slice(0, value.start)}${JSON.stringify(severity)}${source.slice(value.end)}`,
		previous: value.value,
		changed: true,
		format: "jsonc",
	};
}

function addedJsonEdit(source: string, object: JsonObjectNode, entry: string): ConfigTextEdit {
	return { content: insertJsonMember(source, object, entry), previous: undefined, changed: true, format: "jsonc" };
}

function assertObjectNode(node: JsonNode, path: string, message: string): asserts node is JsonObjectNode {
	if (node.type !== "object") throw configSyntaxError(path, message);
}

function assertStringNode(node: JsonNode, path: string): asserts node is JsonValueNode & { value: string } {
	if (node.type !== "value" || typeof node.value !== "string") throw configSyntaxError(path, "must be a severity string");
}

function memberNamed(node: JsonObjectNode, name: string): JsonMember | undefined {
	return node.members.find((member) => member.key === name);
}

function insertJsonMember(source: string, object: JsonObjectNode, entry: string): string {
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const closeIndent = indentationAt(source, object.end - 1);
	const childIndent = inferChildIndent(source, object, closeIndent);
	return object.members.length
		? insertIntoPopulatedObject(source, object, entry, newline, childIndent)
		: `${source.slice(0, object.end - 1)}${newline}${childIndent}${entry}${newline}${closeIndent}${source.slice(object.end - 1)}`;
}

function insertIntoPopulatedObject(source: string, object: JsonObjectNode, entry: string, newline: string, indent: string): string {
	const last = object.members.at(-1)!;
	const before = source.slice(0, object.trailingTriviaStart);
	const withComma = last.hasComma ? before : `${source.slice(0, last.value.end)},${source.slice(last.value.end, object.trailingTriviaStart)}`;
	return `${withComma}${newline}${indent}${entry}${source.slice(object.trailingTriviaStart)}`;
}

function inferChildIndent(source: string, object: JsonObjectNode, closeIndent: string): string {
	const existing = object.members[0] ? indentationAt(source, object.members[0]!.keyStart) : "";
	if (existing.length > closeIndent.length) return existing;
	return `${closeIndent}${/\n\t+[^\s]/.test(source) ? "\t" : "  "}`;
}

function indentationAt(source: string, offset: number): string {
	const lineStart = Math.max(source.lastIndexOf("\n", offset - 1) + 1, 0);
	return /^[\t ]*/.exec(source.slice(lineStart, offset))?.[0] ?? "";
}

function editTomlRule(source: string, rule: string, severity: string): ConfigTextEdit {
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const lines = tomlLines(source);
	const tables = lines.filter((line) => line.table === "rules");
	assertSingleTomlItem(tables.length, "$.rules", "duplicate [rules] table");
	return tables[0]
		? editTomlRulesTable(source, lines, tables[0], rule, severity, newline)
		: addTomlRulesTable(source, rule, severity, newline);
}

function editTomlRulesTable(source: string, lines: TomlLine[], table: TomlLine, rule: string, severity: string, newline: string): ConfigTextEdit {
	const range = tomlTableRange(lines, table);
	const matches = lines.slice(range.start + 1, range.end)
		.map((line) => parseTomlRule(line, rule))
		.filter((value): value is TomlRule => Boolean(value));
	assertSingleTomlItem(matches.length, `$.rules.${rule}`, "duplicate rule key");
	return matches[0]
		? replaceTomlSeverity(source, matches[0], severity)
		: insertTomlRule(source, lines, range.end, rule, severity, newline);
}

function assertSingleTomlItem(count: number, path: string, message: string): void {
	if (count > 1) throw configSyntaxError(path, message);
}

function tomlLines(source: string): TomlLine[] {
	let offset = 0;
	return source.split(/(?<=\n)/).map((text, index) => {
		const line = { text, index, offset, table: parseTomlTable(text) };
		offset += text.length;
		return line;
	});
}

function parseTomlTable(line: string): string | undefined {
	return /^\s*\[([^\]]+)]\s*(?:#.*)?(?:\r?\n)?$/.exec(line)?.[1]?.trim();
}

function tomlTableRange(lines: TomlLine[], table: TomlLine): { start: number; end: number } {
	const next = lines.find((line) => line.index > table.index && line.table !== undefined);
	return { start: table.index, end: next?.index ?? lines.length };
}

function parseTomlRule(line: TomlLine, expectedRule: string): TomlRule | undefined {
	const match = /^(\s*)("(?:\\.|[^"])*"|'[^']*'|[A-Za-z0-9_-]+)(\s*=\s*)([^\r\n]*)/.exec(line.text);
	if (!match || decodeTomlKey(match[2]!) !== expectedRule) return undefined;
	return parseTomlSeverity(match, line.offset, expectedRule);
}

function decodeTomlKey(token: string): string {
	if (token.startsWith('"')) return decodeTomlBasicKey(token);
	return token.startsWith("'") ? token.slice(1, -1) : token;
}

function decodeTomlBasicKey(token: string): string {
	try { return JSON.parse(token); }
	catch { throw configSyntaxError("$.rules", "unsupported quoted rule key"); }
}

function parseTomlSeverity(match: RegExpExecArray, offset: number, rule: string): TomlRule {
	const value = /^(["'])(error|warn|off)\1/.exec(match[4]!);
	if (!value) throw configSyntaxError(`$.rules.${rule}`, "must be a severity string");
	const start = offset + match[1]!.length + match[2]!.length + match[3]!.length;
	return { start, end: start + value[2]!.length + 2, severity: value[2]! };
}

function replaceTomlSeverity(source: string, current: TomlRule, severity: string): ConfigTextEdit {
	if (current.severity === severity) return { content: source, previous: severity, changed: false, format: "toml" };
	const quote = source[current.start]!;
	return {
		content: `${source.slice(0, current.start)}${quote}${severity}${quote}${source.slice(current.end)}`,
		previous: current.severity,
		changed: true,
		format: "toml",
	};
}

function addTomlRulesTable(source: string, rule: string, severity: string, newline: string): ConfigTextEdit {
	const separator = source.length && !source.endsWith("\n") ? newline : "";
	const blank = source.trim() ? newline : "";
	return tomlAddition(`${source}${separator}${blank}[rules]${newline}${tomlAssignment(rule, severity, newline)}`);
}

function insertTomlRule(source: string, lines: TomlLine[], endIndex: number, rule: string, severity: string, newline: string): ConfigTextEdit {
	const insertionOffset = lines.slice(0, endIndex).reduce((sum, line) => sum + line.text.length, 0);
	const before = source.slice(0, insertionOffset);
	const separator = before && !before.endsWith("\n") ? newline : "";
	return tomlAddition(`${before}${separator}${tomlAssignment(rule, severity, newline)}${source.slice(insertionOffset)}`);
}

function tomlAssignment(rule: string, severity: string, newline: string): string {
	return `${rule} = ${JSON.stringify(severity)}${newline}`;
}

function tomlAddition(content: string): ConfigTextEdit {
	return { content, previous: undefined, changed: true, format: "toml" };
}

function configSyntaxError(path: string, message: string): Error {
	return new Error(`Invalid Fallow configuration at schema path ${path}: ${message}.`);
}

class JsoncParser {
	private index = 0;
	constructor(private readonly source: string) {}

	parse(): JsonNode {
		this.skipTrivia();
		const value = this.parseValue("$");
		this.skipTrivia();
		if (this.index !== this.source.length) this.fail("$", "unexpected trailing content");
		return value;
	}

	private parseValue(path: string): JsonNode {
		this.skipTrivia();
		const char = this.source[this.index];
		if (char === "{") return this.parseObject(path);
		if (char === "[") return this.parseArray(path);
		return char === '"' ? this.stringValue(path) : this.parsePrimitive(path);
	}

	private stringValue(path: string): JsonValueNode {
		const token = this.parseString(path);
		return { type: "value", start: token.start, end: token.end, value: token.value };
	}

	private parseObject(path: string): JsonObjectNode {
		const start = this.index++;
		const members: JsonMember[] = [];
		this.skipTrivia();
		while (this.source[this.index] !== "}") {
			if (this.index >= this.source.length) this.fail(path, "unterminated object");
			members.push(this.parseMember(path, members));
		}
		const trailingTriviaStart = this.index;
		this.index++;
		return { type: "object", start, end: this.index, members, trailingTriviaStart };
	}

	private parseMember(path: string, members: JsonMember[]): JsonMember {
		const key = this.parseString(path);
		this.assertUniqueMember(path, key.value, members);
		this.skipTrivia();
		if (this.source[this.index++] !== ":") this.fail(`${path}.${key.value}`, "expected ':'");
		const value = this.parseValue(`${path}.${key.value}`);
		this.skipTrivia();
		const hasComma = this.consumeComma();
		this.assertMemberSeparator(path, hasComma);
		return { key: key.value, keyStart: key.start, value, hasComma };
	}

	private assertUniqueMember(path: string, key: string, members: JsonMember[]): void {
		if (members.some((member) => member.key === key)) this.fail(`${path}.${key}`, "duplicate key");
	}

	private assertMemberSeparator(path: string, hasComma: boolean): void {
		if (this.source[this.index] !== "}" && !hasComma) this.fail(path, "expected ','");
	}

	private consumeComma(): boolean {
		if (this.source[this.index] !== ",") return false;
		this.index++;
		this.skipTrivia();
		return true;
	}

	private parseArray(path: string): JsonArrayNode {
		const start = this.index++;
		this.skipTrivia();
		while (this.source[this.index] !== "]") this.parseArrayItem(path);
		this.index++;
		return { type: "array", start, end: this.index };
	}

	private parseArrayItem(path: string): void {
		if (this.index >= this.source.length) this.fail(path, "unterminated array");
		this.parseValue(`${path}[]`);
		this.skipTrivia();
		const hasComma = this.consumeComma();
		if (this.source[this.index] !== "]" && !hasComma) this.fail(path, "expected ','");
	}

	private parseString(path: string): { start: number; end: number; value: string } {
		const start = this.index;
		if (this.source[this.index++] !== '"') this.fail(path, "expected a quoted key");
		while (this.index < this.source.length) {
			if (this.consumeStringCharacter()) return this.decodeString(path, start);
		}
		this.fail(path, "unterminated string");
	}

	private consumeStringCharacter(): boolean {
		const char = this.source[this.index++];
		if (char === "\\") this.index++;
		return char === '"';
	}

	private decodeString(path: string, start: number): { start: number; end: number; value: string } {
		try { return { start, end: this.index, value: JSON.parse(this.source.slice(start, this.index)) }; }
		catch { this.fail(path, "invalid string"); }
	}

	private parsePrimitive(path: string): JsonValueNode {
		const start = this.index;
		this.scanPrimitive();
		return { type: "value", start, end: this.index, value: this.decodePrimitive(path, start) };
	}

	private scanPrimitive(): void {
		while (this.index < this.source.length && !/[\s,}\]]/.test(this.source[this.index]!) && !this.startsComment()) this.index++;
	}

	private decodePrimitive(path: string, start: number): unknown {
		try {
			const value = JSON.parse(this.source.slice(start, this.index));
			if (typeof value === "object" && value !== null) this.fail(path, "invalid value");
			return value;
		} catch {
			this.fail(path, "invalid value");
		}
	}

	private skipTrivia(): void {
		while (this.skipOneTrivia()) { /* consume */ }
	}

	private skipOneTrivia(): boolean {
		if (/\s/.test(this.source.charAt(this.index))) { this.index++; return true; }
		if (this.source.startsWith("//", this.index)) { this.skipLineComment(); return true; }
		if (this.source.startsWith("/*", this.index)) { this.skipBlockComment(); return true; }
		return false;
	}

	private skipLineComment(): void {
		const end = this.source.indexOf("\n", this.index + 2);
		this.index = end < 0 ? this.source.length : end + 1;
	}

	private skipBlockComment(): void {
		const end = this.source.indexOf("*/", this.index + 2);
		if (end < 0) this.fail("$", "unterminated comment");
		this.index = end + 2;
	}

	private startsComment(): boolean {
		return this.source.startsWith("//", this.index) || this.source.startsWith("/*", this.index);
	}

	private fail(path: string, message: string): never {
		throw configSyntaxError(path, `${message} near character ${this.index}`);
	}
}
