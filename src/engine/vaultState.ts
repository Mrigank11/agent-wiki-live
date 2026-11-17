import type { NoteRecord, StatePort } from "./types.ts";

/** The plugin's saved data, as far as the notes it remembers are concerned. */
export type NotesData = { vault: string; notesVault?: string; notes: Record<string, NoteRecord> };

/**
 * What the plugin remembers about notes belongs to one vault. Pointing the plugin at another vault
 * must not carry those memories over: the engine would take the old vault's files on disk for new
 * files and upload them into the new vault. Data saved before this existed carries no vault name;
 * it belongs to the vault the plugin is set to.
 */
export function vaultState(data: NotesData, persist: () => void): StatePort {
	return {
		load: () => {
			if (!data.notesVault && Object.keys(data.notes).length) data.notesVault = data.vault;
			return data.notesVault === data.vault ? data.notes : {};
		},
		save: (n) => {
			data.notes = n;
			data.notesVault = data.vault;
			persist();
		},
	};
}
