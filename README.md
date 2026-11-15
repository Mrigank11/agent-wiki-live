# agent-wiki Live

An [Obsidian](https://obsidian.md) plugin that edits an [agent-wiki](https://github.com/Mrigank11/agent-wiki) vault **live** with other people and agents: shared cursors, agent edits as they happen, safe offline. Works on desktop and mobile.

You need an agent-wiki server (yours or a friend's). The plugin has no default server: you type the address of yours in its settings.

## Install with BRAT (phone or desktop)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins straight from GitHub, so it is the easy way onto a phone.

1. In Obsidian, open **Settings → Community plugins**, turn community plugins on, then **Browse**, search **BRAT** (Obsidian42 - BRAT), install and enable it.
2. Open **Settings → BRAT → Add Beta plugin** and paste `Mrigank11/agent-wiki-live`. Choose the latest version and press **Add Plugin**.
3. In **Settings → Community plugins**, switch **agent-wiki Live** on.
4. Open **Settings → agent-wiki Live** and sign in (see below).

BRAT also updates the plugin when a new release comes out.

> Use a **new, empty Obsidian vault**. The plugin turns it into a live copy of one agent-wiki vault.

## Install by hand

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Mrigank11/agent-wiki-live/releases/latest).
2. Put them in `<your vault>/.obsidian/plugins/agent-wiki-live/` (`.obsidian` is a hidden folder).
3. Reload Obsidian and switch **agent-wiki Live** on under **Settings → Community plugins**.

## Sign in

Open **Settings → agent-wiki Live**:

1. Type the **Server address** (for example `https://wiki.example.com`) and press **Check**. The plugin lists the sign-in methods the server offers.
2. Sign in with one of them:
   - **GitHub** (or another provider): your browser opens the provider's sign-in. When you approve, it hands you back to Obsidian through an `obsidian://` link. Allow the browser to open Obsidian.
   - **Tailscale**: signs you in without leaving Obsidian, when the server is on your tailnet and knows your account.
   - **Token**: paste a token an admin gave you. It is saved in the plugin's data file on this device, in plain text.
3. Pick the agent-wiki vault and press **Connect**. The notes download into your Obsidian vault and stay in step from then on.

An admin of the agent-wiki server adds people and vaults. See the server's documentation.

## Build

```
npm ci --legacy-peer-deps
npm run build      # main.js
npm test           # standalone tests
```

## Source and releases

This repository is published from the `plugin/` folder of agent-wiki, where the plugin is developed together with the server it talks to (its end-to-end tests need that server). Report issues here; code changes land upstream and are re-published here as a new tagged release.

Releasing: bump `version` in `manifest.json` and `package.json`, add the version to `versions.json`, then push a tag equal to the version (no `v` prefix): the **Release** workflow builds and attaches `main.js`, `manifest.json` and `styles.css`.

MIT licensed; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
