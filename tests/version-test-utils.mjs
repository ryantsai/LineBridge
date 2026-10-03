import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {versionPlan} from '../scripts/version.mjs';
import {removeClientFixture} from './client-test-utils.mjs';

export async function versionFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'linebridge-version-'));
  t.after(() => removeClientFixture(directory));
  const plan = await versionPlan();
  for (const file of plan.files) {
    await mkdir(dirname(join(directory, file.path)), {recursive: true});
    await writeFile(join(directory, file.path), file.before);
  }
  return {directory, current: plan.current};
}
