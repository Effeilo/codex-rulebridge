import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
const source = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rulebridge install ' ")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prefix = path.join(dir, 'local');
  const profile = path.join(dir, 'shellrc');
  return { dir, prefix, profile, run: (...args) => spawnSync('bash', [path.join(source, 'install.sh'), '--local', source, '--prefix', prefix, ...args], { encoding: 'utf8' }) };
}
test('local installer works without npm, preserves profile, supports quoting and reruns', t => {
  const f = fixture(t);
  fs.writeFileSync(f.profile, '# Personal settings\nexport TEAM=test\n');
  let result = f.run('--profile', f.profile);
  assert.equal(result.status, 0, result.stderr);
  const original = fs.readFileSync(f.profile, 'utf8');
  assert.match(original, /Personal settings/);
  assert.equal(fs.readdirSync(f.dir).filter(n => n.includes('backup')).length, 1);
  result = f.run('--profile', f.profile);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.profile, 'utf8'), original);
  assert.equal(fs.readdirSync(f.dir).filter(n => n.includes('backup')).length, 1);
  const shell = spawnSync('bash', ['-c', 'source "$1"; codex-rulebridge --help', 'bash', f.profile], { encoding: 'utf8' });
  assert.equal(shell.status, 0, shell.stderr);
  assert.match(shell.stdout, /Synchronize both/);
  const consumer = path.join(f.dir, 'consumer');
  fs.mkdirSync(consumer);
  execFileSync('git', ['init', '-q', consumer]);
  execFileSync(path.join(f.prefix, 'bin/codex-rulebridge'), ['init', '--root', consumer]);
  execFileSync(path.join(f.prefix, 'bin/codex-rulebridge'), ['check', '--root', consumer]);
});
test('installer detects broken markers before installing anything', t => {
  const f = fixture(t);
  fs.writeFileSync(f.profile, '# >>> codex-rulebridge >>>\n');
  assert.equal(f.run('--profile', f.profile).status, 1);
  assert.equal(fs.existsSync(f.prefix), false);
});
test('installer preserves unrelated command and manually edited runtime', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.prefix, 'bin'), { recursive: true });
  const bin = path.join(f.prefix, 'bin/codex-rulebridge');
  fs.writeFileSync(bin, 'existing');
  assert.equal(f.run('--no-profile').status, 1);
  assert.equal(fs.readFileSync(bin, 'utf8'), 'existing');
  fs.unlinkSync(bin);
  assert.equal(f.run('--no-profile').status, 0);
  const runtime = path.join(f.prefix, 'share/codex-rulebridge/src/cli.mjs');
  fs.appendFileSync(runtime, '\n// personal edit\n');
  assert.equal(f.run('--no-profile').status, 1);
  assert.match(fs.readFileSync(runtime, 'utf8'), /personal edit/);
});
