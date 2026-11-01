// iNaturalist + Wikipedia lookups shared by the Node server (lib/birdinfo.mjs)
// and the static build, which calls these services straight from the browser.
// Every function takes the `getJson(url)` to use, so callers control headers and errors.

const INAT = 'https://api.inaturalist.org/v1';
const INAT_V2 = 'https://api.inaturalist.org/v2';
const SEX_TERM = 9;
const MALE = 11;
const FEMALE = 10;

export const SOUND_TYPES = ['song', 'call', 'alarm call', 'flight call', 'drumming', 'begging call', 'subsong'];

// Bump when the shape of gathered details changes, so cached entries are re-fetched.
export const INFO_VERSION = 3;

const MAX_PHOTOS = 10;

/** Photos, the iNaturalist taxon id (for links and map tiles) and the area to show on the range map. */
export async function getTaxonMedia(scientificName, getJson) {
  const { photos, taxonId } = await getPhotos(scientificName, getJson);
  const mapBounds = taxonId ? await getMapBounds(taxonId, getJson).catch(() => null) : null;
  return { photos, taxonId, mapBounds };
}

/**
 * The area holding most observations: 5th-95th percentile of a random sample, so a
 * few vagrants or escaped cage birds on another continent don't zoom the map out.
 */
async function getMapBounds(taxonId, getJson) {
  const params = new URLSearchParams({
    taxon_id: String(taxonId), verifiable: 'true', per_page: '200', order_by: 'random', fields: 'location',
  });
  const data = await getJson(`${INAT_V2}/observations?${params}`);
  const points = (data.results ?? [])
    .map(r => String(r.location ?? '').split(',').map(Number))
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
  if (points.length < 5) return null;
  const quantile = (xs, q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  const span = lngs => {
    const sorted = [...lngs].sort((a, b) => a - b);
    return { west: quantile(sorted, 0.05), east: quantile(sorted, 0.95) };
  };
  const lats = points.map(p => p[0]).sort((a, b) => a - b);
  let lng = span(points.map(p => p[1]));
  // A range straddling the 180° meridian (Alaska-Siberia, Pacific islands) is narrower unwrapped.
  const shifted = span(points.map(p => (p[1] < 0 ? p[1] + 360 : p[1])));
  if (shifted.east - shifted.west < lng.east - lng.west) lng = shifted;
  return { south: quantile(lats, 0.05), north: quantile(lats, 0.95), ...lng };
}

/**
 * Up to three male and three female research-grade photos, topped up with the
 * taxon's curated photos. Returns the iNaturalist taxon id too, for links.
 */
async function getPhotos(scientificName, getJson) {
  const [males, females, taxon] = await Promise.all([
    sexedPhotos(scientificName, MALE, 'Male', getJson).catch(() => []),
    sexedPhotos(scientificName, FEMALE, 'Female', getJson).catch(() => []),
    findTaxon(scientificName, getJson).catch(() => null),
  ]);
  const photos = [...males, ...females];
  if (taxon) {
    const detail = await getJson(`${INAT}/taxa/${taxon.id}`).catch(() => null);
    // The curated set often repeats an observation photo already picked.
    for (const tp of detail?.results?.[0]?.taxon_photos ?? []) {
      if (photos.length >= MAX_PHOTOS) break;
      if (tp.photo?.url && !photos.some(p => p.id === tp.photo.id)) photos.push(toPhoto(tp.photo, null));
    }
  }
  return { photos, taxonId: taxon?.id ?? null };
}

async function findTaxon(scientificName, getJson) {
  const taxa = await getJson(`${INAT}/taxa?${new URLSearchParams({ q: scientificName, rank: 'species', per_page: '5' })}`);
  const results = taxa.results ?? [];
  return results.find(t => t.name === scientificName) ?? results[0] ?? null;
}

async function sexedPhotos(scientificName, sexValue, label, getJson) {
  const params = new URLSearchParams({
    taxon_name: scientificName, term_id: String(SEX_TERM), term_value_id: String(sexValue),
    quality_grade: 'research', photos: 'true', photo_licensed: 'true', order_by: 'votes', per_page: '3',
  });
  const data = await getJson(`${INAT}/observations?${params}`);
  return (data.results ?? []).filter(o => o.photos?.length).map(o => toPhoto(o.photos[0], label));
}

function toPhoto(photo, label) {
  const url = photo.url ?? '';
  return {
    id: photo.id,
    label,
    thumb: url.replace('/square.', '/medium.'), // ~500 px: sharp on high-DPI phones
    full: url.replace('/square.', '/large.'),
    original: url.replace('/square.', '/original.'),
    credit: photo.attribution,
  };
}

/** Up to five research-grade recordings, typed from the observer's notes when possible. */
export async function iNatSounds(scientificName, getJson) {
  const params = new URLSearchParams({
    taxon_name: scientificName, sounds: 'true', quality_grade: 'research', order_by: 'votes', per_page: '12',
  });
  const data = await getJson(`${INAT}/observations?${params}`);
  const out = [];
  for (const o of data.results ?? []) {
    const sound = o.sounds?.find(s => s.file_url);
    if (!sound) continue;
    const text = `${o.description ?? ''} ${(o.tags ?? []).join(' ')}`.toLowerCase();
    const type = SOUND_TYPES.find(t => text.includes(t)) ??
      (/\bsing|singing|sang\b/.test(text) ? 'song' : /\bcalls?\b|calling|chip/.test(text) ? 'call' : 'recording');
    const sexAnno = o.annotations?.find(a => a.controlled_attribute_id === SEX_TERM);
    out.push({
      type,
      sex: sexAnno?.controlled_value_id === MALE ? 'male' : sexAnno?.controlled_value_id === FEMALE ? 'female' : null,
      url: sound.file_url,
      seconds: null,
      credit: `${sound.attribution} (iNaturalist)`,
      link: `https://www.inaturalist.org/observations/${o.id}`,
    });
    if (out.length >= 5) break;
  }
  return out;
}

/** Notes from Wikipedia: voice, behaviour and looks when the article has them, else the summary. */
export function wikiFacts(wiki) {
  if (wiki?.sections) return { sections: wiki.sections };
  return wiki?.extract ? { summary: wiki.extract } : null;
}

export async function getWikipedia(scientificName, getJson) {
  const data = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(scientificName.replace(/ /g, '_'))}`);
  if (!data.extract) return null;
  const sections = await getWikiSections(data.titles?.canonical ?? data.title, getJson).catch(() => null);
  return { extract: data.extract, url: data.content_urls?.desktop?.page, sections };
}

// Range and habitat are shown on the map, so notes come from the parts of the
// article about how the bird sounds, looks and behaves.
// Headings are tried in order, so a "Plumage" subsection beats the general "Description".
const WIKI_TOPICS = [
  { key: 'voice', match: [/vocal|voice|song|call/i], sentences: 3 },
  { key: 'looks', match: [/identification|plumage|appearance/i, /^description/i], sentences: 2 },
  { key: 'behavior', match: [/behaviou?r|feeding|foraging|diet|territor|courtship/i], sentences: 2, max: 2 },
];

/** A few sentences each on voice, appearance and behaviour, from the full article. */
async function getWikiSections(title, getJson) {
  const params = new URLSearchParams({
    action: 'query', prop: 'extracts', explaintext: '1', redirects: '1', format: 'json', origin: '*', titles: title,
  });
  const data = await getJson(`https://en.wikipedia.org/w/api.php?${params}`);
  const text = Object.values(data.query?.pages ?? {})[0]?.extract ?? '';
  // "== Heading ==" lines split the plain-text extract into sections.
  const parts = text.split(/^=+ (.+?) =+$/m);
  const sections = [];
  for (let i = 1; i < parts.length; i += 2) sections.push({ title: parts[i].trim(), body: parts[i + 1].trim() });

  const out = {};
  const used = new Set();
  for (const topic of WIKI_TOPICS) {
    const picks = [];
    for (const re of topic.match) {
      for (const sec of sections) {
        if (picks.length >= (topic.max ?? 1)) break;
        if (used.has(sec) || !sec.body || !re.test(sec.title)) continue;
        used.add(sec);
        picks.push(firstSentences(sec.body, topic.sentences));
      }
    }
    if (picks.length) out[topic.key] = picks;
  }
  return Object.keys(out).length ? out : null;
}

function firstSentences(text, n) {
  // Split after ". " followed by a capital; avoids most abbreviations like "c. 20 cm".
  const sentences = text.replace(/\s*\[\d+\]/g, '').split(/\n+|(?<=[.!?])\s+(?=[A-Z"“])/)
    .map(x => x.trim()).filter(x => x.length > 20);
  // Lengths and weights are hard to picture in the field; prefer the descriptive sentences.
  const measured = /\d\s*(cm|mm|in|g|kg|oz|lb)\b/;
  const descriptive = sentences.filter(x => !measured.test(x));
  return (descriptive.length ? descriptive : sentences).slice(0, n).join(' ');
}
