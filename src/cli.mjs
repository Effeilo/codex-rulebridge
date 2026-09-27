#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { matchesPath } from './paths.mjs';
import { safePath, loadRules, renderContext, validateRules } from './rules.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const manifestName = '.codex/rulebridge/manifest.json';
const command = 'node "$(git rev-parse --show-toplevel)/.codex/rulebridge/hook.mjs"';
const events = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'PreToolUse', 'PostCompact', 'SessionEnd'];
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';

function read(root, name) {
  const file = safePath(root, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
function write(root, name, value) {
  const file = safePath(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
const runtimeNames = ['hook.mjs', 'rules.mjs', 'paths.mjs', 'state.mjs'].map(name => '.codex/rulebridge/' + name);
function validName(name) {
  return name && !name.startsWith('/') && !name.includes('\\') && !name.split('/').some(part => ['..', '.', ''].includes(part));
}
function manifest(root) {
  const raw = read(root, manifestName);
  if (!raw) return { version: 3, claudeSync: false, files: {}, rules: {} };
  const result = JSON.parse(raw);
  if (![1, 2, 3].includes(result.version) || !result.files || typeof result.files !== 'object' || Array.isArray(result.files)) throw new Error('Invalid Rulebridge manifest');
  for (const [name, digest] of Object.entries(result.files)) {
    const allowed = runtimeNames.includes(name) || (result.version === 1 && name.startsWith('.claude/rules/') && name.endsWith('.md'));
    if (!allowed || !validName(name) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid managed file in manifest');
    safePath(root, name);
  }
  if (result.version === 3 && typeof result.claudeSync !== 'boolean') throw new Error('Invalid Claude sync mode');
  if (result.version >= 2) {
    if (!result.rules || typeof result.rules !== 'object' || Array.isArray(result.rules)) throw new Error('Invalid rule history');
    for (const [name, digest] of Object.entries(result.rules)) {
      if (!validName(name) || !name.endsWith('.md') || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid rule history');
    }
  }
  return result;
}

function planRules(root, previous, initialize, claudeSync) {
  const agents = new Map(loadRules(root, '.agents/rules', true).map(rule => [rule.name, rule]));
  const claude = new Map(claudeSync ? loadRules(root, '.claude/rules', true).map(rule => [rule.name, rule]) : []);
  const baseline = new Map(Object.entries(previous.rules ?? {}));
  const removals = [];
  // Upgrade one-way manifests, including the original generated subdirectory.
  if (claudeSync && previous.version === 1) {
    for (const [file, digest] of Object.entries(previous.files)) {
      if (!file.startsWith('.claude/rules/')) continue;
      let name = file.slice('.claude/rules/'.length);
      if (name.startsWith('rulebridge/') && !agents.has(name) && agents.has(name.slice(11))) {
        const old = claude.get(name);
        const target = name.slice(11);
        if (old && hash(old.raw) !== digest) throw new Error(`Conflict in legacy rule: ${name}`);
        if (old) {
          if (claude.has(target) && claude.get(target).raw !== old.raw) throw new Error(`Conflict in legacy rule: ${target}`);
          claude.set(target, { ...old, name: target });
          claude.delete(name);
          removals.push(file);
        }
        name = target;
      }
      baseline.set(name, digest);
    }
  }
  if (initialize && !agents.size && !claude.size && !baseline.size && !Object.keys(previous.files).length) {
    const raw = '# Shared conventions\n\n- Follow existing project conventions.\n- Validate changed behavior with relevant tests.\n';
    agents.set('general.md', { name: 'general.md', raw, body: raw.trim(), paths: [], description: '' });
  }
  const rules = [];
  const conflicts = [];
  for (const name of [...new Set([...agents.keys(), ...claude.keys()])].sort()) {
    const left = agents.get(name);
    const right = claude.get(name);
    if (!left || !right || left.raw === right.raw) { rules.push(left ?? right); continue; }
    const base = baseline.get(name);
    if (base && hash(left.raw) === base) rules.push(right);
    else if (base && hash(right.raw) === base) rules.push(left);
    else conflicts.push(name);
  }
  if (conflicts.length) throw new Error(`Conflicting rules; make both copies identical before syncing:\n${conflicts.join('\n')}`);
  validateRules(rules);
  const files = Object.fromEntries(rules.flatMap(rule => [
    [`.agents/rules/${rule.name}`, rule.raw], ...(claudeSync ? [[`.claude/rules/${rule.name}`, rule.raw]] : []),
  ]));
  // Preflight every destination before writing anything, including symlink parents.
  for (const name of Object.keys(files)) safePath(root, name);
  return { rules, files, removals };
}
function hookConfig(root) {
  const raw = read(root, '.codex/hooks.json');
  const config = raw ? JSON.parse(raw) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid hooks.json');
  config.hooks ??= {};
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error('Invalid hooks map');
  for (const event of events) {
    const groups = config.hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`Invalid ${event} hooks`);
    // Keep all unrelated handlers, including handlers in mixed groups.
    const kept = groups.map(group => {
      if (!group || !Array.isArray(group.hooks)) throw new Error(`Invalid ${event} hook group`);
      return { ...group, hooks: group.hooks.filter(handler => handler.command !== command) };
    }).filter(group => group.hooks.length);
    config.hooks[event] = [...kept, { hooks: [{ type: 'command', command, timeout: event === 'SessionEnd' ? 3 : 10, ...(!['PostCompact', 'SessionEnd'].includes(event) ? { additionalContextLimit: 0 } : {}) }] }];
  }
  return encode(config);
}
function sync(root, check, initialize = false, mode) {
  const previous = manifest(root);
  const claudeSync = mode ?? (previous.version < 3 || previous.claudeSync);
  const plan = planRules(root, previous, initialize, claudeSync);
  const desired = { ...plan.files };
  for (const name of runtimeNames) desired[name] = fs.readFileSync(path.join(source, path.basename(name)), 'utf8');
  const hooks = hookConfig(root);
  const changes = [];
  for (const [name, next] of Object.entries(desired)) {
    const current = read(root, name);
    if (current === next) continue;
    if (runtimeNames.includes(name) && current !== null && (!previous.files[name] || hash(current) !== previous.files[name])) {
      throw new Error(`Refusing to overwrite edited or unmanaged runtime: ${name}`);
    }
    changes.push(name);
  }
  // A path cannot be both a file and a parent directory in the merged result.
  const destinations = Object.keys(desired);
  for (const name of destinations) {
    if (destinations.some(other => other.startsWith(name + '/'))) throw new Error(`File/directory conflict: ${name}`);
    const absolute = safePath(root, name);
    let parent = path.dirname(absolute);
    while (parent !== root && parent.startsWith(root + path.sep)) {
      if (fs.existsSync(parent) && !fs.statSync(parent).isDirectory()) throw new Error(`File/directory conflict: ${name}`);
      parent = path.dirname(parent);
    }
  }
  const nextManifest = encode({ version: 3, claudeSync,
    files: Object.fromEntries(runtimeNames.map(name => [name, hash(desired[name])])),
    // Preserve the last SHARED baseline while Claude sync is disabled.
    rules: claudeSync ? Object.fromEntries(plan.rules.map(rule => [rule.name, hash(rule.raw)])) : (previous.rules ?? {}),
  });
  if (read(root, '.codex/hooks.json') !== hooks) changes.push('.codex/hooks.json');
  if (read(root, manifestName) !== nextManifest) changes.push(manifestName);
  if (check) {
    if (changes.length || plan.removals.length) throw new Error(`Out of sync; run codex-rulebridge init (or sync if sharing with Claude):\n${[...changes, ...plan.removals].join('\n')}`);
    console.log(claudeSync ? 'Both rule directories and Codex hooks are in sync.' : 'Codex rules and hooks are up to date.');
    return;
  }
  for (const name of changes) {
    if (name !== '.codex/hooks.json' && name !== manifestName) write(root, name, desired[name]);
  }
  for (const name of plan.removals) fs.unlinkSync(safePath(root, name));
  write(root, '.codex/hooks.json', hooks);
  write(root, manifestName, nextManifest);
  console.log(claudeSync ? `Synchronized ${plan.rules.length} rules in both directions. Review/trust the hooks in Codex (/hooks in CLI).` : `Configured ${plan.rules.length} Codex rules with selective loading. Review/trust the hooks in Codex (/hooks in CLI).`);
  if (!claudeSync && fs.existsSync(path.join(root, '.claude/rules'))) console.log('Claude rules found and left untouched. Run codex-rulebridge sync to import and share them.');
}

try {
  const args = process.argv.slice(2);
  const action = args.shift() ?? 'help';
  if (['help', '--help', '-h'].includes(action)) {
    console.log('codex-rulebridge <init|sync|check|explain> [--root <repository>]\n\ninit     Set up Codex rules and selective hooks; --claude enables sharing, --no-claude disables it\nsync     Synchronize both rule directories and the Codex hook runtime\ncheck    Validate rules and generated files (CI, no writes)\nexplain  Preview global rules; --path selects matching rules, --all lists everything\n\nRequires Node.js 22+ and Git. No global configuration is changed.');
  } else {
    if (!['init', 'sync', 'check', 'explain'].includes(action)) throw new Error(`Unknown command: ${action}`);
    let cwd = process.cwd(); let mode; let file; let all = false;
    while (args.length) {
      const flag = args.shift();
      if (flag === '--root' && args.length) cwd = path.resolve(args.shift());
      else if (flag === '--path' && action === 'explain' && args.length) file = args.shift();
      else if (flag === '--all' && action === 'explain') all = true;
      else if (['--claude', '--no-claude'].includes(flag) && action === 'init' && mode === undefined) mode = flag === '--claude';
      else throw new Error(`Unexpected option: ${flag}`);
    }
    if (file && all) throw new Error('Use --path or --all, not both');
    const root = fs.realpathSync(execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
    if (action === 'explain') {
      if (file && (path.isAbsolute(file) || file.split('/').includes('..'))) throw new Error('--path must be repository-relative');
      const rules = loadRules(root, '.agents/rules', true).filter(rule => all || !rule.paths.length || (file && rule.paths.some(glob => matchesPath(glob, file))));
      // Print rule-by-rule so a large corpus can be inspected without one huge hook payload.
      for (const rule of rules) console.log(renderContext([rule]));
    } else sync(root, action === 'check', action === 'init', action === 'sync' ? true : mode);

  }
} catch (error) {
  console.error(`codex-rulebridge: ${error.message}`);
  process.exitCode = 1;
}
