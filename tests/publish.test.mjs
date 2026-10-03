import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {parseOptions, releasePlan, stageAssets, findRelease, publishAssets, main, githubTagCommit} from '../scripts/publish.mjs';
import {sha256} from '../scripts/packaging.mjs';
import {removeClientFixture} from './client-test-utils.mjs';
import {nextVersion, versionPlan, VERSION_FILES} from '../scripts/version.mjs';
import {versionFixture} from './version-test-utils.mjs';

test('publish options and native platform selection', () => {
  assert.deepEqual(parseOptions(['--kind=portable', '--repo', 'owner/repo', '--dry-run']), {kind: 'portable', repo: 'owner/repo', 'dry-run': true});
  assert.equal(parseOptions(['--bump=patch']).bump, 'patch');
  assert.equal(parseOptions(['--bump', '0.7.0-rc.1']).bump, '0.7.0-rc.1');
  for (const args of [['--kind'], ['--kind', '--draft'], ['--kind=invalid'], ['--repo=x'], ['--clobber'], ['--draft=false'], ['--bump'], ['--bump', '--draft'], ['--bump=invalid']]) assert.throws(() => parseOptions(args));
  assert.deepEqual(releasePlan('native', 'win32', 'x64').map(p => p.build), ['build:windows', 'package:portable']);
  assert.deepEqual(releasePlan('native', 'linux', 'arm64').map(p => p.build), ['package:portable']);
  assert.equal(releasePlan('desktop', 'darwin', 'arm64')[0].test, 'verify:macos');
  assert.throws(() => releasePlan('desktop', 'linux', 'x64'), /Unsupported/);
  assert.throws(() => releasePlan('portable', 'win32', 'arm64'), /Unsupported/);
  assert.equal(releasePlan('all', 'darwin', 'x64').length, 3);
});

test('stage only current verified artifacts with distinct platform metadata names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linebridge-publish-'));
  try {
    const plan = releasePlan('native', 'win32', 'x64');
    for (const item of plan) {
      const source = join(directory, item.directory);
      await mkdir(source, {recursive: true});
      const filename = `LineBridge-0.6.0-${item.slug}.zip`, bytes = Buffer.from(item.slug), digest = sha256(bytes);
      await writeFile(join(source, filename), bytes);
      await writeFile(join(source, 'old-private-file.zip'), 'must not upload');
      await writeFile(join(source, item.manifest), JSON.stringify({version: '0.6.0', filename, sha256: digest}));
      await writeFile(join(source, 'SHA256SUMS.txt'), `${digest}  ${filename}\n`);
    }
    const assets = await stageAssets(plan, '0.6.0', directory);
    assert.equal(assets.length, 6);
    assert.equal(new Set(assets).size, 6);
    assert.ok(assets.every(path => !path.includes('private')));
    assert.equal(await readFile(assets[0], 'utf8'), 'desktop-windows-x64');
    await assert.rejects(stageAssets(plan, '0.7.0', directory), /Stale/);
    const source = join(directory, plan[0].directory), manifest = join(source, plan[0].manifest);
    const info = JSON.parse(await readFile(manifest, 'utf8'));
    await writeFile(join(source, 'SHA256SUMS.txt'), 'invalid checksum entry');
    await assert.rejects(stageAssets(plan, '0.6.0', directory), /Checksum manifest mismatch/);
    await writeFile(join(source, info.filename), 'tampered');
    await assert.rejects(stageAssets(plan, '0.6.0', directory), /SHA-256 mismatch/);
    await writeFile(manifest, JSON.stringify({...info, filename: '../private-0.6.0.zip'}));
    await assert.rejects(stageAssets(plan, '0.6.0', directory), /Invalid artifact/);
  } finally { await removeClientFixture(directory); }
});

test('release lookup treats only HTTP 404 as a missing release', () => {
  const fail = status => () => { throw Object.assign(new Error('gh failed'), {stderr: `gh: failure (HTTP ${status})`}); };
  assert.equal(findRelease('owner/repo', 'v0.6.0', fail(404)), null);
  for (const status of [401, 403, 500]) assert.throws(() => findRelease('owner/repo', 'v0.6.0', fail(status)), /gh failed/);
});

test('new release command verifies tag and preserves notes paths without shell interpolation', () => {
  const calls = [];
  publishAssets({repo: 'owner/repo', tag: 'v0.6.0', assets: ['path with spaces/app.zip'], existing: null, options: {draft: true, prerelease: true, 'notes-file': 'notes with spaces.md'}}, (...args) => calls.push(args));
  assert.deepEqual(calls[0], ['gh', ['release', 'create', 'v0.6.0', 'path with spaces/app.zip', '--repo', 'owner/repo', '--verify-tag', '--title', 'LineBridge v0.6.0', '--draft', '--prerelease', '--notes-file', 'notes with spaces.md'], true]);
});

test('append assets without overwriting files or changing existing release metadata', () => {
  const calls = [], existing = {assets: [{name: 'windows.zip'}], html_url: 'https://github.com/owner/repo/releases/tag/v0.6.0'};
  const request = {repo: 'owner/repo', tag: 'v0.6.0', assets: ['C:\\staged\\windows.zip'], existing, options: {}};
  assert.throws(() => publishAssets(request, (...args) => calls.push(args)), /already exist/);
  assert.equal(calls.length, 0);
  publishAssets({...request, assets: ['/staged/macos.dmg']}, (...args) => calls.push(args));
  assert.deepEqual(calls[0][1], ['release', 'upload', 'v0.6.0', '/staged/macos.dmg', '--repo', 'owner/repo']);
});

async function publishFixture(t) {
  const {directory, current} = await versionFixture(t);
  const git = args => execFileSync('git', args, {cwd: directory, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git(['init', '-b', 'release-test']);
  git(['config', 'user.name', 'Release Test']);
  git(['config', 'user.email', 'release@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'tag.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'core.hooksPath', '.git/empty-hooks']);
  await writeFile(join(directory, '.gitignore'), 'release/\n');
  git(['add', '.']);
  git(['commit', '-m', 'Initial fixture']);
  git(['remote', 'add', 'origin', 'https://github.com/example/linebridge.git']);
  const initial = git(['rev-parse', 'HEAD']);
  const state = {calls: [], scripts: [], output: [], remoteTag: null, release: null};
  const notFound = () => { throw Object.assign(new Error('Not Found'), {stderr: 'gh: Not Found (HTTP 404)'}); };
  const run = (executable, args) => {
    state.calls.push([executable, args]);
    if (executable === 'git') {
      if (args[0] === 'push') {
        if (state.failPush) throw new Error('synthetic push failure');
        state.remoteTag = state.wrongRemoteTag ? 'unexpected-sha' : git(['rev-parse', args.at(-1)]);
        return '';
      }
      if (args[0] === 'commit' && state.changeDuringCommit) {
        // Simulate a hook staging extra content into the release commit.
        writeFileSync(join(directory, '.gitignore'), 'release/\n# hook edit\n');
        execFileSync('git', ['add', '.gitignore'], {cwd: directory});
      }
      return git(args);
    }
    assert.equal(executable, 'gh');
    if (args[0] === 'auth') return '';
    if (args[0] === 'repo') return 'example/linebridge';
    if (args[0] === 'api') {
      if (args[1].includes('/git/ref/tags/')) return state.remoteTag ? args[1] : notFound();
      if (args[1].includes('/commits/')) return state.remoteTag;
      if (args[1].includes('/releases/tags/')) return state.release ? JSON.stringify(state.release) : notFound();
    }
    if (args[0] === 'release') return '';
    assert.fail(`Unexpected mocked gh command: ${args.join(' ')}`);
  };
  const runNpm = async args => {
    const script = args[1];
    state.scripts.push(script);
    if (script === state.failAt) throw new Error('synthetic build failure');
    const version = (await versionPlan(undefined, directory)).current;
    if (script === 'package') {
      const out = join(directory, 'release', 'npm'), filename = `line-bridge-${version}.tgz`, bytes = Buffer.from('synthetic package'), digest = sha256(bytes);
      await mkdir(out, {recursive: true});
      await writeFile(join(out, filename), bytes);
      await writeFile(join(out, 'SHA256SUMS.txt'), `${digest}  ${filename}\n`);
      await writeFile(join(out, 'package-info.json'), JSON.stringify({version, filename, sha256: digest}));
    }
    if (script === 'test:package-cli' && state.changeDuringBuild) await writeFile(join(directory, 'unrelated.txt'), 'concurrent edit');
  };
  return {directory, current, initial, git, state, dependencies: {directory, run, runNpm, log: message => state.output.push(message)}};
}

test('bump dry-run previews the new version without git, GitHub, builds or file writes', async t => {
  const fixture = await publishFixture(t);
  await main(['--bump', 'patch', '--kind', 'npm', '--dry-run'], fixture.dependencies);
  assert.equal((await versionPlan(undefined, fixture.directory)).current, fixture.current);
  assert.deepEqual(fixture.state.calls, []);
  assert.deepEqual(fixture.state.scripts, []);
  assert.equal(fixture.git(['status', '--porcelain']), '');
  const output = fixture.state.output.join('\n');
  assert.ok(output.includes(`Version: ${fixture.current} -> ${nextVersion(fixture.current, 'patch')}`));
  assert.ok(output.includes('git push --atomic origin HEAD refs/tags/'));
  for (const file of VERSION_FILES) assert.ok(output.includes(file));
});

test('bump builds first, commits only version files, pushes atomically and verifies tag before publishing', async t => {
  const {directory, current, initial, git, state, dependencies} = await publishFixture(t);
  await main(['--bump', 'patch', '--kind', 'npm', '--draft'], dependencies);
  const version = nextVersion(current, 'patch'), head = git(['rev-parse', 'HEAD']);
  assert.notEqual(head, initial);
  assert.equal(git(['rev-parse', 'HEAD^']), initial);
  assert.equal(git(['rev-parse', `v${version}`]), head);
  assert.equal(state.remoteTag, head);
  assert.equal(git(['status', '--porcelain']), '');
  assert.deepEqual(git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').sort(), [...VERSION_FILES].sort());
  assert.equal((await versionPlan(undefined, directory)).current, version);
  assert.deepEqual(state.scripts, ['check', 'test', 'test:smoke', 'package', 'test:package-cli']);
  const push = state.calls.findIndex(([exe, args]) => exe === 'git' && args[0] === 'push');
  const upload = state.calls.findIndex(([exe, args]) => exe === 'gh' && args[0] === 'release');
  assert.deepEqual(state.calls[push][1], ['push', '--atomic', 'origin', 'HEAD', `refs/tags/v${version}`]);
  assert.ok(upload > push);
  assert.ok(state.calls.slice(push + 1, upload).some(([exe, args]) => exe === 'gh' && args[1]?.includes('/commits/')));
  assert.ok(state.calls[upload][1].includes('--draft'));
});

test('failed builds leave reviewable version edits without committing, tagging, pushing or publishing', async t => {
  const {directory, current, initial, git, state, dependencies} = await publishFixture(t);
  state.failAt = 'package';
  await assert.rejects(main(['--bump', 'minor', '--kind', 'npm'], dependencies), /synthetic build failure/);
  assert.equal((await versionPlan(undefined, directory)).current, nextVersion(current, 'minor'));
  assert.equal(git(['rev-parse', 'HEAD']), initial);
  assert.equal(git(['tag', '--list']), '');
  assert.ok(!state.calls.some(([exe, args]) => exe === 'git' && ['commit', 'tag', 'push'].includes(args[0]) && args[1] !== '--list'));
  assert.ok(!state.calls.some(([exe, args]) => exe === 'gh' && args[0] === 'release'));
});

test('dirty checkouts, detached HEAD, wrong origin and existing tags fail before version writes', async t => {
  for (const mode of ['dirty', 'detached', 'origin', 'multiple origins', 'local tag', 'remote tag', 'release']) {
    const {directory, current, git, state, dependencies} = await publishFixture(t);
    const tag = `v${nextVersion(current, 'patch')}`;
    if (mode === 'dirty') await writeFile(join(directory, 'unrelated.txt'), 'user work');
    if (mode === 'detached') git(['checkout', '--detach']);
    if (mode === 'origin') git(['remote', 'set-url', 'origin', 'git@github.com:other/repo.git']);
    if (mode === 'multiple origins') {
      git(['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/example/linebridge.git']);
      git(['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/other/repo.git']);
    }
    if (mode === 'local tag') git(['tag', tag]);
    if (mode === 'remote tag') state.remoteTag = git(['rev-parse', 'HEAD']);
    if (mode === 'release') state.release = {assets: []};
    await assert.rejects(main(['--bump', 'patch', '--kind', 'npm'], dependencies), /Commit or stash|branch checkout|push URL|already exists/);
    assert.equal((await versionPlan(undefined, directory)).current, current);
    assert.deepEqual(state.scripts, []);
  }
});

test('concurrent unrelated edits prevent the release commit and remain intact', async t => {
  const {directory, initial, git, state, dependencies} = await publishFixture(t);
  state.changeDuringBuild = true;
  await assert.rejects(main(['--bump', 'patch', '--kind', 'npm'], dependencies), /Checkout changed during the build/);
  assert.equal(git(['rev-parse', 'HEAD']), initial);
  assert.equal(await readFile(join(directory, 'unrelated.txt'), 'utf8'), 'concurrent edit');
  assert.equal(state.remoteTag, null);
});

test('failed pushes and remote tag mismatches retain the local release commit without uploading', async t => {
  for (const mode of ['failPush', 'wrongRemoteTag']) {
    const {initial, git, state, dependencies} = await publishFixture(t);
    state[mode] = true;
    await assert.rejects(main(['--bump', 'patch', '--kind', 'npm'], dependencies), /synthetic push failure|does not match the release commit/);
    assert.notEqual(git(['rev-parse', 'HEAD']), initial);
    assert.ok(git(['tag', '--list']));
    assert.ok(!state.calls.some(([exe, args]) => exe === 'gh' && args[0] === 'release'));
  }
});

test('a commit hook adding unrelated content prevents the tag, push and upload', async t => {
  const {initial, git, state, dependencies} = await publishFixture(t);
  state.changeDuringCommit = true;
  await assert.rejects(main(['--bump', 'patch', '--kind', 'npm'], dependencies), /Checkout changed during the release commit/);
  assert.notEqual(git(['rev-parse', 'HEAD']), initial);
  assert.equal(git(['tag', '--list']), '');
  assert.equal(state.remoteTag, null);
  assert.ok(!state.calls.some(([exe, args]) => exe === 'gh' && args[0] === 'release'));
});

test('publishing without bump preserves the tagged checkout and appends assets', async t => {
  const {directory, current, initial, git, state, dependencies} = await publishFixture(t);
  state.remoteTag = initial;
  state.release = {assets: [], html_url: 'https://github.com/example/linebridge/releases'};
  await main(['--kind', 'npm'], dependencies);
  assert.equal((await versionPlan(undefined, directory)).current, current);
  assert.equal(git(['rev-parse', 'HEAD']), initial);
  assert.ok(!state.calls.some(([exe, args]) => exe === 'git' && ['add', 'commit', 'tag', 'push'].includes(args[0])));
  assert.ok(state.calls.some(([exe, args]) => exe === 'gh' && args[0] === 'release' && args[1] === 'upload'));
});

test('tag lookup only treats a missing ref as absent; other API errors abort', () => {
  for (const status of [401, 403, 500]) assert.throws(() => githubTagCommit('owner/repo', 'v1.0.0', () => { throw Object.assign(new Error('gh failed'), {stderr: `HTTP error (HTTP ${status})`}); }), /gh failed/);
  let calls = 0;
  assert.throws(() => githubTagCommit('owner/repo', 'v1.0.0', () => { if (!calls++) return 'refs/tags/v1.0.0'; throw Object.assign(new Error('commit lookup failed'), {stderr: '(HTTP 404)'}); }), /commit lookup failed/);
});
