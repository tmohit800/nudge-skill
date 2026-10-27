---
name: artifacts
description: Opens the Nudge Shelf, a local page listing every artifact (claude.ai pages, typed artifacts, Claude Docs) and every Claude Code conversation on this computer, across every Claude config folder. Artifacts are labelled, searchable and editable (add, remove, rename or delete labels; pin; hide). Conversations are searchable by their full text and open in Claude Code (terminal or VS Code). Use when the user asks to see, find, search, list, label, tag or organise their artifacts, asks "where is that artifact/page I made", wants to find or reopen an old Claude conversation, or runs /nudge:artifacts.
argument-hint: "[search words] | chats <words> | label | scan"
allowed-tools: Bash(node *shelf.js*)
---

# Nudge Shelf

`scripts/shelf.js` (next to this file, at `${CLAUDE_SKILL_DIR}/scripts/shelf.js`) reads the session transcripts under every Claude config folder on this machine (`~/.claude`, any `~/.claude-*` folder, `CLAUDE_CONFIG_DIR`, and any `roots` listed in `~/.claude/nudge/config.json`). It keeps everything in `~/.claude/nudge/`:

- **Artifacts:** `artifacts.json` (the list), `labels.json` (topic labels by artifact id), `artifact-meta.json` (pinned and hidden flags), `events.json` (every publish and delete seen, so artifacts outlive transcript cleanup)
- **Conversations:** `conversations.json` (titles, projects, branches, dates) and `conversation-text.json` (the prompt and reply text used for search)
- **Page:** `shelf.html`, a read-only copy for when the server isn't running

A background hook rescans after every artifact publish or delete. A small local server on `127.0.0.1:4783` serves the live shelf. Every session start makes sure it's running (unless `"autostart": false` is in `config.json`), and `shelf.js open` starts it if needed and opens it. There are four tabs:

- **Artifacts:** label chips, project/kind filters, sort, grouping by project, pins. Each card has × to remove a label, **+ Label** to add one, **Hide**, and **Delete** (removes it from the shelf for good, with Undo; claude.ai is untouched). **Manage labels** renames or deletes a label everywhere (with Undo).
- **Conversations:** every chat newest first, with background `claude -p` runs hidden by default. Search covers the full text. A picked conversation shows its messages, the artifacts it made, and **Continue in terminal** / **Continue in VS Code** / **Copy resume command** / **Delete** buttons. Delete moves the transcript to `<claude folder>/nudge-trash`. **Trash** restores it or empties the trash for good. ☆ pins a conversation, and **Rename** gives it the user's own name (kept in `conversation-meta.json`; the transcript is untouched).
- **Repos:** the "not pushed yet" board. Each git repo and worktree the user worked in recently, with uncommitted files, stashes, and branches whose commits are on no remote. Read-only apart from **Fetch**.
- **Runbook:** saved commands (`runbook.json`) with one-click copy. The shelf never runs them.

Never delete a conversation or empty the trash on the user's behalf unless they ask for that exact thing. When the user asks "what haven't I pushed?", open the Repos tab (`shelf.js open`, then `#repos`) rather than running git yourself in every repo.

The shelf only reads local files and never calls claude.ai. Artifacts made outside Claude Code (for example on claude.ai on the web) aren't in the transcripts, so they won't appear. The page can't send messages into a conversation; carrying on happens in Claude Code itself.

Run every command with `node "${CLAUDE_SKILL_DIR}/scripts/shelf.js" <command>`. If `${CLAUDE_SKILL_DIR}` isn't filled in, use this skill's base directory.

## What to do

The user's words after the command: `$ARGUMENTS`

1. **Sync.** Run `shelf.js sync`. It rescans artifacts and conversations and prints a summary.
2. **Label new artifacts** (skip this when the user only asked to search):
   - Run `shelf.js unlabeled`. It returns `labelsInUse` (label → count) and the `unlabeled` artifacts.
   - Give each artifact 1–3 short, lowercase topic labels based on its title, description, kind and version labels, e.g. `design`, `proposal`, `aws`, `api docs`, `audit`, `figma`. Reuse a label from `labelsInUse` whenever one fits, so the filters stay short. Don't repeat the project name, because the page already shows projects as their own chips. Don't open the artifacts to decide; the metadata is enough.
   - Write the labels to a JSON file in your scratchpad, `{"<id>": ["label", "label"], ...}`, then run `shelf.js label --from <that file>`.
   - To change one artifact's labels: `shelf.js label <id or url> label1,label2`. Pass an empty string to clear them.
3. **Search** when the user gave search words:
   - For artifacts, run `shelf.js find <words>` and reply with the matches (title as a link, labels, last updated).
   - For conversations (the user asks about a chat, a session, or "when did we talk about…"), run `shelf.js chats <words>` and reply with the title, project, date and session id of each match. Include the command to pick it up: `claude --resume <id>`.
   - A match needs every word to appear.
4. **Open the shelf.** Run `shelf.js open`, or `shelf.js open <words>` to open it already searched for those words. It starts the shelf server if needed (replacing one left over from an older plugin version) and opens `http://127.0.0.1:4783/`. If the server can't start, it opens the read-only `shelf.html` instead.
5. **Reply** briefly: how many artifacts and conversations there are, how many artifacts you labelled and with which labels, the matches if the user searched, and the shelf link.

Don't publish the shelf page as an artifact unless the user asks: it lists all of their private artifacts and conversations, and the session rule below keeps each session to one artifact.

## One artifact per session

The Nudge plugin's hooks enforce this rule in every session, not only when this skill runs:

- A session publishes **one** new artifact by default. Later changes republish to that same artifact (same `file_path`, or pass its `url`) and become new versions. Give each publish a short `label` to name the version.
- A separate artifact is created only when the user explicitly asks for a new or separate one.
- If you publish a second new artifact, the hook asks the user first. That prompt is the rule working; never route around it, for example by renaming files or passing another artifact's `url`.

To turn the guard off on one machine, put `{"guard": "off"}` in `~/.claude/nudge/config.json` (or set `NUDGE_GUARD=off`).
