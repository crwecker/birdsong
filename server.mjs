// Minimal static file server. Microphone access requires a secure context,
// which browsers grant to http://localhost.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBirdInfo } from './lib/birdinfo.mjs';
import { createSightings, MAX_CLIPS, MAX_CLIP_BYTES } from './lib/sightings.mjs';
import { createRecordings } from './lib/recordings.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8080;

const birdInfo = createBirdInfo({
  cacheDir: join(ROOT, 'data/cache'),
  labelsPath: join(PUBLIC, 'models/birdnet/labels/en_us.txt'),
});

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const sightings = createSightings(join(ROOT, 'data/sightings.json'));
const recordings = createRecordings(join(ROOT, 'data'));

async function readJson(req, limit = 2_000_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw Object.assign(new Error('too large'), { status: 413 });
  }
  return body ? JSON.parse(body) : {};
}

// /api/recordings[/:id[/audio|/append|/finish]]
async function handleRecordingsApi(req, url, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(body));
  };
  const [, , , id, action] = url.pathname.split('/');
  const name = (url.searchParams.get('name') || '').slice(0, 120) || 'Recording';
  try {
    if (!id) {
      if (req.method === 'GET') return send(200, await recordings.list());
      if (req.method === 'POST' && url.searchParams.get('mode') === 'live') return send(201, await recordings.createLive(name));
      if (req.method === 'POST') return send(201, await recordings.upload(name, req.headers['content-type'], req));
      return send(405, { error: 'method not allowed' });
    }
    if (action === 'audio' && req.method === 'GET') {
      return await recordings.serveAudio(id, req, res, url.searchParams.has('download'));
    }
    let result;
    if (action === 'append' && req.method === 'POST') result = await recordings.append(id, req);
    else if (action === 'finish' && req.method === 'POST') result = await recordings.finish(id, await readJson(req));
    else if (!action && req.method === 'PATCH') result = await recordings.patch(id, await readJson(req));
    else if (!action && req.method === 'DELETE') result = await recordings.remove(id);
    else return send(405, { error: 'method not allowed' });
    return result ? send(200, result) : send(404, { error: 'not found' });
  } catch (err) {
    if (res.headersSent) return res.destroy();
    send(err.status || 500, { error: err.message });
  }
}

async function handleSightingsApi(req, url, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(body));
  };
  const clip = /^\/api\/sightings\/([\w-]+)\/clips\/(\d+)$/.exec(url.pathname);
  if (clip && req.method === 'GET') return sightings.serveClip(clip[1], Number(clip[2]), res);
  if (url.pathname !== '/api/sightings') return send(404, { error: 'not found' });
  if (req.method === 'GET') return send(200, await sightings.list());
  if (req.method === 'DELETE') return send(200, { removed: await sightings.remove(url.searchParams.get('id')) });
  if (req.method !== 'POST') return send(405, { error: 'method not allowed' });

  let b;
  try {
    // Clips arrive base64-encoded: up to MAX_CLIPS WAVs plus a little metadata.
    b = await readJson(req, Math.ceil(MAX_CLIPS * MAX_CLIP_BYTES * 4 / 3) + 10_000);
  } catch (err) {
    return send(err.status || 400, { error: err.message });
  }
  const info = await birdInfo.species(b.scientificName);
  if (!info) return send(400, { error: 'unknown species' });
  const num = v => (Number.isFinite(v) ? v : null);
  const clips = [];
  for (const c of Array.isArray(b.clips) ? b.clips.slice(0, MAX_CLIPS) : []) {
    const wav = typeof c?.wav === 'string' ? Buffer.from(c.wav, 'base64') : null;
    if (!wav || wav.length < 44 || wav.length > MAX_CLIP_BYTES
      || wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') {
      return send(400, { error: 'invalid clip' });
    }
    clips.push({ wav, score: num(c.score), at: num(c.at) });
  }
  send(201, await sightings.add({
    scientificName: b.scientificName,
    commonName: info,
    confidence: num(b.confidence),
    seenAt: typeof b.seenAt === 'string' ? b.seenAt.slice(0, 40) : new Date().toISOString(),
    latitude: num(b.latitude),
    longitude: num(b.longitude),
    source: typeof b.source === 'string' ? b.source.slice(0, 200) : null,
  }, clips));
}

async function handleBirdApi(url, res) {
  const info = await birdInfo.get(url.searchParams.get('sci') || '');
  if (!info) {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"unknown species"}');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(info));
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"server":true}');
    return;
  }
  if (url.pathname.startsWith('/api/recordings')) {
    handleRecordingsApi(req, url, res).catch(err => {
      console.error(err);
      res.destroy();
    });
    return;
  }
  if (url.pathname === '/api/bird' || url.pathname.startsWith('/api/sightings')) {
    const handler = url.pathname === '/api/bird' ? handleBirdApi(url, res) : handleSightingsApi(req, url, res);
    handler.catch(err => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"lookup failed"}');
    });
    return;
  }
  const urlPath = decodeURIComponent(url.pathname);
  let file = normalize(join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': file.includes('/models/') ? 'public, max-age=604800' : 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Birdsong running at http://localhost:${PORT}`);
  console.log(`  Bird facts: ${birdInfo.hasClaude ? 'Claude' : 'Wikipedia (set ANTHROPIC_API_KEY for curated facts)'}`);
  console.log(`  Bird sounds: ${process.env.XC_API_KEY ? 'xeno-canto' : 'iNaturalist (set XC_API_KEY for song/call-labelled xeno-canto audio)'}`);
});
