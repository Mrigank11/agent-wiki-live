/**
 * A note's text boiled down to 16 bytes (the first half of its SHA-256, in base64). The server publishes one per note in the
 * index; a device that compares them with the text it saved knows, without opening the note, that the server has the same text.
 * Must give exactly what live-server's `fingerprint` gives.
 */
export async function fingerprint(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return btoa(String.fromCharCode(...digest.subarray(0, 16)));
}
