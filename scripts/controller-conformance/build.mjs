import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'tsup';
import { measureSubject, schemaPaths, subjectPath } from './artifact.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
function revision(destination) {
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const head = git(['rev-parse', 'HEAD']);
  const outputPath = relative(repo, destination);
  const paths = ['.'];
  if (outputPath && !isAbsolute(outputPath) && outputPath !== '..' && !outputPath.startsWith('..' + sep)) {
    paths.push(':(exclude,literal)' + outputPath.split(sep).join('/'));
  }
  return git(['status', '--porcelain', '--untracked-files=normal', '--', ...paths]) ? head + '-dirty' : head;
}
async function build(destination) {
  const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const source = revision(destination);
  const runtime = join(destination, 'runtime');
  mkdirSync(destination);
  try {
    for (const path of schemaPaths) {
      const installed = require.resolve('threadloop-contracts/assets/' + path.slice('docs/contracts/'.length));
      mkdirSync(dirname(join(runtime, path)), { recursive: true });
      copyFileSync(installed, join(runtime, path));
    }
    const bundleDirectory = dirname(join(runtime, subjectPath));
    await bundle({
      entry: ['scripts/controller-conformance/subject.ts'],
      bundle: true,
      platform: 'node',
      format: ['esm'],
      target: 'node22',
      metafile: true,
      noExternal: [/.*/],
      splitting: false,
      config: false,
      silent: true,
      outDir: bundleDirectory,
      outExtension: () => ({ js: '.mjs' }),
      banner: { js: "const require = (await import('node:module')).createRequire(import.meta.url);" },
      define: {
        THREADLOOP_SUBJECT_REVISION: JSON.stringify(source),
        THREADLOOP_SUBJECT_VERSION: JSON.stringify(version),
      },
    });
    renameSync(join(bundleDirectory, 'metafile-esm.json'), join(destination, 'build-metafile.json'));
    if (revision(destination) !== source)
      throw new Error('The source revision changed during the build. Repeat from a stable checkout.');
    const { manifest, identity } = measureSubject(runtime, version, source);
    const writeJson = (name, value) =>
      writeFileSync(join(destination, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    writeJson('manifest.json', manifest);
    writeJson('identity.json', identity);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
try {
  const [flag, directory, ...rest] = process.argv.slice(2);
  if (flag !== '--output' || !directory || rest.length)
    throw new Error('Usage: node scripts/controller-conformance/build.mjs --output <fresh-directory>');
  const destination = resolve(directory);
  process.chdir(repo);
  await build(destination);
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
