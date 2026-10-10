import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, access, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeNotices } from './notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = resolve(root, '.upstream/draft-board');
const lock = JSON.parse(await readFile(join(root, 'upstream.json'), 'utf8'));
if (!/^[a-f0-9]{40}$/.test(lock.commit) || !/^https:\/\/github\.com\/[\w-]+\/[\w.-]+\.git$/.test(lock.repository)) throw new Error('Invalid upstream lock');
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const run = async (command, args, cwd = root) => {
  try {
    const result = await promisify(execFile)(command, args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    if (result.stderr.trim()) process.stderr.write(result.stderr);
    return result.stdout;
  } catch (error) { process.stdout.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); throw error; }
};
const git = args => run('git', ['-c', `safe.directory=${cache.replaceAll('\\', '/')}`, ...args], cache);
await mkdir(cache, { recursive: true });
const resolvedCache = await realpath(cache);
const resolvedBoundary = await realpath(resolve(root, '.upstream'));
if (!resolvedCache.startsWith(resolvedBoundary + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Upstream cache escaped project');
if (!await exists(join(cache, '.git'))) {
  await git(['init', '--quiet']); await git(['remote', 'add', 'origin', lock.repository]);
  await writeFile(join(cache, '.git/dsh-board-managed'), 'Build cache owned by dsh-board\n');
}
if (!await exists(join(cache, '.git/dsh-board-managed'))) throw new Error('Refusing to modify an unmanaged upstream checkout');
if ((await git(['remote', 'get-url', 'origin'])).trim() !== lock.repository) throw new Error('Upstream cache repository does not match lock');
let head = '';
try { head = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'])).trim(); } catch { /* Fresh managed cache. */ }
if (head !== lock.commit) {
  if ((await git(['status', '--porcelain'])).trim()) throw new Error('Upstream cache has local changes; preserve them before changing the lock');
  await git(['fetch', '--quiet', '--depth', '1', 'origin', lock.commit]);
  await git(['checkout', '--quiet', '--detach', lock.commit]);
}
if ((await git(['rev-parse', 'HEAD'])).trim() !== lock.commit) throw new Error('Upstream commit mismatch');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Build through npm run build so the upstream uses the same npm CLI');
const fingerprint = createHash('sha256').update(await readFile(join(cache, 'package-lock.json'))).update(`${process.versions.node.split('.')[0]}:${process.platform}:${process.arch}`).digest('hex');
const stamp = join(cache, 'node_modules/.dsh-board-lock');
let previous = '';
try { previous = await readFile(stamp, 'utf8'); } catch { /* First install. */ }
if (previous !== fingerprint || !await exists(join(cache, 'node_modules/typescript/bin/tsc'))) {
  process.stdout.write(await run(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], cache));
  await writeFile(stamp, fingerprint);
}
console.log(`Building draft-board at ${lock.commit}`);
process.stdout.write(await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'], cache));
process.stdout.write(await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.model.config.ts'], cache));
process.stdout.write(await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--base', '/api/dsh-board/ui/', '--outDir', join(root, 'lib/board-ui'), '--emptyOutDir'], cache));
await copyFile(join(cache, 'dist-model/index.js'), join(root, 'lib/model.js'));
await copyFile(join(cache, 'LICENSE'), join(root, 'lib/upstream-LICENSE'));
await copyFile(join(root, 'upstream.json'), join(root, 'lib/upstream.json'));
await writeNotices(cache, join(root, 'lib/THIRD_PARTY_NOTICES.txt'));
const bundled = await build({ entryPoints: [join(root, 'src/client.jsx')], bundle: true, write: false,
  platform: 'browser', format: 'cjs', jsx: 'automatic', target: 'es2022',
  external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'text' } });
await writeFile(join(root, 'lib/client.js'), `window.__ModuleLoader__.load({id:"dsh-board",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${bundled.outputFiles[0].text}\nreturn module.exports;}});\n`);
console.log('Standalone DSH-board build complete.');
