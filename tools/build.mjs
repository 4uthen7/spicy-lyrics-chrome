#!/usr/bin/env node
/**
 * Packages the extension.
 *
 *   node tools/build.mjs              # both targets + zip of prod
 *   node tools/build.mjs --target dev # demo-enabled build for tools/e2e.mjs
 *   node tools/build.mjs --target prod --skip-zip
 *
 * prod: manifest, src/, assets/            -> dist/prod  + dist/*.zip
 * dev:  the same plus demo/ and an extra   -> dist/dev
 *       match/host permission for the local harness.
 *
 * The build fails loudly if a content script listed in the manifest is missing,
 * because a missing file silently kills the whole content-script injection.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');

const args = process.argv.slice(2);
const targetArg = args.includes('--target') ? args[args.indexOf('--target') + 1] : 'all';
const skipZip = args.includes('--skip-zip');
const targets = targetArg === 'all' ? ['prod', 'dev'] : [targetArg];

const DEMO_ORIGINS = ['http://127.0.0.1/*', 'http://localhost/*'];

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

/** Content-script JS/CSS + popup/background paths that must exist. */
function requiredFiles(manifest) {
  const files = new Set();
  for (const entry of manifest.content_scripts || []) {
    for (const f of entry.js || []) files.add(f);
    for (const f of entry.css || []) files.add(f);
  }
  if (manifest.background && manifest.background.service_worker) files.add(manifest.background.service_worker);
  if (manifest.action && manifest.action.default_popup) files.add(manifest.action.default_popup);
  for (const icon of Object.values(manifest.icons || {})) files.add(icon);
  return [...files];
}

async function exists(relPath) {
  try {
    const info = await stat(join(ROOT, relPath));
    return info.isFile();
  } catch {
    return false;
  }
}

function devManifest(manifest) {
  const clone = structuredClone(manifest);
  clone.name = clone.name + ' (dev)';
  clone.version = clone.version;
  clone.host_permissions = [...new Set([...(clone.host_permissions || []), ...DEMO_ORIGINS])];
  for (const entry of clone.content_scripts) {
    entry.matches = [...new Set([...(entry.matches || []), ...DEMO_ORIGINS])];
  }
  for (const war of clone.web_accessible_resources) {
    war.matches = [...new Set([...(war.matches || []), ...DEMO_ORIGINS])];
  }
  return clone;
}

async function buildTarget(target) {
  const outDir = join(DIST, target);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const base = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  const manifest = target === 'dev' ? devManifest(base) : base;

  const missing = [];
  for (const file of requiredFiles(manifest)) {
    if (!(await exists(file))) missing.push(file);
  }
  if (missing.length) {
    console.error(`\nmissing files required by manifest.json:\n  ${missing.join('\n  ')}`);
    throw new Error('build aborted: manifest references missing files');
  }

  await cp(join(ROOT, 'src'), join(outDir, 'src'), { recursive: true });
  await cp(join(ROOT, 'assets'), join(outDir, 'assets'), { recursive: true });
  if (target === 'dev') {
    await cp(join(ROOT, 'demo'), join(outDir, 'demo'), { recursive: true });
  }
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const bundle = await walk(outDir);
  const bytes = bundle.reduce((n, f) => n + f.size, 0);
  console.log(`${target}: ${bundle.length} files, ${(bytes / 1024).toFixed(1)} KiB -> ${relative(ROOT, outDir)}`);
  return { outDir, bytes, files: bundle.length };
}

async function walk(dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else acc.push({ path: full, size: (await stat(full)).size });
  }
  return acc;
}

await mkdir(DIST, { recursive: true });
const built = [];
for (const target of targets) built.push({ target, ...(await buildTarget(target)) });

if (!skipZip && targets.includes('prod')) {
  const zipPath = join(DIST, `spicy-lyrics-chrome-${pkg.version}.zip`);
  await rm(zipPath, { force: true });
  const res = spawnSync('zip', ['-r', '-X', '-q', zipPath, '.'], {
    cwd: join(DIST, 'prod'),
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error('zip failed with status ' + res.status);
  const info = await stat(zipPath);
  console.log(`zip: ${relative(ROOT, zipPath)} (${(info.size / 1024).toFixed(1)} KiB)`);
}

console.log('\nload unpacked:', relative(ROOT, join(DIST, 'prod')), '(prod) or', relative(ROOT, join(DIST, 'dev')), '(demo harness)');
