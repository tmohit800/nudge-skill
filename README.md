# Nudge for Claude Code

A Claude Code plugin with two parts:

1. **Nudge Shelf** (`/nudge:artifacts`): a local page with four tabs.
   - **Artifacts:** every artifact your Claude Code sessions have published (claude.ai pages, typed artifacts, Claude Docs), labelled by topic. Search them, filter by label, project or kind, pin the ones you use, and add, remove, rename or delete labels.
   - **Conversations:** every Claude Code conversation from every Claude folder on your computer. Search their full text, pin and rename them, read one, and continue it in a terminal or in VS Code with one click.
   - **Repos:** the "not pushed yet" board. Every git repo and worktree you've worked in, with uncommitted files, stashes, and branches whose commits are on no remote.
   - **Runbook:** the commands you keep looking up, one click to copy.
2. **One artifact per session**: every session is told to keep its work in one artifact and publish each change as a new version. If Claude tries to create a second new artifact, you're asked first. Say yes only when you asked for a separate one.

Needs Node.js 18 or later on your PATH, which Claude Code already requires.

## Install (once)

In a Claude Code session:

```
/plugin marketplace add tmohit800/nudge-skill
/plugin install nudge@nudge
```

Then turn on automatic updates: run `/plugin`, open **Marketplaces**, pick **nudge**, and choose **Enable auto-update**. Restart Claude Code so the hooks load.

From then on, Claude Code checks for a new version each time it starts and installs it in the background. You get every change pushed to the repo without doing anything.

The repo is public, so you don't need GitHub access. If you have no GitHub SSH key and an install or update fails, set the environment variable `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` and try again.

## Or run it without the plugin

You can also run the shelf on its own, without Claude Code's plugin system. You get the same four tabs over your own Claude Code data. Pick one:

- **Download:** on GitHub, **Code → Download ZIP**, unzip it anywhere, and double-click **Nudge Shelf.cmd** (Windows). On macOS or Linux, run `node plugins/nudge/skills/artifacts/scripts/shelf.js start` in the unzipped folder.
- **One command** (needs git): `npx github:tmohit800/nudge-skill start`

It opens `http://127.0.0.1:4783/` in your browser. Keep its window open while you use it; Ctrl+C or closing the window stops it. It rescans every minute, so new artifacts and conversations show up on their own. To update, download it again (or rerun the `npx` command).

What you don't get without the plugin: the `/nudge:artifacts` command (so no automatic topic labels; add labels on the page yourself) and the one-artifact-per-session rule.

## Use

| You type | What happens |
|---|---|
| `/nudge:artifacts` | Syncs, labels new artifacts and opens the shelf |
| `/nudge:artifacts figma audit` | Also lists the artifacts matching every word, and opens the shelf already searched for them |
| "find the conversation where we fixed the login bug" | Claude searches your conversations and gives you the `claude --resume` command |
| "find the AWS cost page I made" | Claude uses the skill on its own |
| "label the facilities pages as design" | Claude changes those labels |

The shelf lives at `http://127.0.0.1:4783/`, so you can bookmark it. A small local server that only this computer can reach runs it, and every Claude Code session start makes sure it's running. To stop it starting on its own, put `"autostart": false` in `~/.claude/nudge/config.json`. Press `/` to search the tab you're on, or switch the toggle next to the search box to **All** to search every tab at once.

**Artifacts tab**
- Click a label chip to filter, or use the project, kind, sort and grouping menus.
- On a card: × removes a label, **+ Label** adds one (separate several with commas), ☆ pins it to the top, **Conversation** opens the chat that made it, **Hide** moves it to the hidden list, and **Delete** removes it from the shelf for good (with Undo). Neither touches claude.ai; to delete an artifact there, ask Claude in a session.
- **Manage labels** renames a label (edit it and press Enter) or deletes it from every artifact. Every change can be undone from the message at the bottom.

**Conversations tab**
- Newest first. Background `claude -p` runs are hidden unless you tick **Show automated runs**. Search looks inside your prompts and Claude's replies.
- Pick a conversation to read it and see the artifacts it made.
- **Continue in terminal** opens a new terminal window running `claude --resume`. **Continue in VS Code** opens the project folder and the conversation in a Claude Code tab. **Copy resume command** gives you the command to paste yourself.
- You carry on in Claude Code itself; the shelf doesn't send messages for you.
- **Delete** moves a conversation's transcript to the trash (`<claude folder>/nudge-trash`), with Undo. A conversation active in the last 2 minutes can't be deleted. **Trash** lists what's there: **Restore** puts one back so it can be resumed again, and **Empty trash** deletes everything in it for good.

- ☆ pins a conversation to the top. **Rename** gives it your own name, which search also finds. "Use that name" brings back the one Claude Code gave it. Names and pins live in `~/.claude/nudge/conversation-meta.json`; the transcript isn't changed.

**Repos tab**
- Finds the git repos (and their worktrees) that your conversations from the last 90 days ran in. Add others under `"repos"` in `~/.claude/nudge/config.json`, and hide some with `"ignoreRepos"`.
- Per repo: current branch, uncommitted changes, stashes, and every local branch with commits that are on no remote. It flags branches whose remote branch was deleted and ones never pushed.
- Read-only. **Fetch** updates what it knows about the remote and changes none of your branches or files. **Open in VS Code**, **Open terminal** and **Copy path** do what they say. There's no commit or push button on purpose.

**Runbook tab**
- **Add command**: a title, the command, optional notes and a group. Click a command (or **Copy**) to copy it; the shelf counts how often you use each one and never runs anything. ☆ pins, **Edit** changes it, **Delete** removes it (with Undo).
- Don't save passwords or tokens in it. It's a plain file, `~/.claude/nudge/runbook.json`.

**Sync** at the top rescans everything. You rarely need it: a background hook rescans after every publish or delete, and the page refreshes when you come back to its tab. The page remembers your theme, sort and grouping. To use another port, set `"port"` in `~/.claude/nudge/config.json`.

You can also run the script yourself:

```
node <plugin>/skills/artifacts/scripts/shelf.js sync | find <words> | chats <words> | open [words] | label <id> a,b
```

## Updates

With auto-update on (see Install), updates arrive on their own when Claude Code starts. Without it, run `/plugin marketplace update nudge`, then `/plugin` → update **nudge**, and restart. The next `/nudge:artifacts` replaces a shelf server that's still running from the old copy.

Maintainers: `plugin.json` deliberately has no `version`, so installs follow the commits on `master` and every push reaches everyone with auto-update on. Don't add a `version` field. If you do, installs stop updating until that version string changes.

## What it reads and writes

- **Reads** the session transcripts in `~/.claude/projects`, plus any `~/.claude-*` folders, `CLAUDE_CONFIG_DIR`, and any `"roots"` you list in `~/.claude/nudge/config.json`.
- **Writes** to `~/.claude/nudge/`:
  - `artifacts.json`, `events.json`, `scan-index.json`: the artifact list and what was already read
  - `labels.json`, `artifact-meta.json`: your labels, pins and hidden flags
  - `conversations.json`, `conversation-text.json`: the conversation list and its search text
  - `shelf.html`: a read-only copy of the page
  - `server.json`: the running shelf server
  - `guard-state.json`: what each session published
- Nothing leaves your machine, and it never calls claude.ai. Artifacts you made outside Claude Code, such as on claude.ai on the web, don't show up because there's no local transcript for them.
- The conversation index holds the text of your chats, so treat `~/.claude/nudge` like `~/.claude/projects`: don't share it.
- Artifact links stay private. Someone else can open one only if its owner shared it.

## Turn the one-artifact rule off

Put `{"guard": "off"}` in `~/.claude/nudge/config.json`, or set the environment variable `NUDGE_GUARD=off`. To remove everything, run `/plugin uninstall nudge@nudge` and delete `~/.claude/nudge`.

## Layout

```
.claude-plugin/marketplace.json        marketplace entry ("nudge")
package.json, Nudge Shelf.cmd          the standalone app (npx / double-click): shelf.js start
plugins/nudge/
  .claude-plugin/plugin.json
  hooks/hooks.json                     SessionStart / PreToolUse / PostToolUse(+Failure) -> guard.js; PostToolUse -> shelf.js hook
  skills/artifacts/SKILL.md            the /nudge:artifacts skill
  skills/artifacts/scripts/
    shelf.js                           command line: start, sync, label, find, chats, open, serve, hook
    server.js                          the local shelf server and its API
    artifacts.js                       finds artifacts; labels, pins, hidden
    conversations.js                   indexes, searches, opens, pins, renames and deletes conversations
    repos.js                           the "not pushed yet" board (read-only git)
    runbook.js                         saved commands
    app.html                           the shelf page
    guard.js                           one-artifact-per-session hook
    common.js                          shared helpers
```
