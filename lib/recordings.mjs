// Session recordings: audio files in data/recordings/ plus a JSON index.
//
// Live sessions are streamed in as 16-bit PCM chunks and written as a WAV
// whose header is patched when the session finishes (or later, if the tab
// closed mid-recording). Uploads are stored as-is.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const SAMPLE_RATE = 48000;
const MAX_UPLOAD_BYTES = 1024 ** 3; // 1 GB
const STALE_RECORDING_MS = 60_000;

const EXTENSIONS = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
};

export function createRecordings(dataDir) {
  const audioDir = join(dataDir, 'recordings');
  const indexFile = join(dataDir, 'recordings.json');
  let queue = Promise.resolve();

  async function readIndex() {
    try {
      return JSON.parse(await readFile(indexFile, 'utf8'));
    } catch {
      return [];
    }
  }

  /** Serialized read-modify-write of the index. */
  function update(fn) {
    const run = queue.then(async () => {
      const all = await readIndex();
      const result = await fn(all);
      await mkdir(dataDir, { recursive: true });
      await writeFile(`${indexFile}.tmp`, JSON.stringify(all, null, 2));
      await rename(`${indexFile}.tmp`, indexFile);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  const fileOf = rec => join(audioDir, `${rec.id}.${rec.ext}`);

  async function finalizeWav(rec) {
    const size = (await stat(fileOf(rec))).size;
    const fh = await open(fileOf(rec), 'r+');
    try {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(size - 8);
      await fh.write(b, 0, 4, 4);
      b.writeUInt32LE(size - 44);
      await fh.write(b, 0, 4, 40);
    } finally {
      await fh.close();
    }
    rec.size = size;
    rec.duration = (size - 44) / 2 / SAMPLE_RATE;
    rec.status = 'ready';
  }

  return {
    async list() {
      // Repair live sessions whose tab closed before they were finished.
      const all = await readIndex();
      if (all.some(r => r.status === 'recording' && Date.now() - r.updatedAt > STALE_RECORDING_MS)) {
        return update(async list => {
          for (const r of list) {
            if (r.status === 'recording' && Date.now() - r.updatedAt > STALE_RECORDING_MS) {
              await finalizeWav(r).catch(() => { r.status = 'ready'; });
            }
          }
          return list;
        });
      }
      return all;
    },

    async get(id) {
      return (await readIndex()).find(r => r.id === id) ?? null;
    },

    /** Starts a live WAV recording; PCM arrives later via append(). */
    async createLive(name) {
      const rec = {
        id: randomUUID(), name, source: 'live', mime: 'audio/wav', ext: 'wav',
        createdAt: new Date().toISOString(), updatedAt: Date.now(),
        duration: 0, size: 44, status: 'recording', detections: [],
      };
      await mkdir(audioDir, { recursive: true });
      await writeFile(fileOf(rec), wavHeader());
      await update(all => { all.unshift(rec); });
      return rec;
    },

    async append(id, req) {
      const rec = await this.get(id);
      if (!rec || rec.status !== 'recording') return null;
      const chunks = [];
      let total = 0;
      for await (const c of req) {
        total += c.length;
        if (total > 64 * 1024 * 1024) throw new Error('chunk too large');
        chunks.push(c);
      }
      let data = Buffer.concat(chunks);
      if (data.length % 2) data = data.subarray(0, data.length - 1);
      await appendFile(fileOf(rec), data);
      return update(all => {
        const r = all.find(x => x.id === id);
        r.updatedAt = Date.now();
        r.size = (r.size || 44) + data.length;
        r.duration = (r.size - 44) / 2 / SAMPLE_RATE;
        return r;
      });
    },

    async finish(id, { detections }) {
      return update(async all => {
        const r = all.find(x => x.id === id);
        if (!r) return null;
        if (r.status === 'recording') await finalizeWav(r);
        if (Array.isArray(detections)) r.detections = cleanDetections(detections);
        return r;
      });
    },

    async upload(name, mime, req) {
      const type = String(mime || '').split(';')[0].trim().toLowerCase();
      const ext = EXTENSIONS[type];
      if (!ext) throw Object.assign(new Error('unsupported audio type'), { status: 415 });
      const rec = {
        id: randomUUID(), name, source: 'upload', mime: type, ext,
        createdAt: new Date().toISOString(), updatedAt: Date.now(),
        duration: null, size: 0, status: 'ready', detections: [],
      };
      await mkdir(audioDir, { recursive: true });
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > MAX_UPLOAD_BYTES) req.destroy(new Error('upload too large'));
      });
      try {
        await pipeline(req, createWriteStream(fileOf(rec)));
      } catch (err) {
        await rm(fileOf(rec), { force: true });
        throw err;
      }
      rec.size = size;
      await update(all => { all.unshift(rec); });
      return rec;
    },

    async patch(id, body) {
      return update(all => {
        const r = all.find(x => x.id === id);
        if (!r) return null;
        if (typeof body.name === 'string' && body.name.trim()) r.name = body.name.trim().slice(0, 120);
        if (Number.isFinite(body.duration) && body.duration > 0) r.duration = body.duration;
        if (Array.isArray(body.detections)) r.detections = cleanDetections(body.detections);
        return r;
      });
    },

    async remove(id) {
      return update(async all => {
        const i = all.findIndex(x => x.id === id);
        if (i < 0) return false;
        await rm(fileOf(all[i]), { force: true });
        all.splice(i, 1);
        return true;
      });
    },

    /** Streams the audio, honouring Range requests so the player can seek. */
    async serveAudio(id, req, res, download) {
      const rec = await this.get(id);
      if (!rec) {
        res.writeHead(404).end();
        return;
      }
      const path = fileOf(rec);
      const size = (await stat(path)).size;
      const headers = {
        'Content-Type': rec.mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      };
      if (download) {
        const safe = rec.name.replace(/[^\w .,()-]+/g, '_').trim() || 'recording';
        headers['Content-Disposition'] = `attachment; filename="${safe}.${rec.ext}"`;
      }
      await sendFile(path, size, req, res, headers);
    },
  };
}

/** Streams a file, honouring Range requests so audio players (Safari especially) can seek. */
export async function sendFile(path, size, req, res, headers) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    await pipeline(createReadStream(path, { start, end }), res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    await pipeline(createReadStream(path), res);
  }
}

function wavHeader() {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36, 4); // patched on finish
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(SAMPLE_RATE, 24);
  b.writeUInt32LE(SAMPLE_RATE * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(0, 40); // patched on finish
  return b;
}

function cleanDetections(list) {
  return list.slice(0, 20000).flatMap(d => {
    const start = Number(d.start);
    const end = Number(d.end);
    const confidence = Number(d.confidence);
    if (!Number.isFinite(start) || !Number.isFinite(end) || typeof d.scientificName !== 'string') return [];
    return [{
      start, end,
      scientificName: d.scientificName.slice(0, 100),
      commonName: String(d.commonName || d.scientificName).slice(0, 100),
      confidence: Number.isFinite(confidence) ? confidence : null,
    }];
  });
}
