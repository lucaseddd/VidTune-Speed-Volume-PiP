import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, mkdtemp, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

execFileSync(process.execPath, ['scripts/build.js'], { stdio: 'inherit' });
await mkdir('release', { recursive: true });
const { version } = JSON.parse(await readFile('package.json', 'utf8'));

async function zipContents(folder, archive) {
  const source = path.resolve(folder);
  const destination = path.resolve(archive);
  await rm(destination, { force: true });
  if (process.platform === 'win32') {
    const entries = await readdir(source);
    // Windows tar selects its format from the suffix and does not recognize XPI.
    // Create a ZIP first, then retain Firefox's required .xpi filename.
    const zipPath = destination.endsWith('.xpi') ? `${destination}.zip` : destination;
    if (zipPath !== destination) await rm(zipPath, { force: true });
    execFileSync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', source, ...entries], { stdio: 'inherit' });
    if (zipPath !== destination) await rename(zipPath, destination);
  } else {
    execFileSync('zip', ['-qr', destination, '.'], { cwd: source, stdio: 'inherit' });
  }
  if (!(await readFile(destination)).subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new Error(`Package is not a ZIP archive: ${archive}`);
  }
}

for (const [name, folder] of [['firefox', 'dist'], ['chromium', 'dist-chromium']]) {
  const extension = name === 'firefox' ? 'xpi' : 'zip';
  const archive = `VidTune-v${version}-${name}.${extension}`;
  await zipContents(folder, `release/${archive}`);
  console.log(`Packaged release/${archive}`);
}

const sourceFolder = await mkdtemp(path.join(tmpdir(), 'vidtune-source-'));
const excluded = new Set(['.git', 'node_modules', 'dist', 'dist-chromium', 'coverage', 'release', 'work']);
try {
  await cp('.', sourceFolder, {
    recursive: true,
    filter(source) {
      const relative = path.relative(process.cwd(), source).replaceAll('\\', '/');
      return !relative || !excluded.has(relative.split('/')[0]);
    }
  });
  const archive = `VidTune-v${version}-source.zip`;
  await zipContents(sourceFolder, `release/${archive}`);
  console.log(`Packaged release/${archive}`);
} finally {
  await rm(sourceFolder, { recursive: true, force: true });
}
