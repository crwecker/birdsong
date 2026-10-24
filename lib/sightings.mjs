// Verified sightings, stored as a JSON array on disk.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createSightings(file) {
  let queue = Promise.resolve(); // serialize writes

  async function list() {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return [];
    }
  }

  async function save(all) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(all, null, 2));
    await rename(`${file}.tmp`, file);
  }

  function update(fn) {
    const run = queue.then(async () => {
      const all = await list();
      const result = fn(all);
      await save(all);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    list,
    add: entry => update(all => {
      const sighting = { id: randomUUID(), ...entry, savedAt: new Date().toISOString() };
      all.unshift(sighting);
      return sighting;
    }),
    remove: id => update(all => {
      const i = all.findIndex(s => s.id === id);
      if (i >= 0) all.splice(i, 1);
      return i >= 0;
    }),
  };
}
