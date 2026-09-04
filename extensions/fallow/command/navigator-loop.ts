import type { FallowNavigatorResult, FallowNavigatorReturnTarget, FallowNavigatorState } from "../types";

export type FallowNavigatorRunOnce = (
	args: string[],
	rememberLast: boolean,
	initialState?: FallowNavigatorState,
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
	if (isPromptResult(result)) return result;
	return returnToPreviousNavigator(result, returnStack, runOnce);
}

async function runAction(
	result: Extract<FallowNavigatorResult, { type: "action" }>,
	returnStack: FallowNavigatorReturnTarget[],
	runOnce: FallowNavigatorRunOnce,
): Promise<FallowNavigatorResult | null | undefined> {
	const actionResult = await runOnce(result.commandArgs, false);
	return continueNavigatorLoop(actionResult, [...returnStack, result.returnTo], runOnce);
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

function isPromptResult(
	result: FallowNavigatorResult | null | undefined,
): result is Extract<FallowNavigatorResult, { type: "prompt" }> {
	return result?.type === "prompt";
}
