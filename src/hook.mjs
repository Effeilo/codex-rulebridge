#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules, renderRule, CONTEXT_PREAMBLE, validateRules, MAX_BYTES } from './rules.mjs';
import { toolTargets, matchesPath } from './paths.mjs';
import { withState, digest } from './state.mjs';

const startupGuide = 'Codex Rulebridge loads global rules now and path-scoped rules when local tools touch matching files. Use sequential calls when first entering a new scope. If a tool is suspended to load rules, review the supplied instructions and retry or revise the call. Prefer explicit file paths and small tool calls; opaque shell/scripts may load all scoped rules conservatively. Rules are guidance, not a security boundary.';
let event;
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  event = input.hook_event_name;
  if (!['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'PreToolUse', 'PostCompact', 'SessionEnd'].includes(event)) throw new Error(`Unsupported hook event: ${event}`);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const rules = ['PostCompact', 'SessionEnd'].includes(event) ? [] : loadRules(root, '.agents/rules', true);
  validateRules(rules);
  const output = await withState(root, input, state => {
    const response = { hookSpecificOutput: { hookEventName: event } };
    const specific = response.hookSpecificOutput;
    if (event === 'SessionEnd') return {};
    if (event === 'PostCompact') { state.delivered = {}; return {}; }
    if (event === 'SessionStart' || event === 'SubagentStart') {
      state.delivered = {};
      if (input.source !== 'compact' && input.source !== 'resume') state.active = [];
    }
    const targets = event === 'PreToolUse' ? toolTargets(root, input) : null;
    const selected = rules.filter(rule => !rule.paths.length || Object.hasOwn(state.delivered, rule.name) || (targets
      ? targets.opaque || rule.paths.some(glob => targets.targets.some(t => matchesPath(glob, t.path, t.directory)))
      : state.active.includes(rule.name)));
    const pending = selected.filter(rule => state.delivered[rule.name] !== digest(rule.raw));
    const present = new Set(rules.map(r => r.name));
    let removalBytes = 0;
    const removed = Object.keys(state.delivered).filter(name => !present.has(name)).filter(name => {
      removalBytes += Buffer.byteLength(name) + 2;
      return removalBytes < 1000;
    });
    const chunks = [];
    if (event === 'SessionStart' || event === 'SubagentStart') chunks.push(startupGuide);
    if (removed.length) chunks.push('The following previously loaded rules were removed. Stop applying them: ' + removed.join(', '));
    if (pending.length) chunks.push(CONTEXT_PREAMBLE);
    let size = Buffer.byteLength(chunks.join('\n\n'));
    const delivered = [];
    for (const rule of pending) {
      const context = renderRule(rule);
      if (size + Buffer.byteLength(context) + 2 > MAX_BYTES) break;
      chunks.push(context); size += Buffer.byteLength(context) + 2; delivered.push(rule);
    }
    if (pending.length && !delivered.length) throw new Error('A rule is too large for one hook context; shorten it below 22,000 bytes');
    const context = chunks.join('\n\n');
    const incomplete = delivered.length < pending.length;
    if (context) specific.additionalContext = context;
    // A PreToolUse context arrives after the model prepared its tool input.
    // Suspend that input once so the model can reconsider it with the new rules.
    if (event === 'PreToolUse' && (context || incomplete)) {
      specific.permissionDecision = 'deny';
      specific.permissionDecisionReason = 'Rulebridge loaded new or updated repository instructions. The tool has NOT run. Review the additional context, then retry or revise this call. No user approval is needed.' + (incomplete ? ' More matching rules remain and will load on the next attempt.' : '');
    }
    for (const rule of delivered) {
      state.delivered[rule.name] = digest(rule.raw);
      if (!state.active.includes(rule.name)) state.active.push(rule.name);
    }
    for (const name of removed) delete state.delivered[name];
    state.active = state.active.filter(name => present.has(name));
    return response;
  });
  process.stdout.write(JSON.stringify(output));
} catch (error) {
  const message = `codex-rulebridge: ${error.message}`;
  if (event === 'PreToolUse') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: message } }));
  } else {
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  }
}
