import type { FallowNavigatorResult, FallowNavigatorReturnTarget, FallowNavigatorState } from "../types";

export type FallowNavigatorRunOnce = (
	args: string[],
	rememberLast: boolean,
	initialState?: FallowNavigatorState,
	protectedHistoryIds?: string[],
	executionEnvironment?: NodeJS.ProcessEnv,
) => Promise<FallowNavigatorResult | null | undefined>;

export async function runFallowNavigatorLoop(
	initialArgs: string[],
	enabled: boolean,
	runOnce: FallowNavigatorRunOnce,
): Promise<FallowNavigatorResult | null | undefined> {
	const initialResult = await runOnce(initialArgs, true);
	if (!enabled) return initialResult;
	return continueNavigatorLoop(initialResult, [], runOnce);
}

async function continueNavigatorLoop(
	result: FallowNavigatorResult | null | undefined,
	returnStack: FallowNavigatorReturnTarget[],
	runOnce: FallowNavigatorRunOnce,
): Promise<FallowNavigatorResult | null | undefined> {
	if (isActionResult(result)) return runAction(result, returnStack, runOnce);
	if (isForwardResult(result)) return runForward(result, returnStack, runOnce);
	if (isPromptResult(result)) return result;
	return returnToPreviousNavigator(result, returnStack, runOnce);
}

async function runAction(
	result: Extract<FallowNavigatorResult, { type: "action" }>,
	returnStack: FallowNavigatorReturnTarget[],
	runOnce: FallowNavigatorRunOnce,
): Promise<FallowNavigatorResult | null | undefined> {
	const nextStack = [...returnStack, result.returnTo];
	const actionResult = await runOnce(result.commandArgs, false, undefined, protectedHistoryIds(nextStack));
	return continueNavigatorLoop(actionResult, nextStack, runOnce);
}

async function runForward(
	result: Extract<FallowNavigatorResult, { type: "forward" }>,
	returnStack: FallowNavigatorReturnTarget[],
	runOnce: FallowNavigatorRunOnce,
): Promise<FallowNavigatorResult | null | undefined> {
	const forwarded = await runOnce(result.commandArgs, false, undefined, protectedHistoryIds(returnStack), result.executionEnvironment);
	return continueNavigatorLoop(forwarded, returnStack, runOnce);
}

async function returnToPreviousNavigator(
	result: null | undefined,
	returnStack: FallowNavigatorReturnTarget[],
	runOnce: FallowNavigatorRunOnce,
): Promise<FallowNavigatorResult | null | undefined> {
	const returnTo = returnStack.at(-1);
	if (!returnTo) return result;
	const restored = await runOnce(returnTo.commandArgs, false, returnTo.state);
	return continueNavigatorLoop(restored, returnStack.slice(0, -1), runOnce);
}

function isActionResult(
	result: FallowNavigatorResult | null | undefined,
): result is Extract<FallowNavigatorResult, { type: "action" }> {
	return result?.type === "action";
}

function isForwardResult(
	result: FallowNavigatorResult | null | undefined,
): result is Extract<FallowNavigatorResult, { type: "forward" }> {
	return result?.type === "forward";
}

function isPromptResult(
	result: FallowNavigatorResult | null | undefined,
): result is Extract<FallowNavigatorResult, { type: "prompt" }> {
	return result?.type === "prompt";
}

function protectedHistoryIds(returnStack: FallowNavigatorReturnTarget[]): string[] {
	return returnStack.flatMap((target) => historyIdsFromArgs(target.commandArgs));
}

function historyIdsFromArgs(args: string[]): string[] {
	if (args[0] !== "history") return [];
	return historyOperationIds(args);
}

function historyOperationIds(args: string[]): string[] {
	if (args[1] === "open") return args.slice(2, 3);
	return args[1] === "compare" ? args.slice(2, 4) : [];
}
