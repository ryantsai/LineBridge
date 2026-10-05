import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {root, sha256} from './packaging.mjs';
import {portablePlan} from './portable.mjs';
import {npm} from './npm.mjs';
import {applyVersionPlan, validateBump, versionPlan} from './version.mjs';

const help = `Publish local builds to GitHub Releases (never to the npm registry).

Usage: npm run publish:github -- [options]
  --kind native|portable|npm|all
                         Default: native (portable with tray on Windows/macOS)
  --arch x64|arm64       Build only the selected portable architecture
                         Default: both on macOS with Rosetta, otherwise host CPU
                         macOS only for cross-architecture builds; OS stays native
  --repo OWNER/REPO      Default: repository selected by gh for this checkout
  --bump patch|minor|major|VERSION
                         Sync versions, test/build, commit, tag and push to origin
  --draft               Create a draft release
  --prerelease          Create a prerelease
  --notes-file PATH     Release notes for a new release (otherwise generated)
  --dry-run             Show the plan without changing files or contacting GitHub
  --help                Show this help

Requires gh auth login, a clean checkout, and a GitHub tag v<package version>
pointing to HEAD (created and pushed for --bump). Bumping requires a branch and
origin pointing to the selected repository. Builds and tests run before the
release commit, tag, push and upload. Existing releases
receive new assets only; existing assets and release settings are never replaced.
Failed builds leave synchronized version edits for inspection; finish the
commit/tag/push manually and retry without --bump.
`;

export function parseOptions(args) {
  const options = {kind: 'native'};
  for (let i = 0; i < args.length; i++) {
    const [key, ...parts] = args[i].split('=');
    if (['--help', '--dry-run', '--draft', '--prerelease'].includes(key) && !parts.length) {
      options[key.slice(2)] = true;
    } else if (['--kind', '--repo', '--notes-file', '--bump', '--arch'].includes(key)) {
      const value = parts.length ? parts.join('=') : args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
      if (key === '--arch' && options.arch !== undefined) throw new Error('Specify --arch only once.');
      options[key.slice(2)] = value;
    } else throw new Error(`Unknown option: ${args[i]}. Use --help.`);
  }
  if (!['native', 'portable', 'npm', 'all'].includes(options.kind)) throw new Error('Invalid --kind. Use native, portable, npm or all.');
  if (options.arch !== undefined && !['x64', 'arm64'].includes(options.arch)) throw new Error('Invalid --arch. Use x64 or arm64.');
  if (options.arch !== undefined && options.kind === 'npm') throw new Error('--arch requires a portable distribution; use --kind portable or all.');
  if (options.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) throw new Error('--repo must be OWNER/REPO.');
  if (options.bump !== undefined) validateBump(options.bump);
  return options;
}

export function releasePlan(kind, platform = process.platform, arch = process.arch) {
  if (!['native','portable','npm','all'].includes(kind)) throw new Error('Unsupported distribution; use portable or npm.');
  if (!['win32','darwin'].includes(platform)) throw new Error('Unsupported release host. Use Windows or macOS.');
  const kinds = kind === 'native' || kind === 'all'
    ? ['portable', ...(kind === 'all' ? ['npm'] : [])]
    : [kind];
  const architectures = Array.isArray(arch) ? arch : [arch];
  return kinds.flatMap(type => {
    if (type === 'npm') return [{type, slug: 'npm', directory: 'npm', manifest: 'package-info.json', build: 'package', test: 'test:package-cli'}];
    return architectures.map(architecture => {
      const plan = portablePlan(platform, architecture);
      return {type, platform: plan.platform, arch: plan.arch, slug: `portable-${plan.slug}`, directory: `portable/${plan.slug}`, manifest: 'build-info.json', build: 'package:portable', test: 'test:portable'};
    });
  });
}

export function hasRosetta(platform = process.platform, {run = execFileSync} = {}) {
  if (platform !== 'darwin') return false;
  const options = {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000};
  try {
    // Check the hardware even when Node itself is running under Rosetta.
    if (String(run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], options)).trim() !== '1') return false;
    run('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], options);
    return true;
  } catch {
    return false;
  }
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
    if (item.type === 'portable') {
      const target = portablePlan(item.platform, item.arch);
      if (info.platform !== item.platform || info.architecture !== item.arch || filename !== `LineBridge-${version}-${target.slug}.${target.extension}`) throw new Error(`Portable target mismatch for ${item.slug}: expected ${item.platform}/${item.arch}.`);
    }
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

function command(executable, args, inherit = false, directory = root) {
  return execFileSync(executable, args, {cwd: directory, encoding: 'utf8', windowsHide: true, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']})?.trim();
}

export function githubTagCommit(repo, tag, run = command) {
  try {
    // Require an actual tag, not a branch with the same version-shaped name.
    run('gh', ['api', `repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, '--jq', '.ref']);
  } catch (error) {
    if (String(error.stderr).includes('(HTTP 404)')) return null;
    throw error;
  }
  return run('gh', ['api', `repos/${repo}/commits/${encodeURIComponent(`refs/tags/${tag}`)}`, '--jq', '.sha']);
}

export function checkBumpCheckout(repo, tag, run = command) {
  try { run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD']); }
  catch { throw new Error('--bump requires a branch checkout; switch off detached HEAD first.'); }
  const remote = run('git', ['remote', 'get-url', '--push', '--all', 'origin']);
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)\/?$/.exec(remote.replace(/\.git$/, ''));
  if (!match || match[1].toLowerCase() !== repo.toLowerCase()) throw new Error(`--bump requires origin to have one push URL pointing to ${repo}.`);
  if (run('git', ['tag', '--list', tag])) throw new Error(`Local tag ${tag} already exists. Choose another version or publish its checkout without --bump.`);
  // Fail before modifying files if Git cannot create the release commit.
  run('git', ['var', 'GIT_AUTHOR_IDENT']);
  run('git', ['var', 'GIT_COMMITTER_IDENT']);
}

async function checkPreparedCheckout(versions, head, directory, run) {
  const changed = run('git', ['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean).sort();
  const expected = versions.files.map(file => file.path).sort();
  if (run('git', ['rev-parse', 'HEAD']) !== head || JSON.stringify(changed) !== JSON.stringify(expected) || run('git', ['ls-files', '--others', '--exclude-standard'])) throw new Error('Checkout changed during the build; refusing to commit or publish.');
  for (const file of versions.files) if (await readFile(join(directory, file.path), 'utf8') !== file.after) throw new Error(`${file.path} changed during the build; refusing to commit or publish.`);
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

export async function main(args = process.argv.slice(2), {
  directory = root,
  run = (executable, args, inherit) => command(executable, args, inherit, directory),
  runNpm = npm,
  log = console.log,
  platform = process.platform,
  arch = process.arch,
  detectRosetta = hasRosetta,
} = {}) {
  const options = parseOptions(args);
  if (options.help) { console.log(help); return; }
  if (options['notes-file']) options['notes-file'] = resolve(options['notes-file']);
  const versions = await versionPlan(options.bump, directory);
  const architectures = options.arch === undefined && options.kind !== 'npm' && platform === 'darwin' && detectRosetta(platform)
    ? ['arm64', 'x64'] : [options.arch ?? arch];
  const tag = `v${versions.version}`, plan = releasePlan(options.kind, platform, architectures);
  log(`GitHub release: ${options.repo ?? '(current repository)'} / ${tag}`);
  if (options.bump) log(`Version: ${versions.current} -> ${versions.version}\nUpdate: ${versions.files.map(file => file.path).join(', ')}`);
  log('npm run check\nnpm test\nnpm run test:smoke');
  for (const item of plan) {
    const suffix = item.type === 'portable' ? ` -- --arch ${item.arch}` : '';
    log(`npm run ${item.build}${suffix}\nnpm run ${item.test}${suffix}\n  Assets: release/${item.directory} (verified artifact + uniquely named checksum and metadata)`);
  }
  log(`Staging: release/github/${tag}/`);
  if (options.bump) log(`After verification: git add <version files>\ngit commit -m "Release ${tag}"\ngit tag ${tag}\ngit push --atomic origin HEAD refs/tags/${tag}`);
  if (options['dry-run']) return;

  run('gh', ['auth', 'status']);
  const repo = options.repo ?? run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  if (run('git', ['status', '--porcelain'])) throw new Error('Commit or stash checkout changes before publishing.');
  let head = run('git', ['rev-parse', 'HEAD']);
  if (options.bump) checkBumpCheckout(repo, tag, run);
  const taggedCommit = githubTagCommit(repo, tag, run);
  if (options.bump && taggedCommit) throw new Error(`GitHub tag ${tag} already exists. Choose another version.`);
  if (!options.bump && taggedCommit !== head) throw new Error(`GitHub tag ${tag} must point to this checkout's HEAD (${head}). Push the matching version tag first.`);
  if (options['notes-file']) await readFile(options['notes-file'], 'utf8');
  const existing = findRelease(repo, tag, run);
  if (options.bump && existing) throw new Error(`GitHub release ${tag} already exists. Choose another version.`);
  if (existing && (options.draft || options.prerelease || options['notes-file'])) throw new Error('Release creation options cannot change an existing release. Omit --draft, --prerelease and --notes-file to append assets.');
  if (options.bump) await applyVersionPlan(versions, directory);
  for (const script of ['check', 'test', 'test:smoke']) await runNpm(['run', script], {cwd: directory, stdio: 'inherit'});
  for (const item of plan) {
    const targetArgs = item.type === 'portable' ? ['--', '--arch', item.arch] : [];
    await runNpm(['run', item.build, ...targetArgs], {cwd: directory, stdio: 'inherit'});
    await runNpm(['run', item.test, ...targetArgs], {cwd: directory, stdio: 'inherit'});
  }
  const assets = await stageAssets(plan, versions.version, join(directory, 'release'));
  if (options.bump) {
    await checkPreparedCheckout(versions, head, directory, run);
    run('git', ['add', '--', ...versions.files.map(file => file.path)]);
    run('git', ['commit', '-m', `Release ${tag}`], true);
    const committed = run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').filter(Boolean).sort();
    if (run('git', ['rev-parse', 'HEAD^']) !== head || JSON.stringify(committed) !== JSON.stringify(versions.files.map(file => file.path).sort()) || run('git', ['status', '--porcelain'])) throw new Error('Checkout changed during the release commit; refusing to push or upload.');
    head = run('git', ['rev-parse', 'HEAD']);
    // Hooks must not silently change the version files that were built and tested.
    for (const file of versions.files) if (await readFile(join(directory, file.path), 'utf8') !== file.after) throw new Error(`${file.path} changed during the release commit; refusing to push or upload.`);
    run('git', ['tag', tag]);
    run('git', ['push', '--atomic', 'origin', 'HEAD', `refs/tags/${tag}`], true);
    if (githubTagCommit(repo, tag, run) !== head) throw new Error(`GitHub tag ${tag} does not match the release commit; refusing to upload.`);
  }
  if (run('git', ['rev-parse', 'HEAD']) !== head || run('git', ['status', '--porcelain'])) throw new Error('Checkout changed during the build; refusing to upload.');
  publishAssets({repo, tag, assets, existing, options}, run);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stderr?.toString().trim() || error.message); process.exitCode = 1; });
}
