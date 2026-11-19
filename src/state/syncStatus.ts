import type { Conn } from "./connection.ts";

/**
 * What the engine knows about one note, as plain facts. `noteState` is the only place that turns them into a mark, so no
 * screen works a state out on its own.
 */
export type Facts = {
	/** The server lists this note. */
	listed: boolean;
	/** This device has the note open for sync (or holds it exactly as the server does). */
	attached: boolean;
	/** Our changes the server has not acknowledged. */
	unacked: number;
	/** A rename the server has not accepted yet. */
	moving: boolean;
	/** The live text is not on disk yet. */
	fileBehind: boolean;
	/** A conflict copy of this note exists, or this note is one. */
	conflict: boolean;
};

export type Mark = "none" | "conflict" | "offline" | "opening" | "unreachable" | "saving" | "synced";
export type Shown = { mark: Mark; sentence: string; /** Draws in the warning colour: only a conflict, or the server not being reached. */ loud: boolean };

const KEPT = " Your edits are kept on this device and sync when the server is back.";

/** The mark for a note: the first row that is true wins (see docs/plans/2026-11-18-sync-indicator.md). */
export function noteState(conn: Conn, facts: Facts | null): Shown {
	const quiet = (mark: Mark, sentence: string): Shown => ({ mark, sentence, loud: false });
	if (!facts || conn.kind === "setup" || conn.kind === "idle") return quiet("none", "");
	if (facts.conflict) return { mark: "conflict", loud: true, sentence: "A conflict copy of this note exists. Both versions are kept; nothing was lost." };
	if (!(conn.kind === "live" && conn.socket === "up")) {
		const kept = facts.unacked > 0 || facts.moving || facts.fileBehind;
		const why = conn.kind === "signed_out" ? "Signed out." : conn.kind === "stopped" ? "Sync is stopped." : "Offline.";
		return quiet("offline", kept ? why + KEPT : `${why} Not syncing right now.`);
	}
	if (!facts.attached) return quiet("opening", "Opening: this note is not attached to the server yet.");
	if (facts.unacked > 0 || facts.moving || facts.fileBehind) return quiet("saving", "Saving: your latest changes are on their way to the server.");
	return quiet("synced", "Synced with the server.");
}

export type Summary = { waiting: number; conflicts: number };

/** The status bar's extra words after the connection: counts only when they are not zero. Waiting is news only when the connection is not healthy. */
export function barExtras(conn: Conn, sum: Summary): string {
	if (conn.kind === "setup" || conn.kind === "idle") return "";
	const healthy = conn.kind === "live" && conn.socket === "up";
	const parts: string[] = [];
	if (sum.waiting > 0 && !healthy) parts.push(`${sum.waiting} waiting`);
	if (sum.conflicts > 0) parts.push(`${sum.conflicts} ${sum.conflicts === 1 ? "conflict" : "conflicts"}`);
	return parts.map((p) => ` · ${p}`).join("");
}
