# Nudge for Claude Code

A Claude Code plugin with two parts:

1. **Artifact Shelf** (`/nudge:artifacts`): finds every artifact your Claude Code sessions have published (claude.ai pages, typed artifacts, Claude Docs), labels them by topic, and opens a local page where you can search, filter by label, project or kind, and switch between System, Light and Dark themes.
2. **One artifact per session**: every session is told to keep its work in one artifact and publish each change as a new version. If Claude tries to create a second new artifact, you're asked first. Say yes only when you asked for a separate one.

Needs Node.js 18 or later on your PATH, which Claude Code already requires.

## Install

From a git repo (recommended, so updates reach everyone):

```
/plugin marketplace add <org>/<repo>
/plugin install nudge@nudge
```

From a folder someone shared with you (a zip or a network drive):

```
/plugin marketplace add C:/path/to/team-plugin
/plugin install nudge@nudge
```

Restart Claude Code after installing so the hooks load.

## Use

| You type | What happens |
|---|---|
| `/nudge:artifacts` | Scans, labels new artifacts and opens the shelf |
| `/nudge:artifacts figma audit` | Also lists the artifacts matching every word, and opens the shelf already searched for them |
| "find the AWS cost page I made" | Claude uses the skill on its own |
| "label the facilities pages as design" | Claude changes those labels |

On the shelf page, press `/` to search and click a label or `@project` chip to filter. *Copy link* copies the claude.ai link. The page remembers your theme and sort order.

You can also run the script yourself:

```
node <plugin>/skills/artifacts/scripts/shelf.js scan | find <words> | open [words] | label <id> a,b
```

## What it reads and writes

- **Reads** the session transcripts in `~/.claude/projects`, plus any `~/.claude-*` folders and `CLAUDE_CONFIG_DIR`. It only looks at artifact publish and delete calls.
- **Writes** to `~/.claude/nudge/`: `artifacts.json` (the list), `labels.json` (your labels), `shelf.html` (the page) and `guard-state.json` (what each session published).
- Nothing leaves your machine, and it never calls claude.ai. Artifacts you made outside Claude Code, such as on claude.ai on the web, don't show up because there's no local transcript for them.
- Artifact links stay private. Someone else can open one only if its owner shared it.

## Turn the one-artifact rule off

Put `{"guard": "off"}` in `~/.claude/nudge/config.json`, or set the environment variable `NUDGE_GUARD=off`. To remove everything, run `/plugin uninstall nudge@nudge` and delete `~/.claude/nudge`.

## Layout

```
.claude-plugin/marketplace.json        marketplace entry ("nudge")
plugins/nudge/
  .claude-plugin/plugin.json
  hooks/hooks.json                     SessionStart / PreToolUse / PostToolUse(+Failure) -> guard.js
  skills/artifacts/SKILL.md            the /nudge:artifacts skill
  skills/artifacts/scripts/
    shelf.js                           scan, label, find, open
    shelf-template.html                the shelf page
    guard.js                           one-artifact-per-session hook
    common.js                          shared helpers
```
