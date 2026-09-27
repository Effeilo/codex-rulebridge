#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const start = '# >>> codex-rulebridge >>>';
const end = '# <<< codex-rulebridge <<<' ;
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
const hash = text => createHash('sha256').update(text).digest('hex');
const exists = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function rejectSymlinks(file) {
  let current = path.resolve(file);
  while (current !== path.dirname(current)) {
    if (exists(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink path is not supported by the installer: ${current}`);
    current = path.dirname(current);
  }
}
try {
  const options = {};
  const args = process.argv.slice(2);
  while (args.length) {
    const key = args.shift();
    if (key === '--no-profile') { options.noProfile = true; continue; }
    if (!['--source', '--prefix', '--profile'].includes(key) || !args.length) throw new Error('Options: --prefix <directory>, --profile <file>, --no-profile');
    options[key.slice(2)] = args.shift();
  }
  if (!options.source) throw new Error('Missing --source');
  if (options.noProfile && options.profile) throw new Error('Use --profile or --no-profile, not both');
  const source = path.resolve(options.source);
  const prefix = path.resolve(options.prefix ?? path.join(os.homedir(), '.local'));
  const install = path.join(prefix, 'share/codex-rulebridge');
  const bin = path.join(prefix, 'bin/codex-rulebridge');
  const marker = path.join(install, '.installation.json');
  rejectSymlinks(install);
  rejectSymlinks(path.dirname(bin));
  const files = ['src/cli.mjs', 'src/rules.mjs', 'src/hook.mjs', 'src/paths.mjs', 'src/state.mjs', 'package.json', 'README.md', 'LICENSE'];
  const content = Object.fromEntries(files.map(name => [name, fs.readFileSync(path.join(source, name))]));
  const packageInfo = JSON.parse(content['package.json']);
  if (packageInfo.name !== 'codex-rulebridge') throw new Error('Unexpected source package');
  let previous = null;
  if (exists(install)) {
    if (!exists(marker)) throw new Error(`Refusing to replace unmanaged directory: ${install}`);
    rejectSymlinks(marker);
    previous = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (previous.name !== 'codex-rulebridge' || !previous.files) throw new Error('Invalid installation record');
  }
  for (const name of files) {
    const target = path.join(install, name);
    rejectSymlinks(target);
    if (exists(target) && hash(fs.readFileSync(target)) !== previous?.files[name]) throw new Error(`Locally modified installation file: ${target}`);
  }
  const executable = path.join(install, 'src/cli.mjs');
  if (exists(bin) && !(fs.lstatSync(bin).isSymbolicLink() && path.resolve(path.dirname(bin), fs.readlinkSync(bin)) === executable)) {
    throw new Error(`Refusing to replace existing command: ${bin}`);
  }

  let profile;
  let original;
  let updated;
  if (!options.noProfile) {
    const shell = path.basename(process.env.SHELL ?? '');
    profile = options.profile;
    if (!profile && shell === 'zsh') profile = path.join(process.env.ZDOTDIR ?? os.homedir(), '.zshrc');
    if (!profile && shell === 'bash') profile = path.join(os.homedir(), exists(path.join(os.homedir(), '.bash_profile')) ? '.bash_profile' : '.bashrc');
    if (!profile) throw new Error('Use Bash/Zsh, or specify --profile <file> or --no-profile');
    profile = path.resolve(profile);
    rejectSymlinks(profile);
    original = exists(profile) ? fs.readFileSync(profile, 'utf8') : '';
    const lines = original.split('\n');
    const starts = lines.flatMap((line, i) => line === start ? [i] : []);
    const ends = lines.flatMap((line, i) => line === end ? [i] : []);
    if (starts.length !== ends.length || starts.length > 1 || (starts.length && starts[0] >= ends[0])) throw new Error('Invalid Rulebridge profile markers; nothing was changed');
    const block = `${start}\nexport PATH=${quote(path.join(prefix, 'bin'))}:"$PATH"\n${end}`;
    if (starts.length) {
      lines.splice(starts[0], ends[0] - starts[0] + 1, block);
      updated = lines.join('\n');
    } else updated = original + (original.endsWith('\n') || !original ? '' : '\n') + block + '\n';
  }

  // All conflicts are checked before modifying installation or profile files.
  fs.mkdirSync(install, { recursive: true });
  for (const [name, body] of Object.entries(content)) {
    const target = path.join(install, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  fs.chmodSync(executable, 0o755);
  fs.writeFileSync(marker, JSON.stringify({ name: 'codex-rulebridge', files: Object.fromEntries(files.map(name => [name, hash(content[name])])) }, null, 2) + '\n');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  if (!exists(bin)) fs.symlinkSync(executable, bin);
  if (profile && updated !== original) {
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    if (exists(profile)) {
      const backup = `${profile}.rulebridge-backup-${Date.now()}-${process.pid}`;
      fs.copyFileSync(profile, backup, fs.constants.COPYFILE_EXCL);
      console.log(`Profile backup: ${backup}`);
    }
    fs.writeFileSync(profile, updated);
  }
  console.log(`Installed codex-rulebridge ${packageInfo.version}: ${bin}`);
  console.log(profile ? `Open a new terminal or run: source ${quote(profile)}` : `Add ${path.dirname(bin)} to your PATH, or use the full command path.`);
  console.log('Then, inside your Git repository: codex-rulebridge init');
} catch (error) {
  console.error(`codex-rulebridge installer: ${error.message}`);
  process.exitCode = 1;
}
