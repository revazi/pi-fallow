import { boundedReadinessText, readinessFailure, type ReadinessCheck, type ReadinessReport, type ReadinessView } from "../readiness-report";

interface PendingCheck { controller: AbortController; timer: ReturnType<typeof setTimeout> }
const PHASE_LABELS = { error: "check failed", corrupt: "corrupt/unverified", ready: "ready", missing: "missing", incompatible: "incompatible", unknown: "unknown" };

/** Per-mount read-only state, intentionally separate from the legacy setup/workflow state. */
export class ReadinessState {
	private reports = new Map<ReadinessView, ReadinessReport>();
	private pending = new Map<ReadinessView, PendingCheck>();
	private expanded = new Set<ReadinessView>();
	private disposed = false;

	constructor(private check: ReadinessCheck | undefined, private render: () => void, private timeoutMs = 30_000) {}

	enter(view: ReadinessView): void {
		if (!this.reports.has(view) && !this.pending.has(view)) this.refresh(view);
	}

	refresh(view: ReadinessView): void {
		if (this.disposed) return;
		this.cancel(view);
		this.reports.delete(view); // Never continue advertising a cached ready result while checking.
		const controller = new AbortController();
		const timer = setTimeout(() => {
			this.finish(view, pending, readinessFailure("Readiness check timed out. Press r to retry."));
			controller.abort();
		}, this.timeoutMs);
		const pending = { controller, timer };
		this.pending.set(view, pending);
		this.render();
		Promise.resolve().then(() => {
			controller.signal.throwIfAborted();
			if (!this.check) throw new Error("Readiness checker unavailable in this context. Reopen a live /fallow report to retry.");
			return this.check(view, controller.signal);
		}).then(
			(report) => this.finish(view, pending, report),
			(error) => this.finish(view, pending, readinessFailure(error)),
		);
	}

	currentReport(view: ReadinessView): ReadinessReport | undefined {
		if (this.disposed || this.pending.has(view)) return undefined;
		return this.reports.get(view);
	}

	isReady(view: ReadinessView): boolean {
		return [!this.disposed, !this.pending.has(view), this.reports.get(view)?.phase === "ready"].every(Boolean);
	}

	toggleDetails(view: ReadinessView): void {
		if (this.expanded.has(view)) this.expanded.delete(view);
		else this.expanded.add(view);
		this.render();
	}

	lines(view: ReadinessView): string[] {
		if (this.pending.has(view)) return ["Readiness: loading… (read-only, up to 30 seconds)", "You can switch views or close while this check runs."];
		const report = this.reports.get(view);
		if (!report) return ["Readiness: not checked."];
		const phase = PHASE_LABELS[report.phase];
		const lines = [`Readiness: ${phase}`, boundedReadinessText(report.summary), "", boundedReadinessText(report.next)];
		if (this.expanded.has(view)) lines.push("", ...report.details.slice(0, 12).map(boundedReadinessText));
		else lines.push("", "Press i to inspect identity, integrity, and installation location.");
		return lines;
	}

	private finish(view: ReadinessView, pending: PendingCheck, report: ReadinessReport): void {
		if (this.disposed || this.pending.get(view) !== pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(view);
		this.reports.set(view, report);
		this.render();
	}

	private cancel(view: ReadinessView): void {
		const pending = this.pending.get(view);
		this.pending.delete(view);
		if (!pending) return;
		clearTimeout(pending.timer);
		pending.controller.abort();
	}

	dispose(): void {
		this.disposed = true;
		for (const view of this.pending.keys()) this.cancel(view);
	}
}
