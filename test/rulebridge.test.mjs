import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseRule, loadRules, renderContext } from '../src/rules.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rulebridge space '));
  execFileSync('git', ['init', '-q', root]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(root, action, success = true) {
  const result = spawnSync(process.execPath, [cli, action, ...(action === 'init' ? ['--claude'] : []), '--root', root], { encoding: 'utf8' });
  assert.equal(result.status, success ? 0 : 1, result.stderr);
  return result;
}
function put(root, name, body) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
function hook(root, event) {
  const config = JSON.parse(fs.readFileSync(path.join(root, '.codex/hooks.json')));
  const handler = config.hooks[event].at(-1).hooks[0];
  const cwd = path.join(root, 'nested');
  fs.mkdirSync(cwd, { recursive: true });
  const result = spawnSync('/bin/sh', ['-c', handler.command], {
    cwd, encoding: 'utf8', input: JSON.stringify({ hook_event_name: event, cwd, session_id: 'test-' + event }),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).hookSpecificOutput;
}

test('init, sync and check are idempotent; hook works from subdirectory with spaces', t => {
  const root = fixture(t);
  run(root, 'init');
  run(root, 'check');
  const before = fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8');
  run(root, 'sync');
  assert.equal(fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8'), before);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'SubagentStart']) {
    const output = hook(root, event);
    assert.equal(output.hookEventName, event);
    assert.match(output.additionalContext, /Shared conventions/);
  }
});

test('scoped rules are copied byte-for-byte but omitted at startup', t => {
  const root = fixture(t);
  const raw = '---\npaths:\n  - "src/**/*.ts"\ndescription: "Typed code"\n---\nUse strict types.\n';
  put(root, '.agents/rules/types.md', raw);
  run(root, 'sync');
  assert.equal(fs.readFileSync(path.join(root, '.claude/rules/types.md'), 'utf8'), raw);
  const context = hook(root, 'SessionStart').additionalContext;
  assert.doesNotMatch(context, /Use strict types/);
});

test('changed sources are read live; check detects stale copies without writing', t => {
  const root = fixture(t);
  run(root, 'init');
  put(root, '.agents/rules/general.md', '# Updated\nNew conventions.\n');
  const copy = fs.readFileSync(path.join(root, '.claude/rules/general.md'), 'utf8');
  assert.match(run(root, 'check', false).stderr, /Out of sync/);
  assert.equal(fs.readFileSync(path.join(root, '.claude/rules/general.md'), 'utf8'), copy);
  assert.match(hook(root, 'UserPromptSubmit').additionalContext, /New conventions/);
  run(root, 'sync');
  run(root, 'check');
});

test('unrelated hooks and Claude files are preserved', t => {
  const root = fixture(t);
  const unrelated = { type: 'command', command: 'echo original' };
  put(root, '.codex/hooks.json', JSON.stringify({ description: 'Keep me', hooks: { SessionStart: [{ matcher: 'startup', hooks: [unrelated] }] } }));
  put(root, '.claude/rules/team.md', 'Existing rules');
  run(root, 'init');
  const config = JSON.parse(fs.readFileSync(path.join(root, '.codex/hooks.json')));
  assert.equal(config.description, 'Keep me');
  assert.deepEqual(config.hooks.SessionStart[0].hooks, [unrelated]);
  assert.equal(fs.readFileSync(path.join(root, '.claude/rules/team.md'), 'utf8'), 'Existing rules');
});

test('one-sided edits propagate; divergent untracked copies conflict', t => {
  const root = fixture(t);
  run(root, 'init');
  put(root, '.claude/rules/general.md', 'Human edit');
  run(root, 'sync');
  assert.equal(fs.readFileSync(path.join(root, '.agents/rules/general.md'), 'utf8'), 'Human edit');
  assert.equal(fs.readFileSync(path.join(root, '.claude/rules/general.md'), 'utf8'), 'Human edit');
  put(root, '.agents/rules/new.md', 'New source');
  put(root, '.claude/rules/new.md', 'Unmanaged');
  assert.match(run(root, 'sync', false).stderr, /new.md/);
});

test('a missing copy is restored; a one-sided rename retains both rules', t => {
  const root = fixture(t);
  run(root, 'init');
  fs.renameSync(path.join(root, '.agents/rules/general.md'), path.join(root, '.agents/rules/renamed.md'));
  run(root, 'sync');
  assert.equal(fs.existsSync(path.join(root, '.claude/rules/general.md')), true);
  assert.equal(fs.existsSync(path.join(root, '.agents/rules/general.md')), true);
  assert.equal(fs.existsSync(path.join(root, '.claude/rules/renamed.md')), true);
  run(root, 'check');
});

test('rejects symlinked source or destination directories', t => {
  const root = fixture(t);
  run(root, 'init');
  fs.symlinkSync(path.join(root, '.agents/rules/general.md'), path.join(root, '.agents/rules/link.md'));
  assert.match(run(root, 'sync', false).stderr, /Symlink/);
  fs.unlinkSync(path.join(root, '.agents/rules/link.md'));
  fs.rmSync(path.join(root, '.claude'), { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rulebridge-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, '.claude'));
  assert.match(run(root, 'sync', false).stderr, /Symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('strict frontmatter accepts documented lists and rejects unsupported syntax', () => {
  assert.deepEqual(parseRule('---\npaths: ["src/**", "tests/**"]\n---\nRule', 'x').paths, ['src/**', 'tests/**']);
  assert.deepEqual(parseRule('Plain markdown', 'x').paths, []);
  for (const text of [
    '---\npaths: []\n---\nRule', '---\nglobs: ["**"]\n---\nRule',
    '---\npaths:\n  - "../outside"\n---\nRule', '---\npaths: ["/absolute"]\n---\nRule',
    '---\npaths: ["src/**"]\npaths: ["test/**"]\n---\nRule', '---\npaths: [true]\n---\nRule',
    '---\npaths:\n', '',
  ]) assert.throws(() => parseRule(text, 'x'));
});

test('nested rules sort deterministically; oversized context fails explicitly', t => {
  const root = fixture(t);
  put(root, '.agents/rules/z.md', 'Last');
  put(root, '.agents/rules/a/first.md', 'First');
  assert.deepEqual(loadRules(root).map(r => r.name), ['a/first.md', 'z.md']);
  put(root, '.agents/rules/large.md', 'x'.repeat(24001));
  assert.throws(() => loadRules(root), /budget/);
  assert.throws(() => renderContext([{ name: 'x', body: 'x'.repeat(24000), paths: [], description: '' }]), /budget/);
});

test('tampered manifest cannot delete files outside managed namespaces', t => {
  const root = fixture(t);
  run(root, 'init');
  put(root, 'important.txt', 'Keep');
  put(root, '.codex/rulebridge/manifest.json', JSON.stringify({ version: 1, files: { 'important.txt': 'a'.repeat(64) } }));
  assert.match(run(root, 'sync', false).stderr, /Invalid managed file/);
  assert.equal(fs.readFileSync(path.join(root, 'important.txt'), 'utf8'), 'Keep');
});

test('generated integration works in a fresh linked worktree and after compaction', t => {
  const root = fixture(t);
  run(root, 'init');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Rulebridge Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const target = path.join(root, 'linked-worktree');
  execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', target], { stdio: 'ignore' });
  run(target, 'check');
  const script = path.join(target, '.codex/rulebridge/hook.mjs');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', cwd: target, session_id: 'worktree-test' }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Shared conventions/);
  assert.match(hook(target, 'SessionStart').additionalContext, /Shared conventions/);
});

test('invalid rules fail before modifying existing integration files', t => {
  const root = fixture(t);
  run(root, 'init');
  const before = fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8');
  put(root, '.agents/rules/broken.md', '---\nunknown: true\n---\nBad');
  run(root, 'sync', false);
  assert.equal(fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, '.claude/rules/broken.md')), false);
});

test('nested rule paths are identical in both agent directories', t => {
  const root = fixture(t);
  put(root, '.agents/rules/frontend/components.md', 'Shared component conventions');
  run(root, 'sync');
  assert.equal(fs.readFileSync(path.join(root, '.claude/rules/frontend/components.md'), 'utf8'), 'Shared component conventions');
  assert.equal(fs.existsSync(path.join(root, '.claude/rules/rulebridge')), false);
  run(root, 'check');
});

test('sync migrates unchanged manifest-tracked legacy copies to direct paths', t => {
  const root = fixture(t);
  run(root, 'init');
  const direct = '.claude/rules/general.md';
  const legacy = '.claude/rules/rulebridge/general.md';
  const manifestFile = path.join(root, '.codex/rulebridge/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  put(root, legacy, fs.readFileSync(path.join(root, direct), 'utf8'));
  fs.unlinkSync(path.join(root, direct));
  manifest.version = 1;
  manifest.files[legacy] = createHash('sha256').update(fs.readFileSync(path.join(root, legacy))).digest('hex');
  delete manifest.rules;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  run(root, 'check', false);
  run(root, 'sync');
  assert.equal(fs.existsSync(path.join(root, legacy)), false);
  assert.equal(fs.existsSync(path.join(root, direct)), true);
  run(root, 'check');
});

test('init imports a Claude-only repository without adding starter rules', t => {
  const root = fixture(t);
  put(root, '.claude/rules/nested/team.md', 'Existing team rule');
  run(root, 'init');
  assert.equal(fs.readFileSync(path.join(root, '.agents/rules/nested/team.md'), 'utf8'), 'Existing team rule');
  assert.equal(fs.existsSync(path.join(root, '.agents/rules/general.md')), false);
  run(root, 'check');
});

test('sync copies additions in both directions and check never writes', t => {
  const root = fixture(t);
  put(root, '.agents/rules/a.md', 'From agents');
  put(root, '.claude/rules/b.md', 'From Claude');
  run(root, 'check', false);
  assert.equal(fs.existsSync(path.join(root, '.agents/rules/b.md')), false);
  assert.equal(fs.existsSync(path.join(root, '.claude/rules/a.md')), false);
  run(root, 'sync');
  assert.equal(fs.readFileSync(path.join(root, '.agents/rules/b.md'), 'utf8'), 'From Claude');
  assert.equal(fs.readFileSync(path.join(root, '.claude/rules/a.md'), 'utf8'), 'From agents');
  run(root, 'check');
});

test('both-side edits conflict without partial writes; identical edits converge', t => {
  const root = fixture(t);
  run(root, 'init');
  const manifestFile = path.join(root, '.codex/rulebridge/manifest.json');
  const before = fs.readFileSync(manifestFile, 'utf8');
  put(root, '.agents/rules/general.md', 'Left edit');
  put(root, '.claude/rules/general.md', 'Right edit');
  put(root, '.agents/rules/new.md', 'New rule');
  assert.match(run(root, 'sync', false).stderr, /Conflicting rules/);
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, '.claude/rules/new.md')), false);
  assert.equal(fs.readFileSync(path.join(root, '.agents/rules/general.md'), 'utf8'), 'Left edit');
  assert.equal(fs.readFileSync(path.join(root, '.claude/rules/general.md'), 'utf8'), 'Right edit');
  put(root, '.agents/rules/general.md', 'Right edit');
  run(root, 'sync');
  run(root, 'check');
});

test('deleting a rule on both sides removes history, including the last rule', t => {
  const root = fixture(t);
  run(root, 'init');
  fs.unlinkSync(path.join(root, '.agents/rules/general.md'));
  fs.unlinkSync(path.join(root, '.claude/rules/general.md'));
  run(root, 'sync');
  run(root, 'check');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.codex/rulebridge/manifest.json'))).rules, {});
  assert.doesNotMatch(hook(root, 'SessionStart').additionalContext, /Shared conventions/);
});

test('version 1 direct-path manifest upgrades and recognizes Claude-side edits', t => {
  const root = fixture(t);
  run(root, 'init');
  const file = path.join(root, '.codex/rulebridge/manifest.json');
  const current = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ version: 1, files: { ...current.files, '.claude/rules/general.md': current.rules['general.md'] } }));
  put(root, '.claude/rules/general.md', 'Updated by Claude user');
  run(root, 'sync');
  assert.equal(fs.readFileSync(path.join(root, '.agents/rules/general.md'), 'utf8'), 'Updated by Claude user');
  assert.equal(JSON.parse(fs.readFileSync(file)).version, 3);
  run(root, 'check');
});

test('invalid Claude rule blocks copying and integration writes', t => {
  const root = fixture(t);
  put(root, '.claude/rules/bad.md', '---\nunsupported: true\n---\nRule');
  run(root, 'init', false);
  assert.equal(fs.existsSync(path.join(root, '.agents')), false);
  assert.equal(fs.existsSync(path.join(root, '.codex')), false);
});

test('edited runtime is protected during bidirectional sync', t => {
  const root = fixture(t);
  run(root, 'init');
  put(root, '.codex/rulebridge/hook.mjs', '// manual runtime change');
  put(root, '.claude/rules/new.md', 'New rule');
  assert.match(run(root, 'sync', false).stderr, /Refusing to overwrite/);
  assert.equal(fs.existsSync(path.join(root, '.agents/rules/new.md')), false);
});

test('merged rule budget is validated before any copies are written', t => {
  const root = fixture(t);
  put(root, '.agents/rules/left.md', 'a'.repeat(13000));
  put(root, '.claude/rules/right.md', 'b'.repeat(13000));
  assert.match(run(root, 'sync', false).stderr, /budget/);
  assert.equal(fs.existsSync(path.join(root, '.agents/rules/right.md')), false);
  assert.equal(fs.existsSync(path.join(root, '.codex')), false);
});

test('file-directory collision aborts the full plan without partial writes', t => {
  const root = fixture(t);
  put(root, '.agents/rules/a.md', 'First');
  put(root, '.agents/rules/group.md', 'File');
  put(root, '.claude/rules/group.md/child.md', 'Nested');
  run(root, 'sync', false);
  assert.equal(fs.existsSync(path.join(root, '.claude/rules/a.md')), false);
  assert.equal(fs.existsSync(path.join(root, '.codex')), false);
});
