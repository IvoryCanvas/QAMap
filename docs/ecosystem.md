# Agent Ecosystem Coverage

AI coding agents now read repository instructions, connect to MCP servers, run tool hooks, and prepare pull requests. QAMap tracks the repository files that shape those behaviors without executing project code.

## Instruction Surfaces

QAMap treats these files as agent instruction surfaces:

| Ecosystem | Files |
| --- | --- |
| Shared / Codex-style | `AGENTS.md`, `AGENTS.override.md` |
| Claude Code | `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md` |
| Cursor | `.cursorrules`, `.cursor/rules/*.md`, `.cursor/rules/*.mdc` |
| GitHub Copilot | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` |
| Gemini CLI | `GEMINI.md` |

These files are scanned for missing guidance, conflicting guidance, and suspicious instruction text.

## Tool And Settings Surfaces

QAMap statically inspects committed MCP and agent settings files:

| Surface | Files | Checks |
| --- | --- | --- |
| MCP config | `.mcp.json`, `mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `claude_desktop_config.json` | unreadable JSON, risky commands, committed secret-like env values |
| Agent settings | `.claude/settings.json`, `.claude/settings.local.json`, `.gemini/settings.json` | MCP servers, risky hooks, broad shell permissions |

The scanner does not run MCP servers, hooks, package scripts, or project code.

## Source Signals

These references guide the current coverage:

- [OpenAI Codex AGENTS.md](https://developers.openai.com/codex/cloud/agents-md/) and the community [AGENTS.md](https://agents.md/) convention.
- [Claude Code memory](https://docs.anthropic.com/en/docs/claude-code/memory), [settings](https://docs.anthropic.com/en/docs/claude-code/settings), and [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks).
- [GitHub Copilot custom instructions](https://docs.github.com/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot).
- [Cursor rules](https://cursor.com/docs/rules) and [Cursor MCP](https://cursor.com/docs/mcp).
- [Gemini CLI configuration](https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html) and [Gemini MCP servers](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html).
- [Model Context Protocol security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices).

QAMap should keep this list practical rather than exhaustive: add a surface when it is common enough that maintainers would reasonably expect a repo preflight check to notice it.
