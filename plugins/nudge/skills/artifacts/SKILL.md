---
name: artifacts
description: List, label and search every artifact (claude.ai pages, typed artifacts, Claude Docs) that this machine's Claude Code sessions have published, and open them on a local, searchable Artifact Shelf page with System/Light/Dark themes. Use when the user asks to see, find, search, list, label, tag or organise their artifacts, asks "where is that artifact/page I made", or runs /nudge:artifacts.
argument-hint: "[search words] | label | scan"
allowed-tools: Bash(node *shelf.js*)
---

# Artifact Shelf

`scripts/shelf.js` (next to this file, at `${CLAUDE_SKILL_DIR}/scripts/shelf.js`) reads the session transcripts under every Claude config folder on this machine (`~/.claude`, any `~/.claude-*` folder, `CLAUDE_CONFIG_DIR`) and finds each artifact publish and delete. It writes:

- `~/.claude/nudge/artifacts.json`: the artifact list (title, link, description, kind, projects, versions, dates)
- `~/.claude/nudge/labels.json`: topic labels, keyed by artifact id
- `~/.claude/nudge/shelf.html`: the shelf page, with search, label/project/kind filters, sort and a theme switch

It only reads local files and never calls claude.ai. Artifacts made outside Claude Code (for example on claude.ai on the web) aren't in the transcripts, so they won't appear.

Run every command with `node "${CLAUDE_SKILL_DIR}/scripts/shelf.js" <command>`. If `${CLAUDE_SKILL_DIR}` isn't filled in, use this skill's base directory.

## What to do

The user's words after the command: `$ARGUMENTS`

1. **Scan.** Run `shelf.js scan`. It prints how many artifacts it found and how many have no topic labels.
2. **Label new artifacts** (skip this when the user only asked to search):
   - Run `shelf.js unlabeled`. It returns `labelsInUse` (label → count) and the `unlabeled` artifacts.
   - Give each artifact 1–3 short, lowercase topic labels based on its title, description, kind and version labels, e.g. `design`, `proposal`, `aws`, `api docs`, `audit`, `figma`. Reuse a label from `labelsInUse` whenever one fits, so the filters stay short. Don't repeat the project name, because the page already shows projects as their own chips. Don't open the artifacts to decide; the metadata is enough.
   - Write the labels to a JSON file in your scratchpad, `{"<id>": ["label", "label"], ...}`, then run `shelf.js label --from <that file>`.
   - To change one artifact's labels: `shelf.js label <id or url> label1,label2`. Pass an empty string to clear them.
3. **Search** when the user gave search words: run `shelf.js find <words>` and reply with the matches (title as a link, labels, last updated). A match needs every word to appear in the title, description, labels, project, kind or link.
4. **Open the shelf.** Run `shelf.js open` (or `shelf.js open <words>` to open it already searched for those words). It opens the page in the default browser.
5. **Reply** briefly: how many artifacts there are, how many you labelled and with which labels, the matches if the user searched, and the path to `shelf.html`.

Don't publish the shelf page as an artifact unless the user asks: it lists all of their private artifacts, and the session rule below keeps each session to one artifact.

## One artifact per session

The Nudge plugin's hooks enforce this rule in every session, not only when this skill runs:

- A session publishes **one** new artifact by default. Later changes republish to that same artifact (same `file_path`, or pass its `url`) and become new versions. Give each publish a short `label` to name the version.
- A separate artifact is created only when the user explicitly asks for a new or separate one.
- If you publish a second new artifact, the hook asks the user first. That prompt is the rule working; never route around it, for example by renaming files or passing another artifact's `url`.

To turn the guard off on one machine, put `{"guard": "off"}` in `~/.claude/nudge/config.json` (or set `NUDGE_GUARD=off`).
