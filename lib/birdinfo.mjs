// Gathers photos, sounds and facts for one species, with an on-disk cache.
//
//   Photos: iNaturalist research-grade observations annotated Male / Female.
//   Sounds: xeno-canto (typed: song, call, ...) when XC_API_KEY is set,
//           otherwise iNaturalist recordings.
//   Facts:  Claude when ANTHROPIC_API_KEY (or another Anthropic credential)
//           is set, otherwise the Wikipedia summary.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import * as inat from '../public/inat.js';

const UA = 'Birdsong/1.0 (local bird ID app)';
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

export function createBirdInfo({ cacheDir, labelsPath }) {
  let species = null; // scientific name -> common name (only these may be queried)
  const inFlight = new Map();
  const anthropic = hasAnthropicCredentials() ? new Anthropic() : null;

  async function loadSpecies() {
    if (species) return species;
    const text = await readFile(labelsPath, 'utf8');
    // Binomial names only; this skips sound classes like "Dog" or "Engine".
    species = new Map(text.split('\n').map(l => l.trim().split('_')).filter(([sci]) => /^[A-Z][a-z]+ [a-z-]+$/.test(sci)));
    return species;
  }

  async function get(scientificName) {
    const names = await loadSpecies();
    const commonName = names.get(scientificName);
    if (!commonName) return null;

    const file = join(cacheDir, `${scientificName.replace(/[^A-Za-z-]+/g, '_')}.json`);
    try {
      const cached = JSON.parse(await readFile(file, 'utf8'));
      // Re-fetch when stale, or when a key has been added since the entry was cached.
      const upgradeable = (anthropic && cached.factsSource !== 'claude') ||
        (process.env.XC_API_KEY && cached.soundsSource !== 'xeno-canto');
      if (Date.now() - cached.fetchedAt < CACHE_TTL_MS && !upgradeable) return cached;
    } catch { /* not cached yet */ }

    if (!inFlight.has(scientificName)) {
      inFlight.set(scientificName, (async () => {
        try {
          const info = await gather(scientificName, commonName);
          await mkdir(cacheDir, { recursive: true });
          await writeFile(file, JSON.stringify(info));
          return info;
        } finally {
          inFlight.delete(scientificName);
        }
      })());
    }
    return inFlight.get(scientificName);
  }

  async function gather(scientificName, commonName) {
    const [photos, soundsResult, wiki] = await Promise.all([
      inat.getPhotos(scientificName, getJson).catch(logAnd([])),
      getSounds(scientificName).catch(logAnd({ sounds: [], source: null })),
      inat.getWikipedia(scientificName, getJson).catch(logAnd(null)),
    ]);

    let facts = null;
    let factsSource = null;
    if (anthropic) {
      facts = await getClaudeFacts(anthropic, scientificName, commonName, wiki?.extract).catch(logAnd(null));
      if (facts) factsSource = 'claude';
    }
    if (!facts && wiki?.extract) {
      facts = { summary: wiki.extract };
      factsSource = 'wikipedia';
    }

    return {
      scientificName, commonName, photos,
      sounds: soundsResult.sounds, soundsSource: soundsResult.source,
      facts, factsSource, wikiUrl: wiki?.url ?? null,
      fetchedAt: Date.now(),
    };
  }

  /** Common name for a known species, or undefined. */
  async function speciesName(scientificName) {
    return (await loadSpecies()).get(scientificName);
  }

  return { get, species: speciesName, hasClaude: !!anthropic };
}

/* ---------------------------------------------------------------------------
   Sounds (photos and Wikipedia lookups live in public/inat.js)
   ------------------------------------------------------------------------- */

async function getSounds(scientificName) {
  if (process.env.XC_API_KEY) {
    try {
      const sounds = await xenoCantoSounds(scientificName);
      if (sounds.length) return { sounds, source: 'xeno-canto' };
    } catch (err) {
      console.warn(`xeno-canto lookup failed for ${scientificName}: ${err.message}`);
    }
  }
  return { sounds: await inat.iNatSounds(scientificName, getJson), source: 'inaturalist' };
}

/** Best short recording of each vocalization type, up to 5. */
async function xenoCantoSounds(scientificName) {
  const params = new URLSearchParams({
    query: `sp:"${scientificName}"`, key: process.env.XC_API_KEY, per_page: '100',
  });
  const data = await getJson(`https://xeno-canto.org/api/3/recordings?${params}`);
  const recs = (data.recordings ?? [])
    .filter(r => r.file && (r.q === 'A' || r.q === 'B'))
    .map(r => ({ ...r, seconds: parseLength(r.length), types: (r.type || '').toLowerCase().split(',').map(t => t.trim()) }))
    .filter(r => r.seconds > 0 && r.seconds <= 90)
    .sort((a, b) => (a.q === b.q ? a.seconds - b.seconds : a.q < b.q ? -1 : 1));

  // Up to two songs and two calls, then one of each rarer type.
  const picked = [];
  for (const type of inat.SOUND_TYPES) {
    const limit = type === 'song' || type === 'call' ? 2 : 1;
    const matches = recs.filter(r => r.types.includes(type) && !picked.some(p => p.id === r.id));
    for (const r of matches.slice(0, limit)) {
      if (picked.length < 5) picked.push({ ...r, primary: type });
    }
  }
  if (!picked.length) picked.push(...recs.slice(0, 3).map(r => ({ ...r, primary: r.types[0] || 'sound' })));

  return picked.map(r => ({
    type: r.primary,
    sex: normalizeSex(r.sex),
    url: r.file,
    seconds: r.seconds,
    credit: `${r.rec}, xeno-canto XC${r.id}`,
    link: `https://xeno-canto.org/${r.id}`,
  }));
}


function parseLength(s) {
  const [m, sec] = String(s || '').split(':').map(Number);
  return sec === undefined ? 0 : m * 60 + sec;
}

function normalizeSex(s) {
  s = (s || '').toLowerCase();
  return s === 'male' || s === 'female' ? s : null;
}

/* ---------------------------------------------------------------------------
   Facts
   ------------------------------------------------------------------------- */

const FactsSchema = z.object({
  fieldMarks: z.array(z.string()).describe('3-4 most distinguishing visual field marks, each under 14 words'),
  maleVsFemale: z.string().describe('One sentence on how males and females differ, or that they look alike'),
  voice: z.string().describe('One sentence describing what the song and main call sound like, with a mnemonic if a well-known one exists'),
  confusedWith: z.array(z.string()).describe('Up to 3 commonly confused species, each as "Species: how to tell apart by sight or sound", under 20 words'),
  funFacts: z.array(z.string()).describe('3 surprising, memorable, accurate facts, each under 25 words'),
});

async function getClaudeFacts(client, scientificName, commonName, wikiExtract) {
  const response = await client.beta.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: betaZodOutputFormat(FactsSchema) },
    system: 'You write compact, field-guide-accurate notes that help a birder confirm an ID by sight and sound. ' +
      'Only state facts you are confident are true for this exact species. Keep every item short; no filler.',
    messages: [{
      role: 'user',
      content: `Species: ${commonName} (${scientificName}).` +
        (wikiExtract ? `\n\nWikipedia summary for reference:\n${wikiExtract}` : ''),
    }],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) return null;
  return response.parsed_output;
}

function hasAnthropicCredentials() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

/* ---------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------- */

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return res.json();
}

function logAnd(fallback) {
  return err => {
    console.warn(err.message);
    return fallback;
  };
}
