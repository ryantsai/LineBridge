import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {main, parseOptions} from '../scripts/release.mjs';
import {root} from '../scripts/packaging.mjs';
import {nextVersion, versionPlan} from '../scripts/version.mjs';
import {versionFixture} from './version-test-utils.mjs';
import {removeClientFixture} from './client-test-utils.mjs';

test('release helper commands validate arguments and preserve publisher options', () => {
  assert.deepEqual(parseOptions([]), {help: true});
  assert.deepEqual(parseOptions(['bump']), {command: 'bump', bump: 'patch'});
  assert.deepEqual(parseOptions(['bump', 'minor', '--dry-run']), {command: 'bump', bump: 'minor', 'dry-run': true});
  assert.deepEqual(parseOptions(['tag', '--push']), {command: 'tag', push: true});
  const args = ['--bump', 'patch', '--notes-file', 'notes with spaces.md', '--dry-run'];
  assert.deepEqual(parseOptions(['publish', ...args]), {command: 'publish', args});
  for (const args of [['unknown'], ['--help', 'extra'], ['bump', 'banana'], ['bump', 'patch', 'minor'], ['bump', '--push'], ['tag', 'v1.0.0'], ['tag', '--force'], ['tag', '--push=false']]) assert.throws(() => parseOptions(args));
});

test('standalone bump previews without writes, then leaves synchronized edits without Git', async t => {
  const {directory, current} = await versionFixture(t);
  const log = [], dependencies = {directory, log: message => log.push(message), run: () => assert.fail('Bump must not run Git or GitHub commands')};
  await main(['bump', 'minor', '--dry-run'], dependencies);
  assert.equal((await versionPlan(undefined, directory)).current, current);
  assert.ok(log.join('\n').includes(`${current} -> ${nextVersion(current, 'minor')}`));
  await main(['bump', 'minor'], dependencies);
  assert.equal((await versionPlan(undefined, directory)).current, nextVersion(current, 'minor'));
});

test('publish forwards options and dependency context to the existing publisher', async t => {
  const {directory} = await versionFixture(t);
  const args = ['--bump', 'patch', '--kind', 'portable', '--arch', 'x64', '--notes-file', 'notes with spaces.md', '--dry-run'];
  const run = () => assert.fail('No commands expected');
  let calls = 0;
  await main(['publish', ...args], {directory, run, log: () => {}, runPublish: async (received, dependencies) => {
    calls++;
    assert.deepEqual(received, args);
    assert.equal(dependencies.directory, directory);
    assert.equal(dependencies.run, run);
  }});
  assert.equal(calls, 1);
  await main(['publish', '--bump', 'patch', '--kind', 'npm', '--dry-run'], {directory, run, log: () => {}});
});

async function gitFixture(t) {
  const {directory, current} = await versionFixture(t);
  const git = args => execFileSync('git', args, {cwd: directory, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git(['init', '-b', 'release-test']);
  for (const [name, value] of [['user.name', 'Release Test'], ['user.email', 'release@example.invalid'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.hooksPath', '.git/empty-hooks']]) git(['config', name, value]);
  git(['add', '.']);
  git(['commit', '-m', 'Initial fixture']);
  const remote = await mkdtemp(join(tmpdir(), 'linebridge-release-origin-'));
  t.after(() => removeClientFixture(remote));
  git(['init', '--bare', remote]);
  git(['remote', 'add', 'origin', remote]);
  const calls = [], head = git(['rev-parse', 'HEAD']);
  const dependencies = {directory, log: () => {}, run: (executable, args) => {
    assert.equal(executable, 'git');
    calls.push(args);
    return git(args);
  }};
  return {directory, current, git, remote, head, calls, dependencies};
}

test('tag dry-run creates no tag or remote refs; tag --push atomically marks committed HEAD', async t => {
  const {current, git, remote, head, calls, dependencies} = await gitFixture(t);
  const tag = `v${current}`;
  await main(['tag', '--push', '--dry-run'], dependencies);
  assert.equal(git(['tag', '--list']), '');
  assert.ok(!calls.some(args => args[0] === 'push'));
  assert.equal(git(['--git-dir', remote, 'for-each-ref', '--format=%(refname)']), '');
  await main(['tag', '--push'], dependencies);
  assert.equal(git(['rev-parse', `refs/tags/${tag}^{commit}`]), head);
  assert.equal(git(['--git-dir', remote, 'rev-parse', `refs/tags/${tag}^{commit}`]), head);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/release-test']), head);
  assert.deepEqual(calls.find(args => args[0] === 'push'), ['push', '--atomic', 'origin', 'HEAD', `refs/tags/${tag}`]);
  assert.equal(git(['status', '--porcelain']), '');
  await main(['tag', '--push'], dependencies);
  assert.equal(calls.filter(args => args[0] === 'tag' && args[1] !== '--list').length, 1);
});

test('tag refuses uncommitted versions, untracked files, version mismatches and conflicting tags', async t => {
  for (const mode of ['bump', 'untracked', 'mismatch', 'conflict']) {
    const {directory, current, git, head, dependencies} = await gitFixture(t);
    const tag = `v${current}`;
    if (mode === 'bump') await main(['bump'], dependencies);
    if (mode === 'untracked') await writeFile(join(directory, 'user work.txt'), 'Keep this edit');
    if (mode === 'mismatch') {
      await writeFile(join(directory, 'server/version.mjs'), 'export const VERSION = "99.0.0";\n');
      git(['add', '.']); git(['commit', '-m', 'Inconsistent fixture']);
    }
    if (mode === 'conflict') {
      git(['tag', tag]);
      git(['commit', '--allow-empty', '-m', 'Later commit']);
    }
    await assert.rejects(main(['tag'], dependencies), /Commit or stash|Version mismatch|another commit/);
    assert.equal(git(['tag', '--list']), mode === 'conflict' ? tag : '');
    if (mode === 'conflict') assert.equal(git(['rev-parse', tag]), head);
    if (mode === 'untracked') assert.equal(await readFile(join(directory, 'user work.txt'), 'utf8'), 'Keep this edit');
  }
});

test('push preflight rejects detached HEAD and missing or multiple origin URLs before creating a tag', async t => {
  for (const mode of ['detached', 'missing', 'multiple']) {
    const {git, remote, dependencies} = await gitFixture(t);
    if (mode === 'detached') git(['checkout', '--detach']);
    if (mode === 'missing') git(['remote', 'remove', 'origin']);
    if (mode === 'multiple') {
      git(['remote', 'set-url', '--add', '--push', 'origin', remote]);
      git(['remote', 'set-url', '--add', '--push', 'origin', `${remote}-other`]);
    }
    await assert.rejects(main(['tag', '--push'], dependencies), /branch checkout|No such remote|one origin push URL/);
    assert.equal(git(['tag', '--list']), '');
  }
});

test('failed pushes keep the local tag so tag --push can be retried', async t => {
  const {current, git, head, dependencies} = await gitFixture(t);
  const run = (executable, args) => {
    if (args[0] === 'push') throw new Error('Synthetic push failure');
    return dependencies.run(executable, args);
  };
  await assert.rejects(main(['tag', '--push'], {...dependencies, run}), /Synthetic push failure/);
  assert.equal(git(['rev-parse', `v${current}`]), head);
  await main(['tag', '--push'], dependencies);
});

test('an existing remote tag prevents both branch and tag updates in the atomic push', async t => {
  const {current, git, head, remote, dependencies} = await gitFixture(t);
  const tag = `v${current}`;
  git(['tag', tag]);
  git(['push', 'origin', 'HEAD', `refs/tags/${tag}`]);
  git(['tag', '--delete', tag]);
  git(['commit', '--allow-empty', '-m', 'Later release commit']);
  const later = git(['rev-parse', 'HEAD']);
  await assert.rejects(main(['tag', '--push'], dependencies), /failed|already exists/);
  assert.equal(git(['rev-parse', tag]), later);
  assert.equal(git(['--git-dir', remote, 'rev-parse', `refs/tags/${tag}`]), head);
  assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/release-test']), head);
});

test('concurrent checkout edits prevent tag creation and remain intact', async t => {
  const {git, dependencies} = await gitFixture(t);
  let heads = 0;
  const run = (executable, args) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD' && ++heads === 2) git(['commit', '--allow-empty', '-m', 'Concurrent commit']);
    return dependencies.run(executable, args);
  };
  await assert.rejects(main(['tag'], {...dependencies, run}), /Checkout changed/);
  assert.equal(git(['tag', '--list']), '');
  assert.equal(git(['log', '-1', '--format=%s']), 'Concurrent commit');
});

test('native shell launchers preserve argument boundaries, working directory and failure exit codes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linebridge-release shell '));
  t.after(() => removeClientFixture(directory));
  const caller = join(directory, 'caller'), scripts = join(directory, 'scripts with spaces');
  await mkdir(caller); await mkdir(scripts);
  // A disposable driver lets us inspect arguments without publishing or altering this checkout.
  await writeFile(join(scripts, 'release.mjs'), 'console.log(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()})); process.exitCode = process.argv.includes("--fail") ? 17 : 0;\n');
  for (const name of ['release.ps1', 'release.cmd', 'release.sh']) await copyFile(join(root, 'scripts', name), join(scripts, name));
  const invocations = process.platform === 'win32' ? [
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(scripts, 'release.ps1'), 'publish', '--notes-file', 'notes with spaces.md']],
    ['cmd.exe', ['/d', '/s', '/c', `""${join(scripts, 'release.cmd')}" publish --notes-file "notes with spaces.md""`]],
  ] : [['sh', [join(scripts, 'release.sh'), 'publish', '--notes-file', 'notes with spaces.md']]];
  for (const [executable, args] of invocations) {
    const spawnOptions = {cwd: caller, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: executable === 'cmd.exe'};
    const result = spawnSync(executable, args, spawnOptions);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.args, ['publish', '--notes-file', 'notes with spaces.md']);
    assert.equal(await realpath(output.cwd), await realpath(caller));
    const failureArgs = executable === 'cmd.exe' ? [...args.slice(0, -1), args.at(-1).slice(0, -1) + ' --fail"'] : [...args, '--fail'];
    const failure = spawnSync(executable, failureArgs, spawnOptions);
    assert.equal(failure.status, 17, failure.stderr || failure.error?.message);
  }
});
