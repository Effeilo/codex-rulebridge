# Codex Rulebridge

This repository contains a Node.js CLI, not a frontend application.

- Use Node.js built-ins; the runtime has no external dependencies.
- Keep changes to consuming repositories explicit and non-destructive.
- Never overwrite unrelated hooks, AGENTS.md or CLAUDE.md. Propagate rule edits only when shared history identifies the unchanged side; report divergent edits as conflicts.
- Document differences between Codex context injection and Claude's native loading.
- Test the real CLI and generated hooks with temporary repositories.
- Run `npm run check`, `npm test` and `npm pack --dry-run` before delivering changes.
- Do not claim real-agent compatibility based only on simulated hook payloads.
