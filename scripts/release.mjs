import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {root} from './packaging.mjs';
import {main as publish} from './publish.mjs';
import {applyVersionPlan, validateBump, versionPlan} from './version.mjs';

const help = `LineBridge release helpers for Windows and macOS.

Usage: npm run release -- <command> [options]
       scripts/release.cmd <command> [options]           (Windows cmd)
       .\\scripts\\release.ps1 <command> [options]          (Windows PowerShell)
       sh scripts/release.sh <command> [options]         (macOS)

Commands:
  bump [patch|minor|major|VERSION] [--dry-run]
                      Synchronize application versions (default: patch).
                      Leaves edits for review and commit; does not tag or push.
  tag [--push] [--dry-run]
                      Tag clean, committed HEAD as v<application version>.
                      --push atomically pushes the branch and tag to origin.
                      Reuses an existing tag only when it points to HEAD.
  publish [options]   Test, build and publish packages on this host OS.
                      macOS defaults to arm64 + x64 when Rosetta is available.
                      Add --arch x64 or --arch arm64 to build only that target.
                      Add --bump patch to also bump, commit, tag and push.
                      Use publish --help for all publishing options.

All commands support --help. Dry runs do not write files, create tags, build,
push or contact GitHub. Publishing requires GitHub CLI authentication and
native build prerequisites; Windows/macOS portable packages include the tray.
`;

export function parseOptions(args) {
  const [command, ...rest] = args;
  if (!command || command === '--help') {
    if (rest.length) throw new Error('Unexpected arguments after --help.');
    return {help: true};
  }
  if (!['bump', 'tag', 'publish'].includes(command)) throw new Error(`Unknown command: ${command}. Use --help.`);
  if (command === 'publish') return {command, args: rest};
  const options = {command};
  for (const arg of rest) {
    if (['--help', '--dry-run'].includes(arg) || (command === 'tag' && arg === '--push')) options[arg.slice(2)] = true;
    else if (command === 'bump' && !arg.startsWith('-') && options.bump === undefined) options.bump = arg;
    else throw new Error(`Unexpected argument for ${command}: ${arg}. Use --help.`);
  }
  if (command === 'bump') { options.bump ??= 'patch'; validateBump(options.bump); }
  return options;
}

function command(executable, args, inherit, directory) {
  return execFileSync(executable, args, {cwd: directory, encoding: 'utf8', windowsHide: true, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']})?.trim();
}

export async function main(args = process.argv.slice(2), {
  directory = root,
  run = (executable, args, inherit) => command(executable, args, inherit, directory),
  runPublish = publish,
  log = console.log,
} = {}) {
  const options = parseOptions(args);
  if (options.help) { log(help); return; }
  if (options.command === 'publish') return runPublish(options.args, {directory, run, log});

  const versions = await versionPlan(options.command === 'bump' ? options.bump : undefined, directory);
  if (options.command === 'bump') {
    log(`Version: ${versions.current} -> ${versions.version}\nUpdate: ${versions.files.map(file => file.path).join(', ')}`);
    if (options['dry-run']) return;
    await applyVersionPlan(versions, directory);
    log('Versions updated. Review and commit the changes before running tag or publish.');
    return;
  }

  if (run('git', ['rev-parse', '--show-prefix'])) throw new Error('Release tagging requires the project at the Git repository root.');
  if (run('git', ['status', '--porcelain'])) throw new Error('Commit or stash checkout changes before tagging.');
  const head = run('git', ['rev-parse', 'HEAD']), tag = `v${versions.version}`;
  const existing = Boolean(run('git', ['tag', '--list', tag]));
  if (existing && run('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]) !== head) throw new Error(`Local tag ${tag} already points to another commit. Choose another version or check out its commit.`);
  if (options.push) {
    try { run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD']); }
    catch { throw new Error('tag --push requires a branch checkout; switch off detached HEAD first.'); }
    const remote = run('git', ['remote', 'get-url', '--push', '--all', 'origin']);
    if (!remote || /[\r\n]/.test(remote)) throw new Error('tag --push requires exactly one origin push URL.');
  }
  log(`Tag: ${tag} -> ${head}${existing ? ' (already exists)' : ''}`);
  if (!existing) log(`git tag ${tag} ${head}`);
  if (options.push) log(`git push --atomic origin HEAD refs/tags/${tag}`);
  if (options['dry-run']) return;

  async function checkCheckout() {
    if (run('git', ['rev-parse', 'HEAD']) !== head || run('git', ['status', '--porcelain'])) throw new Error('Checkout changed while preparing the tag; refusing to tag or push.');
    for (const file of versions.files) if (await readFile(join(directory, file.path), 'utf8') !== file.before) throw new Error(`${file.path} changed while preparing the tag; refusing to tag or push.`);
  }
  await checkCheckout();
  if (!existing) run('git', ['tag', tag, head]);
  if (options.push) {
    await checkCheckout();
    if (run('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]) !== head) throw new Error(`Local tag ${tag} changed; refusing to push.`);
    run('git', ['push', '--atomic', 'origin', 'HEAD', `refs/tags/${tag}`], true);
  }
  log(options.push ? `Pushed branch and ${tag} to origin.` : `${tag} marks ${head}. Use tag --push when ready to push the branch and tag.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stderr?.toString().trim() || error.message); process.exitCode = 1; });
}
