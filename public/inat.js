// iNaturalist + Wikipedia lookups shared by the Node server (lib/birdinfo.mjs)
// and the static build, which calls these services straight from the browser.
// Every function takes the `getJson(url)` to use, so callers control headers and errors.

const INAT = 'https://api.inaturalist.org/v1';
const SEX_TERM = 9;
const MALE = 11;
const FEMALE = 10;

export const SOUND_TYPES = ['song', 'call', 'alarm call', 'flight call', 'drumming', 'begging call', 'subsong'];

/** Up to two male and two female research-grade photos, else the taxon's curated photos. */
export async function getPhotos(scientificName, getJson) {
  const [males, females] = await Promise.all([
    sexedPhotos(scientificName, MALE, 'Male', getJson),
    sexedPhotos(scientificName, FEMALE, 'Female', getJson),
  ]);
  const photos = [...males, ...females];
  if (photos.length >= 2) return photos;

  // Few sexed observations (common for tropical species): use the taxon's curated photos.
  const taxa = await getJson(`${INAT}/taxa?${new URLSearchParams({ q: scientificName, rank: 'species', per_page: '1' })}`);
  const taxon = taxa.results?.[0];
  if (!taxon) return photos;
  const detail = await getJson(`${INAT}/taxa/${taxon.id}`);
  const extra = (detail.results?.[0]?.taxon_photos ?? []).slice(0, 4 - photos.length).map(tp => toPhoto(tp.photo, null));
  return [...photos, ...extra];
}

async function sexedPhotos(scientificName, sexValue, label, getJson) {
  const params = new URLSearchParams({
    taxon_name: scientificName, term_id: String(SEX_TERM), term_value_id: String(sexValue),
    quality_grade: 'research', photos: 'true', photo_licensed: 'true', order_by: 'votes', per_page: '2',
  });
  const data = await getJson(`${INAT}/observations?${params}`);
  return (data.results ?? []).filter(o => o.photos?.length).map(o => toPhoto(o.photos[0], label));
}

function toPhoto(photo, label) {
  const url = photo.url ?? '';
  return {
    label,
    thumb: url.replace('/square.', '/small.'),
    full: url.replace('/square.', '/large.'),
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

export async function getWikipedia(scientificName, getJson) {
  const data = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(scientificName.replace(/ /g, '_'))}`);
  return data.extract ? { extract: data.extract, url: data.content_urls?.desktop?.page } : null;
}
