# Claude Settings Manager

Local web dashboard to view, diff, and consolidate Claude Code settings across scopes:

- `~/.claude/settings.json` (user / global)
- `<repo>/.claude/settings.json` (project / shared)
- `<repo>/.claude/settings.local.json` (project / local, gitignored)
- `~/.claude.json` and `<repo>/.mcp.json` (MCP server configs)

## Features

- **Files** — list every settings file on your machine with parse status, sizes, and allow/deny/ask counts.
- **Permissions** — every unique rule, which files define it, duplicate detection, filter by substring.
- **Promote / move** — one click to pull a rule from project locals up to the global file (or move between arbitrary files). Always writes a timestamped `.bak` first.
- **MCP Servers** — aggregated view across `~/.claude.json`, per-project `.mcp.json`, plus `enabled/disabled` flags from settings files.

## Install

```bash
./install.sh
source ~/.zshrc
```

This adds a `claude-settings` shell function to `~/.zshrc`. Re-running the installer is idempotent.

## Usage

```bash
claude-settings                    # listens on 127.0.0.1:7823 and opens your browser
claude-settings --no-open          # don't auto-open
claude-settings --port=9000        # different port
```

Change scan roots (directories searched for `.claude/` folders, default `~/projects`):

```bash
CLAUDE_SETTINGS_ROOTS="$HOME/projects:$HOME/work" claude-settings
CLAUDE_SETTINGS_DEPTH=4 claude-settings
```

## Safety

- Server binds to `127.0.0.1` only.
- Writes are only permitted inside `~/.claude/`, `~/.claude.json`, and settings files under your configured scan roots.
- Every write creates a `*.bak.<timestamp>` next to the original file first.

## Zero deps

No `npm install` needed. Uses only Node's built-in modules. Requires Node ≥ 18.
