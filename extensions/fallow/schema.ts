import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const FallowCommand = StringEnum([
	"all",
	"dead-code",
	"check-changed",
	"dupes",
	"health",
	"audit",
	"fix-preview",
	"fix-apply",
	"flags",
	"inspect",
	"trace-symbol",
	"security",
	"workspaces",
	"config",
	"schema",
	"decision-surface",
	"impact",
	"project-info",
	"list-boundaries",
	"explain",
	"trace-export",
	"trace-file",
	"trace-dependency",
	"trace-clone",
	"coverage-analyze",
] as const);

const OutputDetail = StringEnum(["summary", "findings", "raw"] as const);

export const fallowRunParams = Type.Object({
	command: FallowCommand,
	args: Type.Optional(Type.Array(Type.String())),
	root: Type.Optional(Type.String()),
	timeoutSecs: Type.Optional(Type.Number()),
	detail: Type.Optional(OutputDetail),
}, { additionalProperties: false });

export type FallowRunParams = Static<typeof fallowRunParams>;
