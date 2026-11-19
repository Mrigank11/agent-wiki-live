import type { Shown } from "./syncStatus.ts";

/** Returning to "synced" waits for this much quiet, so typing reads as one steady "saving" and flips once when it stops. */
export const HOLD_MS = 1000;
/** Saving this long with no acknowledgement while the socket says it is up: the server is not being reached. */
export const STALL_MS = 10_000;

const UNREACHABLE: Shown = { mark: "unreachable", loud: true, sentence: "Not reaching the server. Your latest changes are kept on this device and have not been acknowledged." };

/**
 * Holds what is drawn for one note. Bad news is drawn at once; the way back to "synced" needs a quiet second; saving that
 * is not acknowledged for ten seconds becomes "not reaching the server". Time is the only thing it adds to `noteState`.
 */
export class Presenter {
	shown: Shown = { mark: "none", sentence: "", loud: false };
	private first = true;
	private savingSince: number | null = null;
	private hold: ReturnType<typeof setTimeout> | null = null;
	private stall: ReturnType<typeof setTimeout> | null = null;
	private draw: (s: Shown) => void;

	constructor(draw: (s: Shown) => void) {
		this.draw = draw;
	}

	push(next: Shown) {
		if (next.mark === "saving") {
			if (this.hold) this.clear("hold");
			if (this.savingSince === null) {
				this.savingSince = Date.now();
				this.stall = setTimeout(() => {
					this.stall = null;
					this.show(UNREACHABLE);
				}, STALL_MS);
			}
			if (this.shown.mark !== "unreachable") this.show(next);
			return;
		}
		this.clear("stall");
		this.savingSince = null;
		if (next.mark === "synced" && (this.shown.mark === "saving" || this.shown.mark === "unreachable")) {
			if (!this.hold) {
				this.hold = setTimeout(() => {
					this.hold = null;
					this.show(next);
				}, HOLD_MS);
			}
			return;
		}
		this.clear("hold");
		this.show(next);
	}

	private clear(which: "hold" | "stall") {
		const t = this[which];
		if (t) clearTimeout(t);
		this[which] = null;
	}

	private show(s: Shown) {
		const same = !this.first && s.mark === this.shown.mark && s.sentence === this.shown.sentence;
		this.first = false;
		if (same) return;
		this.shown = s;
		this.draw(s);
	}

	dispose() {
		this.clear("hold");
		this.clear("stall");
	}
}
