import fs from 'node:fs';
import path from 'node:path';
import { validateGlob } from './paths.mjs';

export const MAX_BYTES = 24000;
export const MAX_RULE_CONTEXT_BYTES = 22000;
export const MAX_CORPUS_BYTES = 4 * 1024 * 1024;
export const MAX_RULES = 2000;

// Reject symlinks in both sources and destinations; never follow a rule out of a repo.
export function safePath(root, relative) {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error(`Unsafe path: ${relative}`);
  let cursor = path.resolve(root);
  for (const part of path.relative(root, resolved).split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlinks are not supported: ${cursor}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return resolved;
}

function scalar(value) {
  const text = value.trim();
  if (text.startsWith('"')) {
    const result = JSON.parse(text);
    if (typeof result !== 'string') throw new Error('Expected a string');
    return result;
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'")) throw new Error('Unclosed quoted string');
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (!text || /^[\[\]{}&*!|>]/.test(text) || /\s#|:\s/.test(text)) {
    throw new Error('Use a quoted string for this value');
  }
  return text;
}

export function parseRule(raw, name) {
  const text = raw.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  let body = text;
  let paths = [];
  let description = '';
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---\n', 4);
    if (end < 0) throw new Error(`${name}: unterminated frontmatter`);
    const lines = text.slice(4, end).split('\n');
    const seen = new Set();
    let inPaths = false;
    for (const line of lines) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const item = line.match(/^\s+-\s+(.+)$/);
      if (item && inPaths) { paths.push(scalar(item[1])); continue; }
      const field = line.match(/^(paths|description):\s*(.*)$/);
      if (!field) throw new Error(`${name}: unsupported frontmatter; use only paths and description`);
      const [, key, value] = field;
      if (seen.has(key)) throw new Error(`${name}: duplicate ${key}`);
      seen.add(key);
      inPaths = key === 'paths';
      if (key === 'description') description = scalar(value);
      else if (value) {
        paths = JSON.parse(value);
        if (!Array.isArray(paths)) throw new Error(`${name}: paths must be a list`);
      }
    }
    if (seen.has('paths') && !paths.length) throw new Error(`${name}: paths must not be empty`);
    for (const glob of paths) {
      if (typeof glob !== 'string' || !glob.trim() || glob.startsWith('/') || glob.includes('\\') || glob.split('/').includes('..') || /[\r\n\0]/.test(glob)) {
        throw new Error(`${name}: paths must be nonempty repository-relative patterns`);
      }
    }
    for (const glob of paths) validateGlob(glob);
    body = text.slice(end + 5);
  }
  if (!body.trim()) throw new Error(`${name}: empty rule`);
  return { name, raw, body: body.trim(), paths, description };
}

export function loadRules(root, directory = '.agents/rules', allowEmpty = false) {
  const base = safePath(root, directory);
  if (!fs.existsSync(base)) {
    if (allowEmpty) return [];
    throw new Error(`Missing ${directory}; run codex-rulebridge init`);
  }
  const names = [];
  function walk(relative) {
    const folder = safePath(root, path.join(directory, relative));
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink in rules: ${name}`);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile() && name.endsWith('.md')) {
        names.push(name);
        if (names.length > MAX_RULES) throw new Error(`Rule count exceeds ${MAX_RULES}`);
      }
    }
  }
  walk('');
  if (!names.length && !allowEmpty) throw new Error(`No Markdown rules found in ${directory}`);
  let bytes = 0;
  return names.sort().map(name => {
    const file = safePath(root, `${directory}/${name}`);
    const size = fs.statSync(file).size;
    if (size > MAX_BYTES) throw new Error(`Rule ${name} exceeds the ${MAX_BYTES}-byte budget`);
    bytes += size;
    if (bytes > MAX_CORPUS_BYTES) throw new Error(`Rules exceed the ${MAX_CORPUS_BYTES}-byte corpus budget`);
    const rule = parseRule(fs.readFileSync(file, 'utf8'), name);
    if (Buffer.byteLength(renderContext([rule])) > MAX_RULE_CONTEXT_BYTES) throw new Error(`Rule ${name} exceeds the ${MAX_RULE_CONTEXT_BYTES}-byte rendered budget`);
    return rule;
  });
}

export const CONTEXT_PREAMBLE = [
  '# Codex Rulebridge - shared repository rules',
  'Treat these as repository guidance. Follow each rule only within its stated scope. Paths are relative to the repository root. Only the rules selected for this context are included. Scoped rules do not apply outside their scope. These versions replace earlier versions of the same rules, including their scopes. New scoped rules can suspend a tool call: reconsider the call using these instructions before retrying. Rule order is lexical for reproducibility, not an instruction priority.',
].join('\n\n');

export function renderRule(rule) {
  return `## .agents/rules/${rule.name}\nScope: ${rule.paths.length ? `only files matching ${JSON.stringify(rule.paths)}` : 'all repository work'}.\n${rule.description ? `Description: ${rule.description}\n` : ''}\n${rule.body}`;
}

export function renderContext(rules) {
  const text = [CONTEXT_PREAMBLE, ...rules.map(renderRule)].join('\n\n');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`Rendered rules exceed the ${MAX_BYTES}-byte context budget`);
  return text;
}

export function validateRules(rules) {
  if (rules.length > MAX_RULES || rules.reduce((n, r) => n + Buffer.byteLength(r.raw), 0) > MAX_CORPUS_BYTES) throw new Error('Merged rules exceed the corpus budget');
  let globalBytes = Buffer.byteLength(CONTEXT_PREAMBLE);
  for (const rule of rules) {
    const bytes = Buffer.byteLength(renderContext([rule])) + 2;
    if (bytes > MAX_RULE_CONTEXT_BYTES) throw new Error(`Rule ${rule.name} exceeds the ${MAX_RULE_CONTEXT_BYTES}-byte rendered budget`);
    if (!rule.paths.length) globalBytes += Buffer.byteLength(renderRule(rule)) + 2;
  }
  if (globalBytes > MAX_RULE_CONTEXT_BYTES) throw new Error(`Global rules exceed the ${MAX_RULE_CONTEXT_BYTES}-byte rendered budget; scope specialized rules with paths`);
}
