/** Deterministic offline inventory of this service's installed npm dependencies. */
import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const destination = join(root, 'public/licenses/THIRD-PARTY-NOTICES.txt');
const lockBytes = await readFile(join(root, 'package-lock.json'));
const lock = JSON.parse(lockBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const legalName = /^(?:licen[sc]e|notice|copying|copyright)(?:$|[._ -])/i;

async function legalFiles(directory, depth = 0) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => order(a.name, b.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error(`Unexpected dependency symlink: ${relative(root, path)}`);
    if (entry.isDirectory() && entry.name !== 'node_modules' && depth < 3) files.push(...await legalFiles(path, depth + 1));
    if (!entry.isFile() || !legalName.test(entry.name) || /\.(?:[cm]?js|map|ts)$/i.test(entry.name)) continue;
    if ((await lstat(path)).size > 1024 * 1024) throw Error('Upstream legal text exceeds the inventory size limit.');
    const bytes = await readFile(path);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\0')) throw Error('Upstream legal text must be UTF-8 text.');
    files.push({ path: relative(root, path).replaceAll('\\', '/'), text, hash: hash(bytes) });
  }
  return files;
}

const parts = [
  'FullPanel community service — third-party notices\n\n',
  'Generated offline by community/generate-notices.mjs.\n',
  'Scope: npm packages in community/package-lock.json, including optional dependencies. All locked packages must be installed to reproduce this file.\n',
  'Complete upstream license/NOTICE files are reproduced below, with their source paths and SHA-256 hashes. The search covers three directory levels and excludes nested node_modules and source code. pg-types 2.2.0 and pgpass 1.0.5 embed their full MIT licenses in their READMEs, reproduced in full.\n',
  'The Inter font license is supplied separately in Inter-OFL.txt. Node.js and operating-system distributions supply their own notices and are outside this npm inventory. This inventory is not a legal compliance determination.\n',
  `\nLockfile SHA-256: ${hash(lockBytes)}\n`,
];
let count = 0;
for (const [location, metadata] of Object.entries(lock.packages).sort(([a], [b]) => order(a, b))) {
  if (!location) continue;
  if (!location.startsWith('node_modules/') || location.includes('\\') || location.split('/').includes('..') || metadata.link) throw Error('Unexpected lockfile package location.');
  const directory = join(root, location);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (manifest.version !== metadata.version) throw Error(`Installed version differs from the lockfile: ${location}`);
  const files = await legalFiles(directory);
  const readmeCopyright = new Map([
    ['pg-types@2.2.0', 'Copyright (c) 2014 Brian M. Carlson'],
    ['pgpass@1.0.5', 'Copyright (c) 2013-2016 Hannes Hörl'],
  ]).get(`${manifest.name}@${manifest.version}`);
  if (!files.length && readmeCopyright) {
    const bytes = await readFile(join(directory, 'README.md'));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.includes(readmeCopyright) || !text.includes('Permission is hereby granted, free of charge') || !text.includes('THE SOFTWARE IS PROVIDED "AS IS"')) throw Error('A reviewed README license has changed.');
    files.push({ path: `${location}/README.md`, text, hash: hash(bytes) });
  }
  if (!files.length) throw Error(`Missing upstream license/NOTICE text: ${location}`);
  count += 1;
  parts.push(`\n${'='.repeat(78)}\n${manifest.name}@${manifest.version}\nLocation: ${location}\nDeclared license: ${manifest.license || metadata.license || 'UNDECLARED'}\n`);
  for (const file of files) parts.push(`\n--- BEGIN ORIGINAL FILE: ${file.path} ---\nSHA-256: ${file.hash}\n\n`, file.text, file.text.endsWith('\n') ? '' : '\n', `--- END ORIGINAL FILE: ${file.path} ---\n`);
}
const output = parts.join('');
if (Buffer.byteLength(output) > 8 * 1024 * 1024) throw Error('Complete notice inventory exceeds the output size limit.');
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== output) throw Error('Community third-party notices are out of date. Run npm run licenses:generate.');
} else {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, output, 'utf8');
}
console.log(`Community third-party notices: ${count} locked packages, complete upstream legal texts included.`);
