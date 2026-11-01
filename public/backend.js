/**
 * Storage and lookups, with two implementations behind one interface:
 *
 *   server  - when the page is served by `npm start` (server.mjs): bird details
 *             (with optional Claude / xeno-canto upgrades), sightings and
 *             recordings are stored by the local server.
 *   browser - static hosting such as GitHub Pages: details come straight from
 *             iNaturalist and Wikipedia, and sightings and recordings are kept
 *             in this browser's IndexedDB.
 */
import * as inat from './inat.js';

const SAMPLE_RATE = 48000;
const DETAILS_TTL_MS = 30 * 24 * 3600 * 1000;
const STALE_RECORDING_MS = 60_000;

export async function createBackend() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (res.ok && (await res.json()).server) return serverBackend();
  } catch { /* no server */ }
  return browserBackend();
}

/* ---------------------------------------------------------------------------
   Server
   ------------------------------------------------------------------------- */

function serverBackend() {
  const json = async res => {
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
  };
  const send = (url, method, body) => fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json);

  return {
    kind: 'server',
    birdInfo: sci => fetch(`/api/bird?sci=${encodeURIComponent(sci)}`).then(json),

    sightings: {
      list: () => fetch('/api/sightings').then(json),
      add: entry => send('/api/sightings', 'POST', entry),
      remove: id => fetch(`/api/sightings?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).then(json),
    },

    recordings: {
      list: () => fetch('/api/recordings').then(json),
      createLive: name => fetch(`/api/recordings?mode=live&name=${encodeURIComponent(name)}`, { method: 'POST' }).then(json),
      append: (id, pcm) => fetch(`/api/recordings/${id}/append`, { method: 'POST', body: pcm }).then(json),
      finish: (id, body) => send(`/api/recordings/${id}/finish`, 'POST', body),
      patch: (id, body) => send(`/api/recordings/${id}`, 'PATCH', body),
      remove: id => fetch(`/api/recordings/${id}`, { method: 'DELETE' }).then(json),
      audioUrl: async r => `/api/recordings/${r.id}/audio`,
      releaseUrl: () => {},
      download: r => clickLink(`/api/recordings/${r.id}/audio?download`),

      upload(file, name, type, onProgress) {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `/api/recordings?name=${encodeURIComponent(name)}`);
          xhr.setRequestHeader('Content-Type', type);
          xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
          xhr.onloadend = () => (xhr.status === 201
            ? resolve(JSON.parse(xhr.responseText))
            : reject(Object.assign(new Error(`HTTP ${xhr.status}`), { status: xhr.status })));
          xhr.send(file);
        });
      },

      /** Last-chance save when the page is closing mid-recording. */
      beacon(id, pcm, detections) {
        if (pcm) navigator.sendBeacon(`/api/recordings/${id}/append`, pcm);
        navigator.sendBeacon(`/api/recordings/${id}/finish`,
          new Blob([JSON.stringify({ detections })], { type: 'application/json' }));
      },
    },
  };
}

/* ---------------------------------------------------------------------------
   Browser (IndexedDB)
   ------------------------------------------------------------------------- */

function browserBackend() {
  const db = openDb();
  const getJson = async url => {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
    return res.json();
  };
  const persist = () => navigator.storage?.persist?.().catch(() => {});

  async function finalize(rec) {
    // Assemble the streamed PCM chunks into one WAV file.
    const chunks = (await idb(db, 'chunks', s => s.index('rec').getAll(rec.id))).sort((a, b) => a.seq - b.seq);
    const dataBytes = chunks.reduce((n, c) => n + c.data.byteLength, 0);
    const blob = new Blob([wavHeader(dataBytes), ...chunks.map(c => c.data)], { type: 'audio/wav' });
    await idb(db, 'audio', s => s.put({ id: rec.id, blob }), 'readwrite');
    await idb(db, 'chunks', s => {
      for (const c of chunks) s.delete(c.key);
    }, 'readwrite');
    Object.assign(rec, { status: 'ready', size: blob.size, duration: dataBytes / 2 / SAMPLE_RATE });
    await putRec(rec);
    return rec;
  }

  const getRec = id => idb(db, 'recordings', s => s.get(id));
  const putRec = rec => idb(db, 'recordings', s => s.put({ ...rec, updatedAt: Date.now() }), 'readwrite');

  return {
    kind: 'browser',

    async birdInfo(sci, commonName) {
      const cached = await idb(db, 'details', s => s.get(sci)).catch(() => null);
      if (cached && cached.version === inat.INFO_VERSION && Date.now() - cached.fetchedAt < DETAILS_TTL_MS) return cached;
      const [{ photos, taxonId }, sounds, wiki] = await Promise.all([
        inat.getPhotos(sci, getJson).catch(() => ({ photos: [], taxonId: null })),
        inat.iNatSounds(sci, getJson).catch(() => []),
        inat.getWikipedia(sci, getJson).catch(() => null),
      ]);
      const info = {
        version: inat.INFO_VERSION,
        scientificName: sci, commonName, photos, taxonId,
        sounds, soundsSource: 'inaturalist',
        facts: wiki?.extract ? { summary: wiki.extract } : null,
        factsSource: wiki?.extract ? 'wikipedia' : null,
        wikiUrl: wiki?.url ?? null,
        fetchedAt: Date.now(),
      };
      if (photos.length || sounds.length || wiki) idb(db, 'details', s => s.put(info), 'readwrite').catch(() => {});
      return info;
    },

    sightings: {
      list: async () => (await idb(db, 'sightings', s => s.getAll())).sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
      async add(entry) {
        const sighting = { id: crypto.randomUUID(), ...entry, savedAt: new Date().toISOString() };
        await idb(db, 'sightings', s => s.put(sighting), 'readwrite');
        persist();
        return sighting;
      },
      remove: id => idb(db, 'sightings', s => s.delete(id), 'readwrite').then(() => ({ removed: true })),
    },

    recordings: {
      async list() {
        const all = await idb(db, 'recordings', s => s.getAll());
        for (const r of all) {
          if (r.status === 'recording' && Date.now() - r.updatedAt > STALE_RECORDING_MS) await finalize(r);
        }
        return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      },

      async createLive(name) {
        const rec = {
          id: crypto.randomUUID(), name, source: 'live', mime: 'audio/wav', ext: 'wav',
          createdAt: new Date().toISOString(), duration: 0, size: 44, status: 'recording', detections: [], seq: 0,
        };
        await putRec(rec);
        persist();
        return rec;
      },

      async append(id, pcm, detections) {
        const rec = await getRec(id);
        if (!rec || rec.status !== 'recording') return null;
        const seq = rec.seq++;
        await idb(db, 'chunks', s => s.put({ key: `${id}:${String(seq).padStart(8, '0')}`, rec: id, seq, data: pcm }), 'readwrite');
        rec.size += pcm.byteLength;
        rec.duration = (rec.size - 44) / 2 / SAMPLE_RATE;
        if (detections) rec.detections = detections;
        await putRec(rec);
        return rec;
      },

      async finish(id, { detections }) {
        const rec = await getRec(id);
        if (!rec) return null;
        if (Array.isArray(detections)) rec.detections = detections;
        return rec.status === 'recording' ? finalize(rec) : (await putRec(rec), rec);
      },

      async patch(id, body) {
        const rec = await getRec(id);
        if (!rec) return null;
        if (typeof body.name === 'string' && body.name.trim()) rec.name = body.name.trim().slice(0, 120);
        if (Number.isFinite(body.duration) && body.duration > 0) rec.duration = body.duration;
        if (Array.isArray(body.detections)) rec.detections = body.detections;
        await putRec(rec);
        return rec;
      },

      async remove(id) {
        const chunks = await idb(db, 'chunks', s => s.index('rec').getAllKeys(id));
        await idb(db, 'chunks', s => chunks.forEach(k => s.delete(k)), 'readwrite');
        await idb(db, 'audio', s => s.delete(id), 'readwrite');
        await idb(db, 'recordings', s => s.delete(id), 'readwrite');
        return true;
      },

      async upload(file, name, type, onProgress) {
        const rec = {
          id: crypto.randomUUID(), name, source: 'upload', mime: type, ext: (file.name.split('.').pop() || 'audio').toLowerCase(),
          createdAt: new Date().toISOString(), duration: null, size: file.size, status: 'ready', detections: [],
        };
        await idb(db, 'audio', s => s.put({ id: rec.id, blob: file }), 'readwrite');
        await putRec(rec);
        onProgress(1);
        persist();
        return rec;
      },

      async audioUrl(r) {
        const row = await idb(db, 'audio', s => s.get(r.id));
        if (!row) throw new Error('Audio not found in this browser');
        return URL.createObjectURL(row.blob);
      },
      releaseUrl: url => url?.startsWith('blob:') && URL.revokeObjectURL(url),

      async download(r) {
        const url = await this.audioUrl(r);
        clickLink(url, `${r.name.replace(/[^\w .,()-]+/g, '_').trim() || 'recording'}.${r.ext}`);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      },

      // IndexedDB writes can't be guaranteed during unload; chunks already
      // flushed are kept and the recording is finalized on the next visit.
      beacon(id, pcm, detections) {
        this.append(id, pcm || new ArrayBuffer(0), detections).catch(() => {});
      },
    },
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('birdsong', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('sightings', { keyPath: 'id' });
      d.createObjectStore('recordings', { keyPath: 'id' });
      d.createObjectStore('audio', { keyPath: 'id' });
      d.createObjectStore('details', { keyPath: 'scientificName' });
      d.createObjectStore('chunks', { keyPath: 'key' }).createIndex('rec', 'rec');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Runs `fn(store)` in a transaction; resolves with the request's result (if any) once committed. */
async function idb(dbPromise, storeName, fn, mode = 'readonly') {
  const d = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = d.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function wavHeader(dataBytes) {
  const b = new DataView(new ArrayBuffer(44));
  const str = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  b.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true); // PCM
  b.setUint16(22, 1, true); // mono
  b.setUint32(24, SAMPLE_RATE, true);
  b.setUint32(28, SAMPLE_RATE * 2, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  str(36, 'data');
  b.setUint32(40, dataBytes, true);
  return b.buffer;
}

function clickLink(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  if (filename) a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}
