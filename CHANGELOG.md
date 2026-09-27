# Changelog

## 1.0.0 (2026-09-27)

- Organize modular Codex rules in `.agents/rules/`, with global and path-scoped Markdown conventions.
- Load global rules at startup and scoped rules before matching supported tools, suspending the first call so Codex can revise it.
- Deduplicate unchanged rules per context, refresh edits and reload relevant rules after compaction.
- Support bounded glob matching, explicit patch targets, large scoped corpora and batched delivery.
- Set up Codex alone with `init`; optionally share rules with Claude Code using `sync` or `init --claude`.
- Synchronize rule edits bidirectionally using shared hashes, report conflicts and preserve existing integrations.
- Add `check`, `explain --path`, `explain --all`, and `init --no-claude`.
- Include a Bash installer for macOS, Linux and the Linux environment in WSL, with profile backups and repeatable updates.
- Include an English illustrated demo, English/French documentation and the MIT license.
- Validate with 39 automated tests and real Codex CLI 0.157.1 smoke tests on macOS.
- Document hook coverage, conservative fallback and parallel-call limitations.
