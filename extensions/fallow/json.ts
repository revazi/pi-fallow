const JSON_VALUE_STARTS = new Set([
	'"', "{", "[", "-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "t", "f", "n",
]);
const JSON_OBJECT_ROOT_TOKENS = new Set(['"', "}"]);

type ParsedJson = { ok: true; data: unknown; raw: string };

export type ParsedFallowOutput =
	| { parsed: true; data: unknown; raw: string }
	| { parsed: false; raw: string };

interface JsonScanState {
	start?: number;
	expectedClosers: string[];
	rootKind?: "object" | "array";
	awaitingRootToken: boolean;
	inString: boolean;
	escaped: boolean;
}

interface JsonRange {
	start: number;
	end: number;
}

function tryParseJson(raw: string): ParsedJson | { ok: false } {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false };
	const direct = parseJsonText(trimmed);
	if (direct) return direct;
	const embedded = parseEmbeddedJson(trimmed);
	return embedded ?? { ok: false };
}

function parseJsonText(raw: string): ParsedJson | undefined {
	try {
		return { ok: true, data: JSON.parse(raw), raw };
	} catch {
		return undefined;
	}
}

function parseEmbeddedJson(raw: string): ParsedJson | undefined {
	const state = createJsonScanState();
	let lastParsed: ParsedJson | undefined;
	for (let index = 0; index < raw.length; index++) {
		const range = scanJsonCharacter(state, raw[index]!, index);
		if (!range) continue;
		const parsed = parseJsonText(raw.slice(range.start, range.end));
		if (parsed) lastParsed = parsed;
	}
	return lastParsed;
}

function createJsonScanState(): JsonScanState {
	return { expectedClosers: [], awaitingRootToken: false, inString: false, escaped: false };
}

function scanJsonCharacter(state: JsonScanState, character: string, index: number): JsonRange | undefined {
	if (state.start === undefined) return startJsonCandidate(state, character, index);
	if (state.inString) {
		consumeJsonStringCharacter(state, character);
		return undefined;
	}
	if (!acceptRootToken(state, character)) return restartJsonCandidate(state, character, index);
	return scanJsonStructure(state, character, index);
}

function startJsonCandidate(state: JsonScanState, character: string, index: number): undefined {
	const closer = expectedJsonCloser(character);
	if (!closer) return undefined;
	state.start = index;
	state.rootKind = character === "{" ? "object" : "array";
	state.awaitingRootToken = true;
	state.expectedClosers.push(closer);
	return undefined;
}

function acceptRootToken(state: JsonScanState, character: string): boolean {
	if (!state.awaitingRootToken) return true;
	if (/\s/.test(character)) return true;
	state.awaitingRootToken = false;
	return isRootToken(state.rootKind, character);
}

function isRootToken(rootKind: JsonScanState["rootKind"], character: string): boolean {
	if (rootKind === "object") return JSON_OBJECT_ROOT_TOKENS.has(character);
	return character === "]" || JSON_VALUE_STARTS.has(character);
}

function restartJsonCandidate(state: JsonScanState, character: string, index: number): undefined {
	resetJsonScanState(state);
	return startJsonCandidate(state, character, index);
}

function scanJsonStructure(state: JsonScanState, character: string, index: number): JsonRange | undefined {
	if (character === '"') {
		state.inString = true;
		return undefined;
	}
	const closer = expectedJsonCloser(character);
	if (closer) {
		state.expectedClosers.push(closer);
		return undefined;
	}
	return closeJsonStructure(state, character, index);
}

function closeJsonStructure(state: JsonScanState, character: string, index: number): JsonRange | undefined {
	if (!isJsonCloser(character)) return undefined;
	if (state.expectedClosers.at(-1) !== character) {
		resetJsonScanState(state);
		return undefined;
	}
	state.expectedClosers.pop();
	if (state.expectedClosers.length) return undefined;
	const range = { start: state.start!, end: index + 1 };
	resetJsonScanState(state);
	return range;
}

function consumeJsonStringCharacter(state: JsonScanState, character: string): void {
	if (state.escaped) {
		state.escaped = false;
		return;
	}
	if (character === "\\") {
		state.escaped = true;
		return;
	}
	if (character === '"') state.inString = false;
}

function isJsonCloser(character: string): boolean {
	return character === "}" || character === "]";
}

function expectedJsonCloser(character: string): string | undefined {
	if (character === "{") return "}";
	if (character === "[") return "]";
	return undefined;
}

function resetJsonScanState(state: JsonScanState): void {
	state.start = undefined;
	state.expectedClosers.length = 0;
	state.rootKind = undefined;
	state.awaitingRootToken = false;
	state.inString = false;
	state.escaped = false;
}

export function parseJson(stdout: string, stderr: string): ParsedFallowOutput {
	const stdoutParsed = tryParseJson(stdout);
	if (stdoutParsed.ok) return parsedOutput(stdoutParsed);
	const stderrParsed = tryParseJson(stderr);
	if (stderrParsed.ok) return parsedOutput(stderrParsed);
	const combinedParsed = tryParseJson(`${stdout}\n${stderr}`);
	if (combinedParsed.ok) return parsedOutput(combinedParsed);
	return { parsed: false, raw: unparsedOutput(stdout, stderr) };
}

function unparsedOutput(stdout: string, stderr: string): string {
	return `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
}

function parsedOutput(parsed: ParsedJson): ParsedFallowOutput {
	return { parsed: true, data: parsed.data, raw: parsed.raw };
}
