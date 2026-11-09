import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const [apiDir, entryFile = 'index.js'] = process.argv.slice(2);
let api = null;
let work = Promise.resolve();

function errorInfo(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || '',
    code: error?.code,
  };
}

function persistFatal(source, error) {
  try {
    const logsDir = path.join(apiDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const detail = error?.stack || error?.message || String(error);
    fs.appendFileSync(
      path.join(logsDir, 'native-worker.log'),
      `[${new Date().toISOString()}] ${source}: ${detail}\n`,
      'utf8',
    );
  } catch {
    // Diagnostics must not mask the original worker failure.
  }
}

function failWorker(source, error) {
  persistFatal(source, error);
  const payload = { type: 'fatal', error: errorInfo(error) };
  if (process.send) {
    process.send(payload, () => process.exit(1));
  } else {
    process.exitCode = 1;
  }
}

function resolveApiFunction(name) {
  const candidate = api?.[name];
  if (typeof candidate === 'function') return candidate;
  const fallback = api?.default?.[name];
  return typeof fallback === 'function' ? fallback : null;
}

async function invoke(message) {
  const fn = resolveApiFunction(message.name);
  if (!fn) {
    throw new Error(`Native module API '${message.name}' is not available`);
  }
  const cwd = process.cwd();
  process.chdir(apiDir);
  try {
    return await fn(...(Array.isArray(message.args) ? message.args : []));
  } finally {
    process.chdir(cwd);
  }
}

async function handleMessage(message) {
  if (message?.type !== 'invoke') return;
  try {
    const value = await invoke(message);
    process.send?.({ type: 'response', id: message.id, ok: true, value });
  } catch (error) {
    process.send?.({ type: 'response', id: message.id, ok: false, error: errorInfo(error) });
  }
}

process.on('message', message => {
  work = work.then(() => handleMessage(message));
});

try {
  process.chdir(apiDir);
  const namespace = await import(pathToFileURL(path.join(apiDir, entryFile)).href);
  api = namespace?.default && Object.keys(namespace).length === 1 ? namespace.default : namespace;
  const functions = Object.entries(api || {})
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name);
  process.send?.({ type: 'ready', functions });
} catch (error) {
  failWorker('load', error);
}

process.on('uncaughtException', error => {
  failWorker('uncaughtException', error);
});

process.on('unhandledRejection', reason => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  failWorker('unhandledRejection', error);
});
