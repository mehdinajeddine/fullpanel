import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';

let child;
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopping = true; child?.kill('SIGTERM'); });
function run(binary, args) {
  return new Promise((resolve, reject) => {
    child = spawn(binary, args, { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', code => code === 0 || stopping ? resolve() : reject(new Error(`${binary} exited with ${code}`)));
  });
}
try {
  await run('npm', ['run', 'build']);
  if (!stopping) await run(process.execPath, ['dist/server/index.js']);
} finally {
  const directory = process.env.DATA_DIR;
  if (directory && dirname(directory) === tmpdir() && basename(directory).startsWith('harborlight-e2e-')) await rm(directory, { recursive: true, force: true });
}
