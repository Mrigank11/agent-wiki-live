#!/usr/bin/env bash
# Download a pinned Obsidian AppImage and unpack it (no FUSE needed). Prints the unpacked directory.
#   plugin/scripts/fetch-obsidian.sh            -> $XDG_CACHE_HOME/agent-wiki/obsidian-<ver>/squashfs-root
set -euo pipefail
VER="${OBSIDIAN_VERSION:-1.12.7}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/agent-wiki/obsidian-$VER"
if [ ! -x "$CACHE/squashfs-root/obsidian" ]; then
	mkdir -p "$CACHE"
	if [ ! -f "$CACHE/Obsidian.AppImage" ]; then
		curl -fsSL -o "$CACHE/Obsidian.AppImage.part" "https://github.com/obsidianmd/obsidian-releases/releases/download/v$VER/Obsidian-$VER.AppImage"
		mv "$CACHE/Obsidian.AppImage.part" "$CACHE/Obsidian.AppImage"
	fi
	chmod +x "$CACHE/Obsidian.AppImage"
	(cd "$CACHE" && ./Obsidian.AppImage --appimage-extract >/dev/null)
fi
echo "$CACHE/squashfs-root"
