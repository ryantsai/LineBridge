import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {applyVersionPlan, nextVersion, versionPlan} from '../scripts/version.mjs';
import {versionFixture} from './version-test-utils.mjs';

test('version increments and explicit versions follow semantic version ordering', () => {
  assert.equal(nextVersion('0.6.1', 'patch'), '0.6.2');
  assert.equal(nextVersion('0.6.1', 'minor'), '0.7.0');
  assert.equal(nextVersion('0.6.1', 'major'), '1.0.0');
  assert.equal(nextVersion('0.6.1', '0.7.0-rc.1'), '0.7.0-rc.1');
  assert.equal(nextVersion('1.0.0-rc.1', 'major'), '1.0.0');
  assert.equal(nextVersion('0.7.0-rc.1', 'minor'), '0.7.0');
  assert.equal(nextVersion('0.6.2-rc.1', 'patch'), '0.6.2');
  assert.equal(nextVersion('0.6.2-rc.9', '0.6.2-rc.10'), '0.6.2-rc.10');
  assert.equal(nextVersion('0.6.2-1', '0.6.2-alpha'), '0.6.2-alpha');
  assert.equal(nextVersion('0.6.2-rc', '0.6.2-rc.1'), '0.6.2-rc.1');
  for (const bump of ['0.6.1', '0.5.9', '0.6.1-rc.1', 'banana', 'v0.6.2', '01.6.2', '0.6.2-rc.01', '0.6.2+', '0.6.2-rc..1', '0.6.2+build']) assert.throws(() => nextVersion('0.6.1', bump));
  assert.throws(() => nextVersion('9007199254740991.0.0', 'major'), /Unsupported version/);
});

test('bump synchronizes every app version and preserves dependency versions', async t => {
  const {directory, current} = await versionFixture(t);
  const plan = await versionPlan('patch', directory);
  const npmLock = plan.files.find(file => file.path === 'package-lock.json');
  const before = JSON.parse(npmLock.before), after = JSON.parse(npmLock.after);
  for (const [name, dependency] of Object.entries(before.packages)) if (name) assert.deepEqual(after.packages[name], dependency);
  await applyVersionPlan(plan, directory);
  assert.equal((await versionPlan(undefined, directory)).current, nextVersion(current, 'patch'));
  for (const file of plan.files) assert.equal(await readFile(join(directory, file.path), 'utf8'), file.after);
});

test('inconsistent versions fail before any file is changed', async t => {
  for (const path of ['server/version.mjs', 'package-lock.json', 'openapi.json']) {
    const {directory, current} = await versionFixture(t);
    const file = join(directory, path), original = await readFile(file, 'utf8');
    const altered = original.replace(current, '99.0.0');
    await writeFile(file, altered);
    await assert.rejects(versionPlan('patch', directory), /Version mismatch/);
    assert.equal(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).version, current);
    assert.equal(await readFile(file, 'utf8'), altered);
  }
});

test('a concurrent source edit is preserved and prevents the bump', async t => {
  const {directory, current} = await versionFixture(t);
  const plan = await versionPlan('minor', directory);
  await writeFile(join(directory, 'server/version.mjs'), '// user edit\n');
  await assert.rejects(applyVersionPlan(plan, directory), /changed while preparing/);
  assert.equal(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).version, current);
  assert.equal(await readFile(join(directory, 'server/version.mjs'), 'utf8'), '// user edit\n');
});
