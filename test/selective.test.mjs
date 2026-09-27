import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchesPath, toolTargets } from '../src/paths.mjs';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rulebridge selective ')));
  execFileSync('git', ['init', '-q', root]);
  const put = (name, body) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8' });
  const session = randomUUID();
  const hook = (event, data = {}) => {
    const input = { session_id: session, cwd: root, hook_event_name: event, ...data };
    const result = spawnSync(process.execPath, [path.join(root, '.codex/rulebridge/hook.mjs')], { input: JSON.stringify(input), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput ?? {};
  };
  t.after(() => { if (fs.existsSync(path.join(root, '.codex/rulebridge/hook.mjs'))) hook('SessionEnd'); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, put, run, hook, session };
}
const scoped = (pattern, body) => `---\npaths: ["${pattern}"]\n---\n${body}\n`;

test('Codex-only init ignores Claude rules; sharing is opt-in and can be stopped without deleting copies', t => {
  const f = fixture(t);
  f.put('.claude/rules/claude.md', 'Claude only');
  assert.equal(f.run('init').status, 0);
  assert.equal(fs.existsSync(path.join(f.root, '.agents/rules/claude.md')), false);
  assert.equal(fs.existsSync(path.join(f.root, '.claude/rules/general.md')), false);
  f.put('.agents/rules/general.md', 'Codex edit');
  assert.equal(f.run('init').status, 0);
  assert.equal(f.run('check').status, 0);
  assert.equal(f.run('sync').status, 0);
  assert.equal(fs.readFileSync(path.join(f.root, '.agents/rules/claude.md'), 'utf8'), 'Claude only');
  assert.equal(f.run('init', '--no-claude').status, 0);
  f.put('.claude/rules/claude.md', 'Claude edited');
  assert.equal(f.run('init').status, 0);
  assert.equal(f.run('check').status, 0);
  assert.equal(fs.readFileSync(path.join(f.root, '.agents/rules/claude.md'), 'utf8'), 'Claude only');
});
test('fresh init creates no .claude; v2 migration preserves sharing and global runtime protection', t => {
  const f = fixture(t); assert.equal(f.run('init').status, 0);
  assert.equal(fs.existsSync(path.join(f.root, '.claude')), false);
  assert.equal(f.run('sync').status, 0);
  const mf = path.join(f.root, '.codex/rulebridge/manifest.json'); const old = JSON.parse(fs.readFileSync(mf));
  old.version = 2; delete old.claudeSync; fs.writeFileSync(mf, JSON.stringify(old));
  f.put('.claude/rules/team.md', 'Team rule');
  assert.equal(f.run('init').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(mf)).claudeSync, true);
  assert.equal(fs.readFileSync(path.join(f.root, '.agents/rules/team.md'), 'utf8'), 'Team rule');
});
test('rules load selectively, deduplicate, refresh, and reload after compaction', t => {
  const f = fixture(t);
  f.put('.agents/rules/global.md', 'GLOBAL');
  f.put('.agents/rules/ui.md', scoped('src/ui/**/*.ts', 'UI_MARKER'));
  f.put('.agents/rules/api.md', scoped('src/api/**', 'API_MARKER'));
  assert.equal(f.run('init').status, 0);
  const startup = f.hook('SessionStart').additionalContext;
  assert.match(startup, /GLOBAL/); assert.doesNotMatch(startup, /UI_MARKER|API_MARKER/);
  assert.equal(f.hook('UserPromptSubmit').additionalContext, undefined);
  const call = { tool_name: 'Bash', tool_input: { command: 'cat src/ui/view.ts' } };
  const first = f.hook('PreToolUse', call);
  assert.equal(first.permissionDecision, 'deny'); assert.match(first.additionalContext, /UI_MARKER/); assert.doesNotMatch(first.additionalContext, /API_MARKER|GLOBAL/);
  assert.equal(f.hook('PreToolUse', call).permissionDecision, undefined);
  assert.equal(f.hook('UserPromptSubmit').additionalContext, undefined);
  f.put('.agents/rules/ui.md', scoped('src/ui/**/*.ts', 'UI_UPDATED'));
  assert.match(f.hook('UserPromptSubmit').additionalContext, /UI_UPDATED/);
  f.hook('PostCompact');
  assert.match(f.hook('SessionStart', { source: 'compact' }).additionalContext, /GLOBAL[\s\S]*UI_UPDATED/);
  assert.match(f.hook('SessionStart', { source: 'resume' }).additionalContext, /GLOBAL[\s\S]*UI_UPDATED/);
  const fresh = f.hook('PreToolUse', { ...call, session_id: randomUUID() });
  assert.match(fresh.additionalContext, /UI_UPDATED/);
  fs.unlinkSync(path.join(f.root, '.agents/rules/ui.md'));
  assert.match(f.hook('UserPromptSubmit').additionalContext, /removed/);
});
test('first patch including rename loads source and destination rules before execution', t => {
  const f = fixture(t);
  f.put('.agents/rules/ui.md', scoped('src/ui/**', 'UI'));
  f.put('.agents/rules/api.md', scoped('src/api/**', 'API'));
  f.run('init'); f.hook('SessionStart');
  const out = f.hook('PreToolUse', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/ui/a.ts\n*** Move to: src/api/a.ts\n@@\n-old\n+new\n*** End Patch' } });
  assert.equal(out.permissionDecision, 'deny'); assert.match(out.additionalContext, /UI/); assert.match(out.additionalContext, /API/);
  assert.equal(fs.existsSync(path.join(f.root, 'src/api/a.ts')), false);
});
test('large independent corpus is permitted; matching context loads in bounded batches', t => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) f.put(`.agents/rules/${i}.md`, scoped(`area${i}/**`, String(i).repeat(5000)));
  assert.equal(f.run('init').status, 0);
  assert.equal(f.run('check').status, 0);
  assert.doesNotMatch(f.hook('SessionStart').additionalContext, /000000/);
  const single = f.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat area0/file.ts' } });
  assert.match(single.additionalContext, /000000/); assert.doesNotMatch(single.additionalContext, /111111/);
  let blocked = 0;
  for (let i = 0; i < 15; i++) {
    const out = f.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'python script.py' } });
    if (!out.permissionDecision) break;
    assert(Buffer.byteLength(out.additionalContext) < 24000); blocked++;
  }
  assert(blocked > 1 && blocked < 15);
});
test('structured tools, quoted paths, directories, workdir and opaque commands', t => {
  const f = fixture(t); f.put('src/ui/a b.ts', 'file'); f.put('src/api/a.ts', 'file');
  const targets = toolTargets(f.root, { cwd: f.root, tool_name: 'Bash', tool_input: { command: "cat 'a b.ts'", workdir: 'src/ui' } });
  assert.deepEqual(targets, { targets: [{ path: 'src/ui/a b.ts', directory: false }], opaque: false });
  assert.equal(toolTargets(f.root, { cwd: f.root, tool_name: 'Bash', tool_input: { command: 'cat src/ui/a.ts && python edit.py' } }).opaque, true);
  assert.equal(toolTargets(f.root, { cwd: f.root, tool_name: 'Bash', tool_input: { command: 'cat $TARGET' } }).opaque, true);
  assert.equal(toolTargets(f.root, { cwd: f.root, tool_name: 'mcp__fs__read', tool_input: { path: 'src/ui/a b.ts' } }).targets[0].path, 'src/ui/a b.ts');
  assert.equal(matchesPath('src/ui/**/*.ts', 'src/ui', true), true);
  assert.equal(matchesPath('src/ui/**/*.ts', 'src/api', true), false);
  assert.equal(matchesPath('**/*.{ts,tsx}', 'src/ui/a.tsx'), true);
  assert.equal(matchesPath('src/file[0-9]?.ts', 'src/file7x.ts'), true);
});
test('subagent contexts do not reuse parent delivery cache', t => {
  const f = fixture(t); f.put('.agents/rules/global.md', 'GLOBAL'); f.put('.agents/rules/ui.md', scoped('src/ui/**', 'UI')); f.run('init');
  f.hook('SessionStart');
  const call = { tool_name: 'Bash', tool_input: { command: 'cat src/ui/a.ts' } };
  f.hook('PreToolUse', call);
  assert.match(f.hook('SubagentStart', { agent_id: 'child' }).additionalContext, /GLOBAL/);
  assert.equal(f.hook('PreToolUse', { ...call, agent_id: 'child' }).permissionDecision, 'deny');
  assert.equal(f.hook('PreToolUse', call).permissionDecision, undefined);
});
test('invalid rule or missing identity blocks a tool, never silently permits it', t => {
  const f = fixture(t); f.run('init');
  f.put('.agents/rules/bad.md', '---\npaths: ["[broken"]\n---\nRule');
  assert.equal(f.run('check').status, 1);
  const blocked = f.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat a.ts' } });
  assert.equal(blocked.permissionDecision, 'deny');
  assert.match(blocked.permissionDecisionReason, /glob/);
  fs.unlinkSync(path.join(f.root, '.agents/rules/bad.md'));
  const missing = f.hook('PreToolUse', { session_id: '', tool_name: 'Bash', tool_input: { command: 'cat a.ts' } });
  assert.equal(missing.permissionDecision, 'deny');
  assert.match(missing.permissionDecisionReason, /session_id/);
});
test('concurrent hook processes preserve delivery state for different rules', async t => {
  const f = fixture(t); f.put('.agents/rules/a.md', scoped('a/**', 'A')); f.put('.agents/rules/b.md', scoped('b/**', 'B')); f.run('init');
  const invoke = name => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(f.root, '.codex/rulebridge/hook.mjs')]); let out = '';let err = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    child.on('error', reject); child.on('exit', code => code ? reject(new Error(err)) : resolve(JSON.parse(out)));
    child.stdin.end(JSON.stringify({ session_id: f.session, cwd: f.root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat ${name}/file.ts` } }));
  });
  const results = await Promise.all([invoke('a'), invoke('b')]);
  for (const r of results) assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(f.hook('UserPromptSubmit').additionalContext, undefined);
});

test('disabling Claude sharing preserves the baseline for a later re-enable', t => {
  const f = fixture(t); f.put('.agents/rules/team.md', 'Original');
  assert.equal(f.run('init', '--claude').status, 0);
  assert.equal(f.run('init', '--no-claude').status, 0);
  f.put('.agents/rules/team.md', 'Codex-only edit');
  assert.equal(f.run('init').status, 0);
  assert.equal(f.run('sync').status, 0);
  assert.equal(fs.readFileSync(path.join(f.root, '.claude/rules/team.md'), 'utf8'), 'Codex-only edit');
  f.run('init', '--no-claude');
  f.put('.agents/rules/team.md', 'Another Codex edit');
  f.put('.claude/rules/team.md', 'Independent Claude edit');
  f.run('init');
  const conflict = f.run('sync');
  assert.equal(conflict.status, 1); assert.match(conflict.stderr, /Conflicting/);
});

test('oversized individual or global context is rejected during setup', t => {
  const f = fixture(t);
  f.put('.agents/rules/big.md', scoped('src/**', 'x'.repeat(22000)));
  assert.equal(f.run('init').status, 1);
  assert.equal(fs.existsSync(path.join(f.root, '.codex/hooks.json')), false);
  fs.unlinkSync(path.join(f.root, '.agents/rules/big.md'));
  f.put('.agents/rules/a.md', 'a'.repeat(12000));
  f.put('.agents/rules/b.md', 'b'.repeat(12000));
  assert.equal(f.run('init').status, 1);
});

test('explain previews globals, matching scopes, or all rules without changing files', t => {
  const f = fixture(t);
  f.put('.agents/rules/global.md', 'GLOBAL_MARKER');
  f.put('.agents/rules/ui.md', scoped('src/ui/**', 'UI_MARKER'));
  f.put('.agents/rules/api.md', scoped('src/api/**', 'API_MARKER'));
  f.run('init');
  const global = f.run('explain'); assert.equal(global.status, 0);
  assert.match(global.stdout, /GLOBAL_MARKER/); assert.doesNotMatch(global.stdout, /UI_MARKER|API_MARKER/);
  const ui = f.run('explain', '--path', 'src/ui/button.ts');
  assert.equal(ui.status, 0); assert.match(ui.stdout, /GLOBAL_MARKER/); assert.match(ui.stdout, /UI_MARKER/); assert.doesNotMatch(ui.stdout, /API_MARKER/);
  assert.match(f.run('explain', '--all').stdout, /API_MARKER/);
  assert.equal(f.run('explain', '--path', '../outside').status, 1);
  assert.equal(f.run('explain', '--path', 'src/ui/button.ts', '--all').status, 1);
  assert.equal(f.run('check').status, 0);
});

test('Codex-only init does not recreate deliberately removed last rule', t => {
  const f = fixture(t); assert.equal(f.run('init').status, 0);
  fs.unlinkSync(path.join(f.root, '.agents/rules/general.md'));
  assert.equal(f.run('init').status, 0);
  assert.equal(fs.existsSync(path.join(f.root, '.agents/rules/general.md')), false);
  assert.equal(f.run('check').status, 0);
});
