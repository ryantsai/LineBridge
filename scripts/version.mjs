import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {root} from './packaging.mjs';

export const VERSION_FILES = ['package.json', 'package-lock.json', 'server/version.mjs', 'openapi.json'];

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match || match.slice(1, 4).some(n => !Number.isSafeInteger(Number(n))) || match[4]?.split('.').some(n => /^0\d+$/.test(n))) throw new Error(`Unsupported version: ${version}. Use MAJOR.MINOR.PATCH with an optional prerelease suffix.`);
  return {numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? []};
}

export function validateBump(bump) {
  if (!['patch', 'minor', 'major'].includes(bump)) parseVersion(bump);
}

function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return Math.sign(a.numbers[i] - b.numbers[i]);
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return Number(x !== undefined) - Number(y !== undefined);
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (xn && x.length !== y.length) return Math.sign(x.length - y.length);
    return x < y ? -1 : 1;
  }
  return 0;
}

export function nextVersion(current, bump) {
  const {numbers: [major, minor, patch], pre} = parseVersion(current);
  validateBump(bump);
  const version = bump === 'major' ? `${major + Number(minor > 0 || patch > 0 || !pre.length)}.0.0`
    : bump === 'minor' ? `${major}.${minor + Number(patch > 0 || !pre.length)}.0`
    : bump === 'patch' ? `${major}.${minor}.${patch + Number(!pre.length)}` : bump;
  if (compareVersions(version, current) <= 0) throw new Error(`New version ${version} must be greater than ${current}.`);
  return version;
}

export async function versionPlan(bump, directory = root) {
  const sources = await Promise.all(VERSION_FILES.map(path => readFile(join(directory, path), 'utf8')));
  const current = JSON.parse(sources[0]).version;
  parseVersion(current);
  const version = bump === undefined ? current : nextVersion(current, bump);
  function check(value, path) {
    if (value !== current) throw new Error(`Version mismatch in ${path}: expected ${current}, got ${value}. Synchronize versions before publishing.`);
  }
  function replaceVersion(text, pattern, path) {
    let matches = 0;
    const result = text.replace(pattern, (_, prefix, value, suffix) => { matches++; check(value, path); return `${prefix}${version}${suffix}`; });
    if (matches !== 1) throw new Error(`Expected one application version in ${path}.`);
    return result;
  }
  const files = VERSION_FILES.map((path, index) => {
    const before = sources[index];
    let after;
    if (path.endsWith('.json')) {
      const data = JSON.parse(before);
      const targets = path === 'package-lock.json' ? [data, data.packages?.['']] : path === 'openapi.json' ? [data.info] : [data];
      for (const target of targets) { check(target?.version, path); target.version = version; }
      after = version === current ? before : JSON.stringify(data, null, 2) + '\n';
    } else if (path === 'server/version.mjs') {
      after = replaceVersion(before, /(export\s+const\s+VERSION\s*=\s*['"])([^'"]+)(['"])/g, path);
    }
    return {path, before, after};
  });
  return {current, version, files};
}

export async function applyVersionPlan(plan, directory = root) {
  // Validate every source before writing; restore attempted writes on an I/O error.
  for (const file of plan.files) if (await readFile(join(directory, file.path), 'utf8') !== file.before) throw new Error(`${file.path} changed while preparing the version bump.`);
  const attempted = [];
  try {
    for (const file of plan.files) { attempted.push(file); await writeFile(join(directory, file.path), file.after); }
  } catch (error) {
    const restored = await Promise.allSettled(attempted.map(file => writeFile(join(directory, file.path), file.before)));
    const failures = restored.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError([error, ...failures], 'Version update failed; some files could not be restored. Check the checkout before retrying.');
    throw error;
  }
}
