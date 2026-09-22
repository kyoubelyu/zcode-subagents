import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const VERSION = '0.2.0';
export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
export const MAX_CONCURRENCY = 12;
export const WAIT_DEFAULT = 900000;
export const WAIT_MIN = 600000;
export const WAIT_MAX = 1800000;

export function settings(env = process.env) {
  const home = path.resolve(env.ZCODE_SUBAGENTS_HOME || path.join(os.homedir(), '.local/share/zcode-subagents'));
  const concurrency = Number(env.ZCODE_SUBAGENTS_CONCURRENCY || MAX_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error('ZCODE_SUBAGENTS_CONCURRENCY must be an integer from 1 to 12.');
  }
  if (process.platform !== 'linux') throw new Error('This release supports Linux (including WSL) only.');
  const socket = path.join(home, 'supervisor.sock');
  if (Buffer.byteLength(socket) > 100) throw new Error('ZCODE_SUBAGENTS_HOME is too long for a Unix socket.');
  return { home, socket, concurrency,
    runtimeRoot: path.resolve(env.ZCODE_SUBAGENTS_RUNTIME_ROOT || path.join(os.homedir(), '.zcode/server')) };
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid task or wait ID.');
  return id;
}
export const taskDir = (config, id) => path.join(config.home, 'tasks', validId(id));
export async function privateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}
export async function atomicJson(file, value) {
  await privateDir(path.dirname(file));
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export async function readJson(file, fallback = undefined) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return undefined;
  try {
    const raw = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return undefined;
    return fields[19]; // Linux proc field 22: starttime, after pid and comm.
  } catch { return undefined; }
}
export async function sameProcess(owner) {
  return Boolean(owner?.pid && owner?.identity && await processIdentity(owner.pid) === owner.identity);
}
export function bounded(value, length = 12000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text?.length > length ? text.slice(0, length) + '\n[Truncated; see task artifacts.]' : text;
}
