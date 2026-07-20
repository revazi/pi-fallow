export function buildFallowTranscriptContent(
	resultPrefix: string,
	summary: string,
	fullContent: string,
	hasNavigator: boolean,
): string {
	if (!hasNavigator) return fullContent;
	return `Opened Fallow issue navigator.\n${resultPrefix ? `${resultPrefix}\n` : ""}${summary}`;
}
