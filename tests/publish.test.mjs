import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseOptions, releasePlan, stageAssets, findRelease, publishAssets} from '../scripts/publish.mjs';
import {sha256} from '../scripts/packaging.mjs';
import {removeClientFixture} from './client-test-utils.mjs';

test('publish options and native platform selection', () => {
  assert.deepEqual(parseOptions(['--kind=portable', '--repo', 'owner/repo', '--dry-run']), {kind: 'portable', repo: 'owner/repo', 'dry-run': true});
  for (const args of [['--kind'], ['--kind', '--draft'], ['--kind=invalid'], ['--repo=x'], ['--clobber'], ['--draft=false']]) assert.throws(() => parseOptions(args));
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
