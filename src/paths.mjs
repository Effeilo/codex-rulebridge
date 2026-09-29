import fs from 'node:fs';
import path from 'node:path';

// A bounded, explicit glob subset shared by validation and matching.
export function expandGlob(pattern) {
  let patterns = [pattern];
  for (let depth = 0; depth < 8; depth++) {
    let changed = false;
    patterns = patterns.flatMap(p => {
      const m = p.match(/\{([^{}]+)\}/);
      if (!m) return [p];
      changed = true;
      return m[1].split(',').map(part => p.slice(0, m.index) + part + p.slice(m.index + m[0].length));
    });
    if (patterns.length > 128) throw new Error('Glob expansion exceeds 128 patterns');
    if (!changed) break;
  }
  if (patterns.some(p => /[{}]/.test(p))) throw new Error('Invalid or excessively nested glob braces');
  return patterns;
}
export function globRegex(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { out += '(?:.*/)?'; i++; }
      else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) throw new Error('Unclosed glob character class');
      let chars = pattern.slice(i + 1, end);
      if (!chars || chars.includes('/') || chars.includes('[')) throw new Error('Invalid glob character class');
      if (chars.startsWith('!')) chars = '^' + chars.slice(1);
      out += '[' + chars + ']'; i = end;
    } else out += c.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(out + '$');
}
export function validateGlob(pattern) {
  if (pattern.startsWith('!') || pattern.includes('***')) throw new Error('Negated patterns and *** are not supported');
  for (const expanded of expandGlob(pattern)) globRegex(expanded);
}
export function matchesPath(pattern, file, directory = false) {
  return expandGlob(pattern).some(p => {
    if (globRegex(p).test(file)) return true;
    if (!directory) return false;
    // A directory operation can touch any descendant. Compare fixed prefixes;
    // wildcard prefixes are intentionally conservative.
    const fixed = p.split(/[?*\[]/)[0];
    const prefix = file === '.' ? '' : file.replace(/\/$/, '') + '/';
    return fixed.startsWith(prefix) || prefix.startsWith(fixed);
  });
}
function target(root, cwd, name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return null;
  let absolute = path.resolve(cwd, name);
  let relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    // Resolve external aliases before excluding them. For a future file, resolve
    // its nearest existing ancestor and append the missing suffix.
    let ancestor = absolute;
    const suffix = [];
    while (true) {
      try {
        absolute = path.join(fs.realpathSync(ancestor), ...suffix);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') return { opaque: true };
        // A dangling symlink is uncertain, not a proven external path.
        try { if (fs.lstatSync(ancestor).isSymbolicLink()) return { opaque: true }; }
        catch (e) { if (e.code !== 'ENOENT') return { opaque: true }; }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return { opaque: true };
        suffix.unshift(path.basename(ancestor));
        ancestor = parent;
      }
    }
    relative = path.relative(fs.realpathSync(root), absolute);
  }
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  // Do not miss an in-repo alias to a different path; conservatively load all.
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) return { opaque: true }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  let directory = relative === '';
  try { directory ||= fs.statSync(absolute).isDirectory(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { path: relative.split(path.sep).join('/') || '.', directory };
}
// Only parse simple read-only shell commands. Never execute input to discover paths.
function shellWords(command) {
  if (/[\n\r;$`|&<>()[\]{}*?~\\]/.test(command)) return null;
  const words = []; const re = /"([^"$]*)"|'([^']*)'|([^\s"']+)/gy;
  let i = 0;
  while (i < command.length) {
    while (/\s/.test(command[i] ?? '') && i < command.length) i++;
    if (i === command.length) break;
    re.lastIndex = i; const m = re.exec(command);
    if (!m) return null;
    words.push(m[1] ?? m[2] ?? m[3]); i = re.lastIndex;
    if (i < command.length && !/\s/.test(command[i])) return null;
  }
  return words;
}
export function toolTargets(root, input) {
  const args = input.tool_input ?? {};
  const cwd = path.resolve(input.cwd ?? root, args.workdir ?? args.cwd ?? '.');
  const name = input.tool_name ?? '';
  const add = names => {
    const targets = names.map(n => target(root, cwd, n)).filter(Boolean);
    return { targets, opaque: targets.some(t => t.opaque) };
  };
  if (/(^|[._])apply_patch$/.test(name)) {
    const patch = typeof args === 'string' ? args : args.command ?? args.patch ?? args.input;
    if (typeof patch !== 'string') return { targets: [], opaque: true };
    const names = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(m => m[1]);
    return names.length ? add(names) : { targets: [], opaque: true };
  }
  if (name === 'Bash' || /(?:exec_command|shell_command|shell)$/.test(name)) {
    const words = shellWords(args.command ?? args.cmd ?? '');
    if (!words?.length) return { targets: [], opaque: true };
    const cmd = words.shift();
    // sed scripts can read/write files or execute commands within the expression.
    // Keep them opaque rather than inferring effects from positional arguments.
    if (!['cat', 'head', 'tail', 'rg', 'grep', 'ls', 'pwd'].includes(cmd)) return { targets: [], opaque: true };
    if (cmd === 'pwd') return { targets: [], opaque: words.length > 0 };
    const names = []; let pattern = ['rg', 'grep'].includes(cmd); let options = true;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (options && word === '--') { options = false; continue; }
      if (options && word.startsWith('-')) {
        if (['-n', '-c'].includes(word) && ['head', 'tail'].includes(cmd)) { i++; continue; }
        if (cmd === 'rg' && word === '--files') { pattern = false; continue; }
        if (['-n', '-l', '-a', '-F', '-H', '-i', '-v'].includes(word)) continue;
        return { targets: [], opaque: true }; // unknown option may consume a path
      }
      if (pattern) { pattern = false; continue; }
      names.push(word);
    }
    if (!names.length && ['ls', 'rg', 'grep'].includes(cmd)) names.push('.');
    return add(names);
  }
  const fields = ['file_path', 'path', 'filename', 'file', 'paths', 'files', 'source', 'destination', 'old_path', 'new_path'];
  const names = fields.flatMap(key => typeof args[key] === 'string' ? [args[key]] : Array.isArray(args[key]) ? args[key].filter(x => typeof x === 'string') : []);
  if (names.length) return add(names);
  if (['update_plan', 'wait', 'wait_agent', 'spawn_agent', 'send_message', 'list_agents'].includes(name)) return { targets: [], opaque: false };
  return { targets: [], opaque: true };
}
