# Third-party notices

agent-wiki Live is MIT licensed (see LICENSE). It is built on these open-source packages; each keeps its own licence, shipped in its package.

| Package | Licence | Used for |
|---|---|---|
| yjs, lib0, y-protocols, y-codemirror.next | MIT (Kevin Jahns) | shared text, presence, editor binding |
| @hocuspocus/provider | MIT (Tiptap GmbH) | network client for the sync server |
| isomorphic.js, @lifeomic/attempt, @hocuspocus/common | MIT | small helpers of the packages above |
| @codemirror/state, @codemirror/view (and crelt, style-mod, w3c-keyname, @marijn/find-cluster-break) | MIT (Marijn Haverbeke and others) | editor types (Obsidian supplies the real ones at run time) |
| fast-diff | Apache-2.0 (Jason Chen) | smallest character edits between two texts |
| obsidian (types only, dev) | MIT | typings |
| esbuild, typescript, @types/* (dev) | MIT / Apache-2.0 | build only, not shipped |

The merge in `src/engine/merge.ts` is original code.
