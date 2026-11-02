// Location filter regression tests: runs BirdNET's area model (downloaded by
// `npm install`) on CPU with the same week rule and cutoff the app uses (public/geo.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_DIR = join(ROOT, 'public/models/birdnet');
const tf = createRequire(import.meta.url)('@tensorflow/tfjs/dist/tf.node.js');

const geoContext = {};
vm.runInNewContext(await readFile(join(ROOT, 'public/geo.js'), 'utf8'), geoContext);
const { GEO_MIN, birdnetWeek } = geoContext.BirdsongGeo;

const labels = (await readFile(join(MODEL_DIR, 'labels/en_us.txt'), 'utf8'))
  .split('\n').map(l => l.trim()).filter(Boolean)
  .map(line => line.split('_')[1]);

const areaModel = await tf.loadGraphModel({
  async load() {
    const json = JSON.parse(await readFile(join(MODEL_DIR, 'area-model/model.json'), 'utf8'));
    const shards = [];
    for (const group of json.weightsManifest) {
      for (const path of group.paths) shards.push(await readFile(join(MODEL_DIR, 'area-model', path)));
    }
    const data = Buffer.concat(shards);
    return {
      format: json.format,
      modelTopology: json.modelTopology,
      signature: json.signature,
      weightSpecs: json.weightsManifest.flatMap(g => g.weights),
      weightData: data.buffer.slice(data.byteOffset, data.byteOffset + data.length),
    };
  },
});

// Same input layout as worker.js areaScores(): [latitude, longitude, week].
function areaScores(latitude, longitude, week) {
  return tf.tidy(() => areaModel.predict(tf.tensor([[latitude, longitude, week]])).dataSync());
}

function passes(scores, commonName) {
  const i = labels.indexOf(commonName);
  assert.ok(i >= 0, `${commonName} is not in the label list`);
  return scores[i] >= GEO_MIN;
}

const MONETT = [36.92, -93.93]; // Monett, Missouri
const EARLY_NOVEMBER = new Date(2026, 10, 2);
const RESIDENTS = ['Tufted Titmouse', 'Northern Cardinal'];

test('labels line up with the area model output', () => {
  assert.equal(areaScores(...MONETT, 1).length, labels.length);
});

test('early November is BirdNET week 41', () => {
  assert.equal(birdnetWeek(EARLY_NOVEMBER), 41);
  assert.equal(birdnetWeek(new Date(2026, 0, 1)), 1);
  assert.equal(birdnetWeek(new Date(2026, 11, 31)), 48);
});

test('feeder residents pass at Monett, MO in early November', () => {
  const scores = areaScores(...MONETT, birdnetWeek(EARLY_NOVEMBER));
  for (const name of RESIDENTS) assert.ok(passes(scores, name), `${name} was filtered out`);
});

test('feeder residents pass at Monett, MO in every week of the year', () => {
  for (let week = 1; week <= 48; week++) {
    const scores = areaScores(...MONETT, week);
    for (const name of RESIDENTS) assert.ok(passes(scores, name), `${name} filtered out in week ${week}`);
  }
});

test('the filter still rules out out-of-season and out-of-range birds at Monett', () => {
  const scores = areaScores(...MONETT, birdnetWeek(EARLY_NOVEMBER));
  assert.ok(!passes(scores, 'Ruby-throated Hummingbird'), 'summer migrant passed in November');
  assert.ok(!passes(scores, 'European Robin'), 'Old World species passed in Missouri');
  const kept = Array.from(scores).filter(s => s >= GEO_MIN).length;
  assert.ok(kept < labels.length / 20, `filter kept ${kept} of ${labels.length} species`);
});

test('a wrong location fix (swapped coordinates) drops the residents', () => {
  // The failure mode the filter note now makes visible: these birds only vanish
  // when the position handed to the model is not actually Monett.
  const scores = areaScores(MONETT[1], MONETT[0], birdnetWeek(EARLY_NOVEMBER));
  for (const name of RESIDENTS) assert.ok(!passes(scores, name));
});
