# Live Codex validation

Date: 2026-09-27. Environment: macOS, Codex CLI 0.157.1, interactive
session reporting GPT-6-Astra low. This is a local smoke test, not a complete
compatibility matrix.

## Early prototype: passed interactive CLI

1. Created a temporary Git repository with one `.claude/rules/probe.md` rule.
   The rule required an exact random marker in response to an integration probe.
2. Ran the real Rulebridge `init` command to copy the rule and install hooks.
3. Started `codex --no-alt-screen --no-daemon -C <temporary-repository>`.
   Codex discovered three hooks and displayed its normal review prompt.
   Reviewed the generated local commands and selected trust all.
4. Asked for the probe without including its expected marker, explicitly asking
   Codex not to use tools or read files. Codex returned exactly
   `RB_5fc8c08db87381e8e5f6037e`, matching the rule.
5. Changed the marker in `.agents/rules/probe.md` during that same session.
   Repeated the probe without including the new marker. Codex returned exactly
   `RB_110741007a9c7054d88aea95`, matching the updated rule.

Temporary instrumentation recorded `SessionStart` and `UserPromptSubmit`.
The instrumentation was removed before the second probe, which used the
unmodified distributed hook. No model tool calls were observed in either probe.
A temporary project config explicitly enabling hooks was present at startup
and removed before the second probe. Hook trust was granted through the CLI;
the interactive test did not use the hook-trust bypass flag.

## Early prototype: passed non-interactive exec; initial harness issue resolved

A controlled comparison on the same repository isolated two test setup problems:

| Invocation | Result |
| --- | --- |
| Physical path `/private/tmp/...`, normal user config | Exact rule marker received |
| Symlink path `/tmp/...`, normal user config | Rule marker not received |
| Physical path with `--ephemeral`, normal user config | Exact rule marker received |
| Physical path with `--ignore-user-config` | Rule marker not received |

The successful runs used `codex exec -s read-only -C <physical-path>` and persisted
hook trust granted in the interactive test, without a hook-trust bypass. Temporary
instrumentation confirmed both `SessionStart` and `UserPromptSubmit` ran.

For the final confirmation, restored the original distributed hook, changed the
random marker again, and ran `codex exec --ephemeral` with the physical path and
normal config. The exact new marker was returned without any model tool calls.
Neither the expected marker nor the rule contents were included in the prompt.

The earlier conclusion that exec was unsupported was incorrect. The initial
harness combined an aliased temporary path and/or ignored user configuration.
The brief suspicion about `--ephemeral` was also disproved by the controlled test.
This establishes a working invocation on this version; it does not establish
Codex's internal cause for treating these configurations differently.

Recommended command, after reviewing/trusting the project and hooks, from inside
the repository:

```sh
codex exec --cd "$(pwd -P)" "Your task"
```

Keep user configuration enabled. No Rulebridge runtime change is required.

## Not covered

- Real subagent startup, compaction, session resume, or worktree hook delivery.
- Claude Code's native rule loading and path matching.
- Linux, WSL, desktop integration, or other Codex versions.

Reference: [official OpenAI hook documentation](https://learn.chatgpt.com/docs/hooks).

## Version 1.0.0: selective loading

Date: 2026-09-27. macOS, Codex CLI 0.157.1. Two `codex exec --ephemeral`
smoke tests ran against a disposable Git repository initialized with the new
Codex-only default. No `.claude/` directory was created.

The fixture contained a global instruction, a `src/ui/**` rule requiring a
random first-line comment in edited files, and an unrelated `src/api/**` rule
with a different random marker. Neither marker appeared in the user prompts.

### Read, load, then edit

A temporary wrapper recorded the generated runtime's hook input and output:

| Event | Observed result |
| --- | --- |
| `SessionStart` | Global instructions only; neither scoped marker present |
| `UserPromptSubmit` | No duplicate context |
| First `Bash` with `cat src/ui/value.ts` | UI rule delivered, API rule absent, `permissionDecision: deny` |
| Retried identical `Bash` call | No duplicate context or denial |
| `apply_patch` | Updated value and included the exact UI marker in the first-line comment |
| `SessionEnd` | Completed successfully |

The edited file contained `export const value = 2;` and the required comment.
The wrapper only logged the input/output and forwarded them unchanged. It lived
in the disposable repository, not in the distributed runtime.

### Direct edit without reading first

Restored the uninstrumented generated integration and reset the fixture file.
In a fresh session, asked Codex to change the value directly with `apply_patch`
as its first tool call, without reading files or rules first. The first completed
tool operation was a file change; the final file exported `3` and included the
same required random comment. There were no completed read commands.

This verifies the resulting edit follows a previously unseen scoped rule. The
unmodified CLI JSON event stream did not expose the denied initial attempt,
so that stream alone does not establish the exact number of hook invocations.

### Test authorization and limits

These automated runs used the physical repository path, normal user config,
`-s workspace-write`, a per-invocation trusted-project setting and
`--dangerously-bypass-hook-trust` for the generated local hooks reviewed for this
test. They did not disable the sandbox or change the user's persisted trust
settings. This differs from the early prototype interactive trust test above and does not
validate the new six-hook review UI.

Automated integration tests additionally cover matching, large scoped corpora,
batched delivery, simulated compaction/resume events, subagent identities,
concurrent cache updates and opt-in Claude sharing. These are simulated hook
payloads, not live validation of those Codex lifecycle events. Native Claude
matching, parallel model actions, Linux/WSL and the desktop client remain untested.
