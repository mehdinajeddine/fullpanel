/** Offline, deterministic attribution inventory. This is not a legal compliance determination. */
import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(root, 'public/licenses/THIRD-PARTY-NOTICES.txt');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const packageFile = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const legalName = /^(?:(?:licen[sc]e|notice|copying|copyright)(?:$|[._ -])|third[-_ ]?party)/i;
const codeExtension = /\.(?:[cm]?js|jsx|tsx?|map|woff2?|ttf|otf|png|svg)$/i;
const maxFileBytes = 4 * 1024 * 1024, maxTotalBytes = 32 * 1024 * 1024;
const entries = [], skipped = [], gaps = [];

async function readBounded(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxFileBytes) throw Error(`Cannot safely include complete notice: ${relative(root, path)}`);
  const bytes = await readFile(path);
  // Reject binary or invalid UTF-8 rather than silently changing upstream legal text.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes('\0')) throw Error(`Non-text notice: ${relative(root, path)}`);
  return { path: relative(root, path).replaceAll('\\', '/'), text, sha256: sha256(bytes) };
}
async function notices(directory, depth = 0) {
  const found = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => order(a.name, b.name))) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory() && depth < 3 && entry.name !== 'node_modules') found.push(...await notices(path, depth + 1));
    else if (entry.isFile() && legalName.test(entry.name) && !codeExtension.test(entry.name)) found.push(await readBounded(path));
  }
  return found;
}
for (const [location, metadata] of Object.entries(lock.packages).sort(([a], [b]) => order(a, b))) {
  if (!location) continue;
  if (!location.startsWith('node_modules/') || location.split('/').includes('..') || location.includes('\\')) throw Error('Unexpected lockfile package location.');
  const directory = join(root, location);
  let manifest;
  try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!metadata.dev && !metadata.optional) throw Error(`Required runtime package is not installed: ${location}`);
    skipped.push(`${location}@${metadata.version} (${metadata.optional ? 'optional' : 'development'}; not installed)`);
    continue;
  }
  if (manifest.version !== metadata.version) throw Error(`Installed version differs from lockfile: ${location}`);
  const direct = location === `node_modules/${manifest.name}` && (packageFile.dependencies?.[manifest.name] || packageFile.devDependencies?.[manifest.name]);
  const entry = { location, name: manifest.name, version: manifest.version, license: manifest.license ?? manifest.licenses ?? metadata.license ?? 'UNDECLARED', scope: `${direct ? 'direct' : 'transitive'}, ${metadata.dev ? 'development/build tool' : 'runtime dependency'}`, files: await notices(directory), references: [], parent: undefined };
  if (!entry.files.length) {
    const readme = (await readdir(directory)).sort(order).find(name => /^readme(?:\.[a-z]+)?$/i.test(name));
    if (readme) {
      const original = await readBounded(join(directory, readme));
      for (const line of original.text.split('\n').filter(line => /licen[sc]e|copyright/i.test(line))) {
        for (const match of line.matchAll(/https?:\/\/[^\s)>]+/g)) entry.references.push(match[0]);
      }
      entry.references = [...new Set(entry.references)].sort(order);
    }
    const parentName = manifest.name?.startsWith('@esbuild/') ? 'esbuild' : manifest.name?.startsWith('@rollup/rollup-') ? 'rollup' : undefined;
    if (parentName) {
      const prefix = location.slice(0, location.lastIndexOf('node_modules/'));
      const parentLocation = `${prefix}node_modules/${parentName}`;
      try {
        const parent = JSON.parse(await readFile(join(root, parentLocation, 'package.json'), 'utf8'));
        if (parent.version === manifest.version && parent.optionalDependencies?.[manifest.name] === manifest.version) {
          const parentFiles = await notices(join(root, parentLocation));
          entry.parent = { name: parent.name, version: parent.version, files: parentFiles.map(file => file.path) };
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    gaps.push(`${entry.name}@${entry.version}: no license/NOTICE text file found in the installed package.`);
  }
  entries.push(entry);
}

const parts = [
  'FullPanel — third-party notices\n',
  'Generated offline by scripts/generate-third-party-notices.mjs.\n',
  'Scope: installed packages recorded in package-lock.json, including runtime dependencies and development/build tools. This is an attribution superset, not a claim that every package appears in each artifact. Optional packages absent on this build platform are listed separately.\n',
  'Original license/NOTICE text is reproduced without paraphrasing; file paths and SHA-256 hashes identify the inputs. Searches cover three directory levels and exclude nested node_modules and source-code files.\n',
  'This inventory does not establish legal compliance or authorship of FullPanel. Operating-system packages, Node.js itself, copied Docker/Compose/Buildx binaries, application images and documentary screenshots are outside this npm inventory. Their notices and distribution terms require separate review.\n',
  `Lockfile SHA-256: ${sha256(await readFile(join(root, 'package-lock.json')))}\n`,
  `Installed package entries: ${entries.length}\n`,
  '\nKnown missing upstream text files (declarations/links are not replacements for license text):\n',
  ...(gaps.length ? gaps.map(gap => `- ${gap}\n`) : ['None found within the stated search scope.\n']),
  '\nPackages not installed in this environment:\n',
  ...(skipped.length ? skipped.map(value => `- ${value}\n`) : ['None.\n']),
];
for (const entry of entries) {
  parts.push(`\n${'='.repeat(78)}\n${entry.name}@${entry.version}\nLocation: ${entry.location}\nClassification: ${entry.scope}\nDeclared license: ${typeof entry.license === 'string' ? entry.license : JSON.stringify(entry.license)}\n`);
  if (!entry.files.length) {
    parts.push('No complete license/NOTICE text file was found in this installed package.\n');
    for (const reference of entry.references) parts.push(`Licensing reference present in upstream README (not fetched): ${reference}\n`);
    if (entry.parent) parts.push(`Verified optional-dependency parent: ${entry.parent.name}@${entry.parent.version}\nParent notice files (included under that parent below; coverage is not determined here): ${entry.parent.files.join(', ') || 'none'}\n`);
  }
  for (const file of entry.files) parts.push(`\n--- BEGIN ORIGINAL FILE: ${file.path} ---\nSHA-256: ${file.sha256}\n\n`, file.text, file.text.endsWith('\n') ? '' : '\n', `--- END ORIGINAL FILE: ${file.path} ---\n`);
}
const output = parts.join('');
if (Buffer.byteLength(output) > maxTotalBytes) throw Error('Complete notice inventory exceeds the bounded output size.');
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== output) throw Error('Generated third-party notices are out of date for the installed packages.');
} else {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, output, 'utf8');
}
console.log(`Third-party notices: ${entries.length} installed package entries; ${gaps.length} missing package-level text files; ${skipped.length} absent optional/development entries.`);
for (const gap of gaps) console.warn(`Notice inventory limitation: ${gap}`);
