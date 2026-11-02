// Verified sightings, stored as a JSON array on disk. The heard clips that
// backed each sighting live next to it as WAV files: data/sightings/<id>-<n>.wav.
// Only clip metadata ({ score, at }) goes into the JSON.
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

export const MAX_CLIPS = 2;
export const MAX_CLIP_BYTES = 400_000; // a 3 s, 48 kHz, 16-bit mono WAV is ~288 KB

export function createSightings(file) {
  const clipDir = join(dirname(file), 'sightings');
  const clipPath = (id, n) => join(clipDir, `${id}-${n}.wav`);
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
      const result = await fn(all);
      await save(all);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  async function removeClips(sighting) {
    await Promise.all((sighting.clips ?? []).map((_, n) => rm(clipPath(sighting.id, n), { force: true })));
  }

  return {
    list,

    /** `clips` are validated WAV buffers with their score and capture time. */
    add: (entry, clips = []) => update(async all => {
      const sighting = { id: randomUUID(), ...entry, savedAt: new Date().toISOString() };
      if (clips.length) {
        sighting.clips = clips.map(c => ({ score: c.score, at: c.at }));
        try {
          await mkdir(clipDir, { recursive: true });
          await Promise.all(clips.map((c, n) => writeFile(clipPath(sighting.id, n), c.wav)));
        } catch (err) {
          await removeClips(sighting);
          throw err;
        }
      }
      all.unshift(sighting);
      return sighting;
    }),

    remove: id => update(async all => {
      const i = all.findIndex(s => s.id === id);
      if (i < 0) return false;
      await removeClips(all[i]);
      all.splice(i, 1);
      return true;
    }),

    /** Streams clip `n` of sighting `id`; the path is built from the stored record, not the URL. */
    async serveClip(id, n, res) {
      const sighting = (await list()).find(s => s.id === id);
      if (!sighting || !Number.isInteger(n) || n < 0 || n >= (sighting.clips?.length ?? 0)) {
        res.writeHead(404).end();
        return;
      }
      const path = clipPath(sighting.id, n);
      const size = (await stat(path)).size;
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': size,
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
      await pipeline(createReadStream(path), res);
    },
  };
}
