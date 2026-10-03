import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPlan, root, sha256} from './packaging.mjs';
import {portablePlan} from './portable.mjs';
import {npm} from './npm.mjs';

const help = `Publish local builds to GitHub Releases (never to the npm registry).

Usage: npm run publish:github -- [options]
  --kind native|desktop|portable|npm|all
                         Default: native (desktop + portable; portable on Linux)
  --repo OWNER/REPO      Default: repository selected by gh for this checkout
  --draft               Create a draft release
  --prerelease          Create a prerelease
  --notes-file PATH     Release notes for a new release (otherwise generated)
  --dry-run             Show the plan without building or contacting GitHub
  --help                Show this help

Requires gh auth login, a clean checkout, and a GitHub tag v<package version>
pointing to HEAD. Builds and tests always run before upload. Existing releases
receive new assets only; existing assets and release settings are never replaced.
`;

export function parseOptions(args) {
  const options = {kind: 'native'};
  for (let i = 0; i < args.length; i++) {
    const [key, ...parts] = args[i].split('=');
    if (['--help', '--dry-run', '--draft', '--prerelease'].includes(key) && !parts.length) {
      options[key.slice(2)] = true;
    } else if (['--kind', '--repo', '--notes-file'].includes(key)) {
      const value = parts.length ? parts.join('=') : args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
      options[key.slice(2)] = value;
    } else throw new Error(`Unknown option: ${args[i]}. Use --help.`);
  }
  if (!['native', 'desktop', 'portable', 'npm', 'all'].includes(options.kind)) throw new Error('Invalid --kind. Use native, desktop, portable, npm or all.');
  if (options.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) throw new Error('--repo must be OWNER/REPO.');
  return options;
}

export function releasePlan(kind, platform = process.platform, arch = process.arch) {
  const kinds = kind === 'native' || kind === 'all'
    ? [...(platform === 'linux' ? [] : ['desktop']), 'portable', ...(kind === 'all' ? ['npm'] : [])]
    : [kind];
  return kinds.map(type => {
    if (type === 'npm') return {type, slug: 'npm', directory: 'npm', manifest: 'package-info.json', build: 'package', test: 'test:package-cli'};
    if (type === 'desktop') {
      const plan = buildPlan(platform, arch);
      return {type, slug: `desktop-${plan.slug}`, directory: plan.slug, manifest: 'build-info.json', build: `build:${plan.name}`, test: platform === 'darwin' ? 'verify:macos' : 'test:desktop'};
    }
    const plan = portablePlan(platform, arch);
    return {type, slug: `portable-${plan.slug}`, directory: `portable/${plan.slug}`, manifest: 'build-info.json', build: 'package:portable', test: 'test:portable'};
  });
}

// Read only the manifest's current-version artifact, never a recursive release/* glob.
export async function stageAssets(plan, version, releaseRoot = join(root, 'release')) {
  const staged = [];
  const destination = join(releaseRoot, 'github', `v${version}`);
  await mkdir(destination, {recursive: true});
  for (const item of plan) {
    const source = join(releaseRoot, item.directory);
    const info = JSON.parse(await readFile(join(source, item.manifest), 'utf8'));
    const filename = info.filename ?? info.file;
    if (info.version !== version) throw new Error(`Stale ${item.slug} build: expected ${version}, got ${info.version}.`);
    if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) || !filename.includes(version)) throw new Error(`Invalid artifact filename for ${item.slug}.`);
    const digest = sha256(await readFile(join(source, filename)));
    if (digest !== info.sha256) throw new Error(`SHA-256 mismatch for ${filename}.`);
    const sums = await readFile(join(source, 'SHA256SUMS.txt'), 'utf8');
    if (sums.trim() !== `${digest}  ${filename}`) throw new Error(`Checksum manifest mismatch for ${filename}.`);
    const prefix = `LineBridge-${version}-${item.slug}`;
    const assets = [filename, `${prefix}-SHA256SUMS.txt`, `${prefix}-${item.manifest}`];
    if (assets.some(name => staged.some(path => path.endsWith(`/${name}`) || path.endsWith(`\\${name}`)))) throw new Error('Duplicate release asset names.');
    await copyFile(join(source, filename), join(destination, assets[0]));
    await writeFile(join(destination, assets[1]), `${digest}  ${filename}\n`);
    await copyFile(join(source, item.manifest), join(destination, assets[2]));
    staged.push(...assets.map(name => join(destination, name)));
  }
  return staged;
}

function command(executable, args, inherit = false) {
  return execFileSync(executable, args, {cwd: root, encoding: 'utf8', windowsHide: true, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']})?.trim();
}

export function findRelease(repo, tag, run = command) {
  try {
    return JSON.parse(run('gh', ['api', `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]));
  } catch (error) {
    // Authentication/network/server errors must not be mistaken for a new release.
    if (String(error.stderr).includes('(HTTP 404)')) return null;
    throw error;
  }
}

export function publishAssets({repo, tag, assets, existing, options}, run = command) {
  if (existing) {
    const names = assets.map(path => path.split(/[\\/]/).at(-1));
    const collisions = existing.assets.filter(asset => names.includes(asset.name));
    if (collisions.length) throw new Error(`Release assets already exist: ${collisions.map(asset => asset.name).join(', ')}. No files were replaced.`);
    run('gh', ['release', 'upload', tag, ...assets, '--repo', repo], true);
    console.log(existing.html_url);
  } else {
    run('gh', ['release', 'create', tag, ...assets, '--repo', repo, '--verify-tag', '--title', `LineBridge ${tag}`,
      ...(options.draft ? ['--draft'] : []), ...(options.prerelease ? ['--prerelease'] : []),
      ...(options['notes-file'] ? ['--notes-file', options['notes-file']] : ['--generate-notes'])], true);
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) { console.log(help); return; }
  if (options['notes-file']) options['notes-file'] = resolve(options['notes-file']);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version)) throw new Error('Unsupported package version.');
  const tag = `v${pkg.version}`, plan = releasePlan(options.kind);
  console.log(`GitHub release: ${options.repo ?? '(current repository)'} / ${tag}`);
  console.log('npm run check\nnpm test\nnpm run test:smoke');
  for (const item of plan) console.log(`npm run ${item.build}\nnpm run ${item.test}\n  Assets: release/${item.directory} (verified artifact + uniquely named checksum and metadata)`);
  console.log(`Staging: release/github/${tag}/`);
  if (options['dry-run']) return;

  command('gh', ['auth', 'status']);
  const repo = options.repo ?? command('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  if (command('git', ['status', '--porcelain'])) throw new Error('Commit or stash checkout changes before publishing.');
  const head = command('git', ['rev-parse', 'HEAD']);
  // Require an actual tag, not a branch with the same version-shaped name.
  command('gh', ['api', `repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, '--jq', '.ref']);
  const taggedCommit = command('gh', ['api', `repos/${repo}/commits/${encodeURIComponent(`refs/tags/${tag}`)}`, '--jq', '.sha']);
  if (taggedCommit !== head) throw new Error(`GitHub tag ${tag} must point to this checkout's HEAD (${head}). Push the matching version tag first.`);
  if (options['notes-file']) await readFile(options['notes-file'], 'utf8');
  const existing = findRelease(repo, tag);
  if (existing && (options.draft || options.prerelease || options['notes-file'])) throw new Error('Release creation options cannot change an existing release. Omit --draft, --prerelease and --notes-file to append assets.');
  for (const script of ['check', 'test', 'test:smoke']) npm(['run', script], {cwd: root, stdio: 'inherit'});
  for (const item of plan) {
    npm(['run', item.build], {cwd: root, stdio: 'inherit'});
    npm(['run', item.test], {cwd: root, stdio: 'inherit'});
  }
  if (command('git', ['rev-parse', 'HEAD']) !== head || command('git', ['status', '--porcelain'])) throw new Error('Checkout changed during the build; refusing to upload.');
  const assets = await stageAssets(plan, pkg.version);
  publishAssets({repo, tag, assets, existing, options});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stderr?.toString().trim() || error.message); process.exitCode = 1; });
}
