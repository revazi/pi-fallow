import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { fallowToolCommands } from "./registry";

const FallowCommand = StringEnum(fallowToolCommands);

const OutputDetail = StringEnum(["summary", "findings", "raw"] as const, { default: "findings" });

export const fallowRunParams = Type.Object({
	command: FallowCommand,
	args: Type.Optional(Type.Array(Type.String())),
	root: Type.Optional(Type.String()),
	timeoutSecs: Type.Optional(Type.Number()),
	detail: Type.Optional(OutputDetail),
}, { additionalProperties: false });

export type FallowRunParams = Static<typeof fallowRunParams>;
