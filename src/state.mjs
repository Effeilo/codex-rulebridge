import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
export const digest = text => createHash('sha256').update(text).digest('hex');

function directory(name) {
  try { fs.mkdirSync(name, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const stat = fs.lstatSync(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe Rulebridge cache directory');
}
export async function withState(root, input, run) {
  if (typeof input.session_id !== 'string' || !input.session_id) throw new Error('Hook input requires session_id for selective rule loading');
  const base = path.join(fs.realpathSync(os.tmpdir()), `codex-rulebridge-${process.getuid?.() ?? 'user'}`);
  directory(base);
  const repository = path.join(base, digest(fs.realpathSync(root)));
  directory(repository);
  // Codex exposes agent_id for subagent lifecycle and tool hooks. Transcript paths
  // distinguish contexts on clients without that extension; never read transcripts.
  const identity = input.agent_id || input.transcript_path || 'root';
  const key = digest(JSON.stringify([input.session_id, identity]));
  const file = path.join(repository, key + '.json');
  const lock = file + '.lock';
  const deadline = Date.now() + 3000;
  while (true) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) throw new Error('Rule cache busy; retry the tool call. Remove stale cache locks after stopping Codex.');
      await delay(25);
    }
  }
  try {
    let state = { delivered: {}, active: [] };
    if (fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Unsafe Rulebridge cache file');
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!state.delivered || typeof state.delivered !== 'object' || !Array.isArray(state.active)) throw new Error('Invalid Rulebridge session cache');
    }
    const result = run(state);
    if (input.hook_event_name === 'SessionEnd') fs.rmSync(file, { force: true });
    else {
      const temporary = file + '.' + randomUUID();
      fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    }
    return result;
  } finally { fs.rmdirSync(lock); }
}
