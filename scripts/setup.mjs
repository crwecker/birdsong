// Downloads the BirdNET TF.js model + labels and vendors tf.min.js into public/.
// Model files come from https://github.com/birdnet-team/real-time-pwa (models: CC BY-SA 4.0).
import { mkdir, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
// Pinned so every build gets identical model files.
const BIRDNET_COMMIT = '6ab67ac09fa64d98858b90f14318229aca9bb7dc';
const REPO_RAW = `https://raw.githubusercontent.com/birdnet-team/real-time-pwa/${BIRDNET_COMMIT}/public/models/birdnet`;
const SHARD = 4194304;

const files = [
  ['model.json', 893632],
  ...Array.from({ length: 13 }, (_, i) => [`group1-shard${i + 1}of13.bin`, i === 12 ? 990032 : SHARD]),
  ['labels/en_us.txt', 259740],
  ['area-model/model.json', 27328],
  ['area-model/group1-shard1of2.bin', SHARD],
  ['area-model/group1-shard2of2.bin', 2864028],
];

async function sizeOf(path) {
  try { return (await stat(path)).size; } catch { return -1; }
}

for (const [rel, expected] of files) {
  const dest = join(PUBLIC, 'models/birdnet', rel);
  if (await sizeOf(dest) === expected) continue;
  process.stdout.write(`Downloading ${rel} ... `);
  const res = await fetch(`${REPO_RAW}/${rel}`);
  if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== expected) throw new Error(`${rel}: expected ${expected} bytes, got ${buf.length}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
}

await mkdir(join(PUBLIC, 'vendor'), { recursive: true });
await copyFile(join(ROOT, 'node_modules/@tensorflow/tfjs/dist/tf.min.js'), join(PUBLIC, 'vendor/tf.min.js'));
console.log('Setup complete. Run `npm start` and open http://localhost:8080');
