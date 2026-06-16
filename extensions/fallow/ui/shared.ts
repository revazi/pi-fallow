import { ansi, fallowPurple } from "../colors";
import type { FallowOverview } from "../types";

export const purple = fallowPurple;
export const violet = (text: string) => ansi(99, text);
export const pink = (text: string) => ansi(213, text);
export const cyan = (text: string) => ansi(81, text);
export const amber = (text: string) => ansi(215, text);

export function pill(text: string, color: (value: string) => string): string {
	return color(` ${text} `);
}

export function getOverviewStatusColor(status: FallowOverview["status"]): "success" | "error" | "warning" {
	if (status === "success") return "success";
	if (status === "error") return "error";
	return "warning";
}
