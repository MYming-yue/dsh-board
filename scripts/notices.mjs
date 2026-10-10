import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

export async function writeNotices(upstream, output) {
  const notices = [], visited = new Set();
  async function visit(name, parent) {
    const require = createRequire(join(parent, 'package.json'));
    let directory;
    try { directory = dirname(require.resolve(name + '/package.json')); }
    catch {
      directory = dirname(require.resolve(name));
      while (JSON.parse(await readFile(join(directory, 'package.json'), 'utf8').catch(() => '{}')).name !== name) {
        const next = dirname(directory); if (next === directory) throw new Error(`Cannot locate license for ${name}`); directory = next;
      }
    }
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const identity = `${manifest.name}@${manifest.version}`;
    if (visited.has(identity)) return;
    visited.add(identity);
    const files = (await readdir(directory, { withFileTypes: true })).filter(file => file.isFile() && /^(licen[cs]e|copying|notice)([.-].*)?$/i.test(file.name));
    if (!files.length) throw new Error(`Bundled dependency lacks a license notice: ${identity}`);
    const texts = await Promise.all(files.sort((a, b) => a.name.localeCompare(b.name)).map(file => readFile(join(directory, file.name), 'utf8')));
    notices.push(`${identity}\nLicense: ${manifest.license ?? 'See notice below'}\n\n${texts.join('\n\n')}`);
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) await visit(dependency, directory);
  }
  const manifest = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8'));
  for (const name of Object.keys(manifest.dependencies).sort()) await visit(name, upstream);
  await writeFile(output, 'Third-party notices for the embedded Draft Board runtime.\n\n' + notices.join('\n\n' + '='.repeat(72) + '\n\n'));
}
