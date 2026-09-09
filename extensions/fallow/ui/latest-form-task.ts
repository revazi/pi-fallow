import { boundedReadinessText } from "../readiness-report";

interface Ticket { controller: AbortController; timer: ReturnType<typeof setTimeout> }

/** Bounded, cancellable work whose late completions can never update a newer form or closed overlay. */
export class LatestFormTask {
	private current?: Ticket;
	private disposed = false;
	constructor(private changed: () => void, private failed: (message: string) => void, private timeoutMs = 30_000) {}
	get pending(): boolean { return this.current !== undefined; }

	run<T>(work: (signal: AbortSignal) => Promise<T>, completed: (value: T) => void): void {
		if (this.disposed) return;
		this.cancel();
		const controller = new AbortController();
		const timer = setTimeout(() => {
			this.settle(ticket, () => this.failed("Check timed out; preview again to retry."));
			controller.abort();
		}, this.timeoutMs);
		const ticket = { controller, timer };
		this.current = ticket;
		Promise.resolve().then(() => {
			controller.signal.throwIfAborted();
			return work(controller.signal);
		}).then(
			(value) => this.settle(ticket, () => completed(value)),
			(error) => this.settle(ticket, () => this.failed(boundedReadinessText(error instanceof Error ? error.message : String(error)))),
		);
	}

	private settle(ticket: Ticket, apply: () => void): void {
		if (this.current !== ticket || this.disposed) return;
		clearTimeout(ticket.timer);
		this.current = undefined;
		apply();
		if (!this.disposed) this.changed();
	}

	cancel(): void {
		const ticket = this.current;
		this.current = undefined;
		if (!ticket) return;
		clearTimeout(ticket.timer);
		ticket.controller.abort();
	}

	dispose(): void { this.disposed = true; this.cancel(); }
}
