/**
 * Birdsong: microphone capture, spectrogram, and detection bookkeeping.
 * All inference happens in worker.js; recording and playback live in recordings.js.
 */

import { createRecordings } from './recordings.js';
import { createBackend, wavHeader } from './backend.js';

// The local server when running `npm start`; this browser's storage on static hosting.
const backend = await createBackend();

const MODEL_RATE = 48000;
const WINDOW_SAMPLES = 3 * MODEL_RATE; // BirdNET analyses 3 s windows
const INFER_INTERVAL_MS = 500; // slide the window by ~0.5 s so calls land well inside some window
// High-pass cutoff, Hz. Measured on a noisy test soundscape: 150 Hz helps under traffic
// and mains hum, but any filtering costs detections in quiet or windy conditions (the
// model is trained on unfiltered recordings), so it's off by default.
const NOISE_FILTERS = { off: 0, traffic: 150 };
const MAYBE_FLOOR = 0.1; // show weaker candidates (greyed) above this
const { GEO_MIN, birdnetWeek } = globalThis.BirdsongGeo; // shared with worker.js (geo.js)
const COARSE_FIX_M = 25_000; // a location fix this vague is probably IP-based; say so
const NEW_ENCOUNTER_GAP_MS = 5000; // detections closer than this count as one
const CLIPS_PER_BIRD = 4; // playable clips kept per species (one per encounter, strongest first to go last)

const $ = id => document.getElementById(id);
const els = {
  status: $('status'), statusText: $('statusText'),
  listenBtn: $('listenBtn'), listenLabel: $('listenLabel'), micSelect: $('micSelect'),
  loadProgress: $('loadProgress'), loadBar: $('loadBar'), hint: $('hint'),
  canvas: $('spectrogram'), inferMeta: $('inferMeta'),
  nowList: $('nowList'), logList: $('logList'), logCount: $('logCount'), clearBtn: $('clearBtn'),
  skippedBox: $('skippedBox'), skippedList: $('skippedList'), skippedCount: $('skippedCount'), savedList: $('savedList'), savedCount: $('savedCount'),
  savedItemTpl: $('savedItemTpl'), lightbox: $('lightbox'),
  threshold: $('threshold'), thresholdOut: $('thresholdOut'), noiseFilter: $('noiseFilter'),
  geoToggle: $('geoToggle'), geoNote: $('geoNote'), clipsToggle: $('clipsToggle'),
  recordBtn: $('recordBtn'), recordLabel: $('recordLabel'),
  uploadInput: $('uploadInput'), uploadLabel: $('uploadLabel'), recNote: $('recNote'),
  recCount: $('recCount'), recList: $('recList'),
  player: $('player'), playerName: $('playerName'), playerMeta: $('playerMeta'), playerClose: $('playerClose'),
  detTrack: $('detTrack'), playerSpec: $('playerSpec'), playhead: $('playhead'), playerStatus: $('playerStatus'),
  overviewWrap: $('overviewWrap'), overview: $('overview'), overviewWindow: $('overviewWindow'),
  back5: $('back5'), playBtn: $('playBtn'), fwd5: $('fwd5'), playTime: $('playTime'),
  zoomOut: $('zoomOut'), zoomIn: $('zoomIn'), findBirds: $('findBirds'), downloadBtn: $('downloadBtn'),
  playerAudio: $('playerAudio'),
  logItemTpl: $('logItemTpl'),
};

const state = {
  labels: [],
  geoScores: null,
  geoWeek: null, // BirdNET week the geo scores were computed for
  threshold: loadNumber('birdsong.threshold', 0.15),
  noiseFilter: loadString('birdsong.noiseFilter') || 'off',
  keepClips: loadNumber('birdsong.clips', 1) === 1,
  log: new Map(), // label index -> { index, count, best, lastSeen, sightingId, el }
  skipped: new Map(), // label index -> log entry, kept out of the list for this session
  sightings: [], // saved, verified sightings (persisted by the server)
  position: null, // { latitude, longitude } once the location filter is on
  listening: false,
  worker: null,
  workerReady: false,
  pending: new Map(), // request id -> { resolve, reject, onProgress }
  nextId: 1,
};

/* ---------------------------------------------------------------------------
   Worker
   ------------------------------------------------------------------------- */

function startWorker() {
  const worker = new Worker('worker.js');
  state.worker = worker;
  worker.onmessage = ({ data }) => {
    switch (data.type) {
      case 'progress':
        setStatus(`${data.stage}… ${Math.round(data.progress * 100)}%`);
        els.loadBar.style.width = `${data.progress * 100}%`;
        break;
      case 'ready':
        state.labels = data.labels;
        state.workerReady = true;
        els.loadProgress.classList.add('done');
        els.listenBtn.disabled = false;
        els.uploadInput.disabled = false;
        els.recordBtn.disabled = false;
        els.hint.textContent = 'Everything runs on your device. No audio leaves your browser.';
        if (!data.hasAreaModel) {
          els.geoToggle.disabled = true;
          els.geoNote.textContent = 'Location model unavailable.';
        }
        setStatus('Ready', 'ready');
        if (els.geoToggle.checked) enableGeo();
        break;
      case 'area':
        // Ignore a late reply after the filter was turned off or the week moved on.
        if (state.position?.latitude === data.latitude && state.position.longitude === data.longitude &&
            data.week === state.geoWeek) state.geoScores = data.scores;
        break;
      case 'predict-progress':
        state.pending.get(data.id)?.onProgress?.(data.progress);
        break;
      case 'prediction': {
        const p = state.pending.get(data.id);
        state.pending.delete(data.id);
        p?.resolve(data);
        break;
      }
      case 'error': {
        const p = data.id && state.pending.get(data.id);
        if (p) {
          state.pending.delete(data.id);
          p.reject(new Error(data.error));
        } else {
          setStatus(`Error: ${data.error}`, 'error');
          els.hint.textContent = 'The model could not be loaded. Did you run `npm install`?';
        }
        break;
      }
    }
  };
  worker.onerror = e => setStatus(`Worker error: ${e.message}`, 'error');
}

/** `hop` (samples) overlaps the 3 s analysis windows; omitted, they're back to back. */
function predict(pcm, onProgress, hop) {
  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject, onProgress });
    state.worker.postMessage({ type: 'predict', id, pcm, hop }, [pcm.buffer]);
  });
}

/* ---------------------------------------------------------------------------
   Noise filter
   ------------------------------------------------------------------------- */

// Traffic and mains hum sit below the songs of almost all birds.
function noiseCutoff() {
  return NOISE_FILTERS[state.noiseFilter] ?? NOISE_FILTERS.off;
}

/** Two cascaded Butterworth high-pass stages (24 dB/octave). */
function createNoiseFilter(ctx) {
  const stages = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
  for (const f of stages) {
    f.type = 'highpass';
    f.Q.value = Math.SQRT1_2;
  }
  stages[0].connect(stages[1]);
  const setCutoff = hz => stages.forEach(f => { f.frequency.value = Math.max(hz, 10); });
  setCutoff(noiseCutoff());
  return { input: stages[0], output: stages[1], setCutoff };
}

/** Applies the current noise filter to a 48 kHz mono buffer (for recordings and uploads). */
async function filterNoise(pcm) {
  if (!noiseCutoff()) return pcm;
  const ctx = new OfflineAudioContext(1, pcm.length, MODEL_RATE);
  const buffer = ctx.createBuffer(1, pcm.length, MODEL_RATE);
  buffer.copyToChannel(pcm, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = createNoiseFilter(ctx);
  src.connect(filter.input);
  filter.output.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

/* ---------------------------------------------------------------------------
   Microphone capture
   ------------------------------------------------------------------------- */

const audio = {
  ctx: null, stream: null, source: null, filter: null, worklet: null, analyser: null,
  ring: new Float32Array(WINDOW_SAMPLES), writeIndex: 0, filled: 0,
  resampler: null, timer: null, busy: false, wakeLock: null, rafId: 0,
  startedAt: 0, chunks: 0, peak: 0, warned: false,
};

async function startListening() {
  if (state.listening) return;
  setListeningUI(true);
  flagMic(false);
  setStatus('Requesting microphone…');
  // Create and resume the AudioContext synchronously inside the click handler.
  // Doing it after awaiting getUserMedia loses the user gesture, and browsers
  // (Safari especially) then leave the context suspended: no audio flows at all.
  // Prefer 48 kHz so no resampling is needed.
  audio.ctx = new AudioContext({ sampleRate: MODEL_RATE });
  audio.ctx.resume().catch(() => {});
  try {
    // Browser voice processing (noise suppression especially) erases birdsong.
    audio.stream = await openMic(els.micSelect.value);
    refreshMicList(); // device names only become visible once permission is granted

    // Firefox refuses to connect a mic running at another rate, so fall back to the native rate.
    try {
      audio.source = audio.ctx.createMediaStreamSource(audio.stream);
    } catch {
      await audio.ctx.close();
      audio.ctx = new AudioContext();
      audio.source = audio.ctx.createMediaStreamSource(audio.stream);
    }
    if (audio.ctx.state !== 'running') await audio.ctx.resume();

    audio.resampler = new LinearResampler(audio.ctx.sampleRate, MODEL_RATE);
    audio.ring.fill(0);
    audio.writeIndex = 0;
    audio.filled = 0;
    Object.assign(audio, { startedAt: performance.now(), chunks: 0, peak: 0, warned: false, inferMs: 0 });

    await audio.ctx.audioWorklet.addModule('audio-processor.js');
    audio.worklet = new AudioWorkletNode(audio.ctx, 'capture-processor');
    audio.worklet.port.onmessage = ({ data }) => {
      audio.chunks++;
      for (let i = 0; i < data.length; i++) audio.peak = Math.max(audio.peak, Math.abs(data[i]));
      pushSamples(audio.resampler.process(data));
    };
    audio.filter = createNoiseFilter(audio.ctx);
    audio.source.connect(audio.filter.input);
    audio.filter.output.connect(audio.worklet);
    audio.worklet.connect(audio.ctx.destination); // keeps the node pulled; it outputs silence

    audio.analyser = audio.ctx.createAnalyser();
    audio.analyser.fftSize = 2048;
    audio.analyser.smoothingTimeConstant = 0;
    audio.analyser.minDecibels = -110; // birdsong is often faint; favour contrast
    audio.analyser.maxDecibels = -45;
    audio.filter.output.connect(audio.analyser); // the spectrogram shows what the model hears
    startSpectrogram();

    state.listening = true;
    setStatus('Listening', 'listening');
    audio.timer = setInterval(inferTick, INFER_INTERVAL_MS);
    requestWakeLock();
  } catch (err) {
    console.error(err);
    stopListening();
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    setStatus(denied ? 'Microphone blocked' : `Mic error: ${err.message}`, 'error');
    if (!denied) flagMic(true);
    if (denied) els.hint.textContent = 'Allow microphone access in your browser’s site settings, then try again.';
  }
}

/** The mic picker stays discreet unless the mic seems to be the problem. */
function flagMic(on) {
  els.micSelect.closest('.mic-pick').classList.toggle('attention', on);
}

async function openMic(deviceId) {
  // Browser voice processing (noise suppression especially) erases birdsong.
  const constraints = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (!deviceId) return navigator.mediaDevices.getUserMedia({ audio: constraints });
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...constraints, deviceId: { exact: deviceId } } });
  } catch (err) {
    if (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError') throw err;
    // The saved mic was unplugged; use the default instead.
    els.micSelect.value = '';
    saveSetting('birdsong.mic', '');
    return navigator.mediaDevices.getUserMedia({ audio: constraints });
  }
}

/** Fills the microphone dropdown, keeping the current choice when it still exists. */
async function refreshMicList() {
  let inputs;
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices())
      .filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch {
    return;
  }
  const wanted = els.micSelect.value || loadString('birdsong.mic');
  const options = [new Option('System default', '')];
  inputs.forEach((d, n) => options.push(new Option(d.label || `Microphone ${n + 1}`, d.deviceId)));
  els.micSelect.replaceChildren(...options);
  els.micSelect.value = inputs.some(d => d.deviceId === wanted) ? wanted : '';
  els.micSelect.title = inputs.length && !inputs[0].label
    ? 'Microphone names appear after you allow microphone access.'
    : '';
}

/** `keepRecording` lets a mic switch restart capture without ending the recording. */
function stopListening({ keepRecording = false } = {}) {
  if (!keepRecording) recordings.stopRecording();
  state.listening = false;
  clearInterval(audio.timer);
  cancelAnimationFrame(audio.rafId);
  audio.worklet?.port && (audio.worklet.port.onmessage = null);
  audio.stream?.getTracks().forEach(t => t.stop());
  audio.ctx?.close();
  Object.assign(audio, { ctx: null, stream: null, source: null, filter: null, worklet: null, analyser: null, timer: null });
  audio.wakeLock?.release().catch(() => {});
  audio.wakeLock = null;
  setListeningUI(false);
  if (state.workerReady) {
    setStatus('Ready', 'ready');
    els.hint.textContent = 'Everything runs on your device. No audio leaves your browser.';
  }
}

function pushSamples(samples) {
  recordings.pushSamples(samples);
  const ring = audio.ring;
  for (let i = 0; i < samples.length; i++) {
    ring[audio.writeIndex] = samples[i];
    audio.writeIndex = (audio.writeIndex + 1) % ring.length;
  }
  audio.filled = Math.min(ring.length, audio.filled + samples.length);
}

/** Copies the most recent 3 s out of the ring buffer, oldest sample first. */
function currentWindow() {
  const out = new Float32Array(WINDOW_SAMPLES);
  const tail = audio.ring.subarray(audio.writeIndex);
  out.set(tail);
  out.set(audio.ring.subarray(0, audio.writeIndex), tail.length);
  return out;
}

async function inferTick() {
  // Skip ticks while the previous inference is still running so work never piles up.
  if (!state.listening) return;
  checkSignal();
  if (audio.busy || audio.filled < WINDOW_SAMPLES) return;
  audio.busy = true;
  try {
    const recordedAt = recordings.samplesRecorded(); // where this window ends in the recording
    const pcm = currentWindow();
    const clipSource = state.keepClips ? pcm.slice() : null; // predict() hands pcm's buffer to the worker
    const result = await predict(pcm);
    if (!state.listening) return;
    audio.inferMs = result.ms;
    els.inferMeta.textContent = meterText();
    handleLiveFrame(result.frames[0].hits, recordedAt, clipSource);
  } catch (err) {
    console.error(err);
  } finally {
    audio.busy = false;
  }
}

/**
 * Runs once a second while listening. Shows the mic level, and after a few
 * seconds explains the two common ways a "working" mic delivers nothing.
 */
function checkSignal() {
  const elapsed = performance.now() - audio.startedAt;
  els.inferMeta.textContent = meterText();
  if (elapsed < 3000 || audio.warned) {
    audio.lastPeak = audio.peak;
    audio.peak = 0;
    return;
  }
  if (audio.chunks === 0) {
    audio.warned = true;
    flagMic(true);
    setStatus('Audio paused by browser', 'error');
    els.hint.textContent = 'The browser hasn’t started audio processing. Click Stop listening, then Start listening again.';
  } else if (audio.peak === 0 && audio.lastPeak === 0) {
    audio.warned = true;
    flagMic(true);
    setStatus('Mic is sending silence', 'error');
    els.hint.textContent = navigator.platform.startsWith('Mac')
      ? 'Your browser is receiving pure silence. Open System Settings › Privacy & Security › Microphone, make sure your browser is switched on (then restart it), and check the input device in System Settings › Sound.'
      : 'Your browser is receiving pure silence. Check that your OS allows this browser to use the microphone and that the right input device is selected.';
  }
  audio.lastPeak = audio.peak;
  audio.peak = 0;
}

// One format for every update, so the header doesn't change shape (and wrap) twice a second.
function meterText() {
  const peak = Math.max(audio.lastPeak || 0, audio.peak);
  const level = peak > 0 ? `mic ${Math.round(20 * Math.log10(peak))} dB` : 'mic silent';
  return audio.inferMs ? `${level} · inference ${Math.round(audio.inferMs)} ms` : level;
}

/** Streaming linear-interpolation resampler (identity when rates match). */
class LinearResampler {
  constructor(fromRate, toRate) {
    this.step = fromRate / toRate;
    this.pos = 0; // position of next output sample, relative to current chunk (>= -1)
    this.last = 0; // final sample of the previous chunk (index -1)
  }

  process(input) {
    if (this.step === 1) return input;
    // Only emit samples whose right-hand neighbour is already available;
    // the rest are produced with the next chunk (bridging via `last`).
    const n = Math.max(0, Math.ceil((input.length - 1 - this.pos) / this.step));
    const out = new Float32Array(n);
    let pos = this.pos;
    for (let i = 0; i < n; i++, pos += this.step) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = i0 < 0 ? this.last : input[i0];
      out[i] = a + (input[i0 + 1] - a) * frac;
    }
    this.pos = pos - input.length;
    this.last = input[input.length - 1];
    return out;
  }
}

async function requestWakeLock() {
  try {
    audio.wakeLock = await navigator.wakeLock?.request('screen');
    audio.wakeLock?.addEventListener('release', () => { audio.wakeLock = null; });
  } catch { /* not supported or denied; listening still works */ }
}

/* ---------------------------------------------------------------------------
   Spectrogram
   ------------------------------------------------------------------------- */

const MAX_FREQ = 12000;
const COLORMAP = buildColormap();

function startSpectrogram() {
  const canvas = els.canvas;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  ctx.fillStyle = '#0b0d14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const analyser = audio.analyser;
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const usableBins = Math.min(bins.length, Math.floor(MAX_FREQ / (audio.ctx.sampleRate / 2) * bins.length));
  const column = ctx.createImageData(1, canvas.height);
  const step = Math.max(1, Math.round(dpr));

  const draw = () => {
    if (!audio.analyser) return;
    analyser.getByteFrequencyData(bins);
    ctx.drawImage(canvas, -step, 0);
    const h = canvas.height;
    for (let y = 0; y < h; y++) {
      const bin = Math.floor((1 - y / h) * usableBins);
      const [r, g, b] = COLORMAP[bins[bin]];
      const o = y * 4;
      column.data[o] = r; column.data[o + 1] = g; column.data[o + 2] = b; column.data[o + 3] = 255;
    }
    for (let x = 1; x <= step; x++) ctx.putImageData(column, canvas.width - x, 0);
    audio.rafId = requestAnimationFrame(draw);
  };
  draw();
}

function markSpectrogram(text) {
  const canvas = els.canvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  // The window that triggered this ended ~now; its middle is ~1.5 s back,
  // but a marker at the right edge is easier to read while scrolling.
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  const x = canvas.width - w - 6 * dpr;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x - 4 * dpr, 4 * dpr, w + 8 * dpr, 16 * dpr);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x, 16 * dpr);
}

function buildColormap() {
  // Dark navy -> purple -> orange -> pale yellow (magma-like).
  const stops = [[11, 13, 20], [52, 22, 92], [148, 40, 112], [232, 92, 62], [252, 200, 90], [252, 253, 191]];
  return Array.from({ length: 256 }, (_, i) => {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    return stops[k].map((c, j) => Math.round(c + (stops[k + 1][j] - c) * f));
  });
}

/* ---------------------------------------------------------------------------
   Detections
   ------------------------------------------------------------------------- */

/** Species hits that pass the geo filter, strongest first. */
function plausibleHits(hits) {
  refreshGeoWeek();
  return hits.filter(([i]) => {
    if (!state.labels[i]?.isSpecies) return false;
    return !state.geoScores || state.geoScores[i] >= GEO_MIN;
  });
}

/** `clipSource` is a copy of the analysed window when clips are being kept. */
function handleLiveFrame(hits, recordedAt, clipSource) {
  // The mic would hear a reference recording playing through the speakers.
  if (refAudio.blocking()) {
    els.nowList.innerHTML = '<li class="empty">Paused while a reference sound plays…</li>';
    return;
  }
  const candidates = plausibleHits(hits).filter(([, s]) => s >= MAYBE_FLOOR).slice(0, 5);
  renderNow(candidates);
  recordings.addLiveHits(candidates.filter(([, s]) => s >= state.threshold), recordedAt);
  for (const [i, score] of candidates) {
    if (score >= state.threshold) {
      const isNew = recordDetection(i, score, Date.now());
      if (isNew) markSpectrogram(state.labels[i].commonName);
      if (clipSource) keepClip(state.log.get(i), score, clipSource);
    }
  }
}

function renderNow(candidates) {
  els.nowList.replaceChildren();
  if (!candidates.length) {
    els.nowList.innerHTML = '<li class="empty">No birds detected right now. Keep listening…</li>';
    return;
  }
  for (const [i, score] of candidates) {
    const skipped = state.skipped.has(i);
    const li = document.createElement('li');
    li.className = 'now-item' + (score < state.threshold || skipped ? ' maybe' : '');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = state.labels[i].commonName +
      (skipped ? ' (skipped)' : score < state.threshold ? ' (possible)' : '');
    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = `${Math.round(score * 100)}%`;
    const meter = document.createElement('div');
    meter.className = 'meter';
    meter.innerHTML = `<div style="width:${(score * 100).toFixed(1)}%"></div>`;
    li.append(name, pct, meter);
    els.nowList.append(li);
  }
}

/**
 * Adds or updates a species in the "identified" log.
 * Returns true when this is a new encounter (first time or after a gap).
 */
function recordDetection(index, score, when, note) {
  const skippedEntry = state.skipped.get(index);
  if (skippedEntry) {
    // Keep counting quietly so the user can see if the bird is really around.
    if (note || when - skippedEntry.lastSeen > NEW_ENCOUNTER_GAP_MS) skippedEntry.heardSinceSkip++;
    skippedEntry.lastSeen = when;
    skippedEntry.best = Math.max(skippedEntry.best, score);
    renderSkipped();
    return false;
  }
  let entry = state.log.get(index);
  let isNew = false;
  if (!entry) {
    entry = { index, count: 0, best: 0, lastSeen: 0, sightingId: null };
    entry.el = createLogItem(entry);
    state.log.set(index, entry);
    els.logList.querySelector('.empty')?.remove();
    els.logCount.textContent = state.log.size;
  }
  if (note || when - entry.lastSeen > NEW_ENCOUNTER_GAP_MS) {
    entry.count++;
    isNew = true;
  }
  entry.best = Math.max(entry.best, score);
  entry.lastSeen = when;
  entry.note = note;
  updateLogStats(entry);

  // Keep the most recently heard bird at the top.
  if (els.logList.firstElementChild !== entry.el) els.logList.prepend(entry.el);
  if (isNew) {
    entry.el.classList.remove('fresh');
    void entry.el.offsetWidth;
    entry.el.classList.add('fresh');
  }
  return isNew;
}

function createLogItem(entry) {
  const { commonName, scientificName } = state.labels[entry.index];
  const el = els.logItemTpl.content.firstElementChild.cloneNode(true);
  el.querySelector('.name').textContent = commonName;
  el.querySelector('.sci').textContent = scientificName;
  el.querySelector('.thumb span').textContent = commonName[0];
  loadThumbnail(scientificName, el.querySelector('.thumb'));

  const detailsBtn = el.querySelector('.details-btn');
  const detail = el.querySelector('.detail');
  const ref = detail.querySelector('.ref');
  detailsBtn.addEventListener('click', () => {
    const open = detail.hidden;
    detail.hidden = !open;
    detailsBtn.setAttribute('aria-expanded', String(open));
    if (open && !ref.dataset.loaded) {
      ref.dataset.loaded = '1';
      renderDetail(ref, scientificName);
    }
  });
  el.querySelector('.act.save').addEventListener('click', () => toggleSaved(entry));
  el.querySelector('.act.remove').addEventListener('click', () => removeFromLog(entry.index));
  el.querySelector('.act.skip').addEventListener('click', () => skipBird(entry));
  return el;
}

function updateLogStats(entry) {
  const stats = entry.el.querySelector('.stats');
  const when = entry.note || `last heard ${new Date(entry.lastSeen).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
  stats.innerHTML = `best <b>${Math.round(entry.best * 100)}%</b> · heard <b>${entry.count}×</b> · `;
  stats.append(when);
}

/** Skipping keeps the bird's clips in case it's restored; removing discards them. */
function removeFromLog(index, { keepClips = false } = {}) {
  const entry = state.log.get(index);
  if (!entry) return;
  if (refAudio.button && entry.el.contains(refAudio.button)) refAudio.stop();
  if (!keepClips) releaseClips(entry);
  entry.el.remove();
  state.log.delete(index);
  els.logCount.textContent = state.log.size;
  if (!state.log.size) els.logList.innerHTML = '<li class="empty">Birds you hear will collect here.</li>';
}

function skipBird(entry) {
  removeFromLog(entry.index, { keepClips: true });
  entry.heardSinceSkip = 0;
  entry.skippedAt = Date.now();
  state.skipped.set(entry.index, entry);
  renderSkipped();
}

/** Puts a skipped bird back in the identified list, history intact. */
function restoreBird(index) {
  const entry = state.skipped.get(index);
  if (!entry) return;
  state.skipped.delete(index);
  entry.count += entry.heardSinceSkip;
  updateLogStats(entry);
  state.log.set(index, entry);
  els.logList.querySelector('.empty')?.remove();
  els.logList.prepend(entry.el);
  els.logCount.textContent = state.log.size;
  renderSkipped();
}

function renderSkipped() {
  const n = state.skipped.size;
  els.skippedBox.hidden = n === 0;
  els.skippedCount.textContent = n;
  els.skippedList.replaceChildren(...[...state.skipped.values()].map(entry => {
    const li = h('li', 'skipped-item');
    const text = h('div');
    text.append(h('div', 'name', state.labels[entry.index].commonName));
    const heard = entry.heardSinceSkip;
    const stats = h('div', 'stats' + (heard ? ' active' : ''), heard
      ? `heard ${heard}× since you skipped it · last ${formatClock(entry.lastSeen)}`
      : 'not heard since you skipped it');
    text.append(stats);
    const restore = h('button', 'act', 'Restore');
    restore.type = 'button';
    restore.title = 'Put back in the identified list';
    restore.addEventListener('click', () => restoreBird(entry.index));
    li.append(text, restore);
    return li;
  }));
}

function formatClock(ms, seconds = false) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(seconds && { second: '2-digit' }) });
}

const thumbCache = new Map();
async function loadThumbnail(scientificName, el) {
  try {
    if (!thumbCache.has(scientificName)) {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(scientificName.replace(/ /g, '_'))}`;
      thumbCache.set(scientificName, fetch(url).then(r => (r.ok ? r.json() : null)).then(j => j?.thumbnail?.source));
    }
    const src = await thumbCache.get(scientificName);
    if (src) setBackground(el, src);
  } catch { /* offline: keep the initial-letter placeholder */ }
}

function setBackground(el, src) {
  if (!/^https:\/\//.test(src)) return;
  el.style.backgroundImage = `url("${src.replace(/"/g, '%22')}")`;
  el.classList.add('has-img');
}

function clearLog() {
  refAudio.stop();
  state.log.forEach(releaseClips);
  state.log.clear();
  els.logCount.textContent = '0';
  els.logList.innerHTML = '<li class="empty">Birds you hear will collect here.</li>';
}

/* ---------------------------------------------------------------------------
   Heard clips: the audio behind each identification
   ------------------------------------------------------------------------- */

/**
 * Keeps the strongest 3 s window of each encounter as a playable clip. One call
 * fires several overlapping windows (0.5 s apart); the best-scoring one wins.
 */
function keepClip(entry, score, pcm) {
  if (!entry) return; // skipped birds don't collect clips
  entry.clips ??= [];
  const current = entry.clips.find(c => c.encounter === entry.count);
  if (current && score <= current.score) return;
  const clip = { encounter: entry.count, score, at: Date.now(), url: URL.createObjectURL(encodeClip(pcm)) };
  if (current) {
    URL.revokeObjectURL(current.url);
    entry.clips[entry.clips.indexOf(current)] = clip;
  } else {
    entry.clips.push(clip);
    if (entry.clips.length > CLIPS_PER_BIRD) {
      // Make room by dropping the weakest earlier clip.
      const weakest = entry.clips.slice(0, -1).reduce((a, b) => (b.score < a.score ? b : a));
      URL.revokeObjectURL(weakest.url);
      entry.clips.splice(entry.clips.indexOf(weakest), 1);
    }
  }
  renderClips(entry);
}

function releaseClips(entry) {
  if (!entry.clips?.length) return;
  entry.clips.forEach(c => URL.revokeObjectURL(c.url));
  entry.clips = [];
  renderClips(entry);
}

/** 16-bit WAV, peak-normalized so faint, distant birds are audible, with short fades against clicks. */
function encodeClip(pcm) {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  const gain = peak > 0 ? Math.min(20, 0.9 / peak) : 1;
  const fade = Math.round(0.01 * MODEL_RATE);
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const env = Math.min(1, i / fade, (pcm.length - 1 - i) / fade);
    const s = Math.max(-1, Math.min(1, pcm[i] * gain * env));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Blob([wavHeader(out.byteLength), out], { type: 'audio/wav' });
}

function renderClips(entry) {
  const box = entry.el.querySelector('.heard');
  const clips = [...(entry.clips ?? [])].sort((a, b) => a.at - b.at);
  const detailsBtn = entry.el.querySelector('.details-btn');
  detailsBtn.textContent = clips.length ? `Details · ${clips.length} clip${clips.length > 1 ? 's' : ''}` : 'Details';
  box.hidden = !clips.length;
  if (!clips.length) {
    box.replaceChildren();
    return;
  }
  const { commonName } = state.labels[entry.index];
  const row = h('div', 'sound-row');
  for (const clip of clips) {
    const time = formatClock(clip.at, true);
    const btn = h('button', 'sound');
    btn.type = 'button';
    btn.title = `Play what Birdsong heard at ${time}`;
    btn.innerHTML = PLAY_ICON;
    btn.append(time, h('span', 'dur', `${Math.round(clip.score * 100)}%`));
    btn.addEventListener('click', () => refAudio.toggle(btn, clip.url));
    refAudio.adopt(btn, clip.url); // keep a playing clip's button live across re-renders
    const download = h('a', 'clip-dl');
    download.href = clip.url;
    download.download = `${commonName} ${time.replace(/:/g, '.')}.wav`;
    download.title = 'Download this clip';
    download.setAttribute('aria-label', download.title);
    download.innerHTML = DOWNLOAD_ICON;
    const pair = h('span', 'clip');
    pair.append(btn, download);
    row.append(pair);
  }
  box.replaceChildren(h('h4', '', 'Heard by Birdsong'), row);
}

/* ---------------------------------------------------------------------------
   Bird details: photos, reference sounds, facts
   ------------------------------------------------------------------------- */

const birdInfoCache = new Map();
function fetchBirdInfo(scientificName) {
  if (!birdInfoCache.has(scientificName)) {
    const label = state.labels.find(l => l.scientificName === scientificName);
    const p = backend.birdInfo(scientificName, label?.commonName ?? scientificName);
    p.catch(() => birdInfoCache.delete(scientificName)); // allow retry
    birdInfoCache.set(scientificName, p);
  }
  return birdInfoCache.get(scientificName);
}

async function renderDetail(container, scientificName) {
  container.innerHTML = '<p class="loading">Loading photos, sounds and notes…</p>';
  let info;
  try {
    info = await fetchBirdInfo(scientificName);
  } catch {
    container.innerHTML = '<p class="loading">Couldn’t load details. Check your connection and try again.</p>';
    delete container.dataset.loaded;
    return;
  }
  container.replaceChildren();

  // The range map leads the rail and opens in the viewer like a photo.
  const slides = [...(info.taxonId ? [{ map: true }] : []), ...info.photos];
  if (slides.length) {
    const strip = h('div', 'photo-strip');
    slides.forEach((slide, n) => {
      const btn = h('button', 'photo');
      btn.type = 'button';
      btn.addEventListener('click', () => openLightbox(slides, n, info));
      strip.append(btn);
      if (slide.map) {
        btn.classList.add('map-thumb');
        btn.setAttribute('aria-label', 'Range map, enlarge');
        // Drawn once laid out, so the map is fitted to the tile's real size.
        requestAnimationFrame(() => btn.prepend(renderMap(info, btn.clientWidth || 168, btn.clientHeight || 126)));
        btn.append(h('span', 'sex', 'Range map'));
        return;
      }
      btn.title = slide.credit || '';
      btn.setAttribute('aria-label', `${slide.label || 'Photo'}, enlarge`);
      setBackground(btn, slide.thumb);
      if (slide.label) btn.append(h('span', 'sex', `${slide.label === 'Male' ? '♂' : '♀'} ${slide.label}`));
    });
    container.append(strip);
  }

  const sounds = h('div', 'sound-row');
  if (info.sounds.length) {
    const typeCounts = {};
    info.sounds.forEach(s => { typeCounts[s.type] = (typeCounts[s.type] || 0) + 1; });
    const seen = {};
    for (const sound of info.sounds) {
      seen[sound.type] = (seen[sound.type] || 0) + 1;
      let label = sound.type === 'recording' ? 'Recording' : capitalize(sound.type);
      if (typeCounts[sound.type] > 1) label += ` ${seen[sound.type]}`;
      if (sound.sex) label += sound.sex === 'male' ? ' ♂' : ' ♀';
      const btn = h('button', 'sound');
      btn.type = 'button';
      btn.title = sound.credit || '';
      btn.innerHTML = PLAY_ICON;
      btn.append(label);
      if (sound.seconds) btn.append(h('span', 'dur', formatTime(sound.seconds)));
      btn.addEventListener('click', () => refAudio.toggle(btn, sound.url));
      sounds.append(btn);
    }
  } else {
    sounds.append(h('span', 'loading', 'No reference recordings found.'));
  }
  container.append(sounds);

  container.append(renderFacts(info));
  container.append(renderLinks(info, scientificName));

  const credits = h('p', 'credits');
  const parts = [];
  if (info.photos.length) parts.push('Photos: iNaturalist');
  if (info.sounds.length) parts.push(`Sounds: ${info.soundsSource === 'xeno-canto' ? 'xeno-canto' : 'iNaturalist'}`);
  if (info.factsSource) parts.push(`Notes: ${info.factsSource === 'claude' ? 'Claude' : 'Wikipedia'}`);
  credits.textContent = `${parts.join(' · ')} (hover or open a photo for credits)`;
  container.append(credits);
}

/** Field guides, recordings and videos about the species, all by name so they work for any bird. */
function renderLinks(info, scientificName) {
  const q = encodeURIComponent;
  const commonName = info.commonName || scientificName;
  const links = [
    ['All About Birds', `https://www.allaboutbirds.org/news/search/?q=${q(commonName)}`],
    ['Wikipedia', info.wikiUrl || `https://en.wikipedia.org/wiki/${q(scientificName.replace(/ /g, '_'))}`],
    ['iNaturalist', info.taxonId
      ? `https://www.inaturalist.org/taxa/${info.taxonId}`
      : `https://www.inaturalist.org/taxa/search?q=${q(scientificName)}`],
    ['xeno-canto recordings', `https://xeno-canto.org/species/${scientificName.replace(/ /g, '-')}`],
    ['YouTube: songs & calls', `https://www.youtube.com/results?search_query=${q(`${commonName} bird song`)}`],
    ['YouTube: how to identify', `https://www.youtube.com/results?search_query=${q(`${commonName} bird identification`)}`],
  ];
  const box = h('div', 'learn');
  const row = h('div', 'link-row');
  for (const [text, href] of links) {
    const a = h('a', 'link-chip', `${text} ↗`);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    row.append(a);
  }
  box.append(h('h4', '', 'Learn more'), row);
  return box;
}

function renderFacts(info) {
  const facts = h('div', 'facts');
  const f = info.facts;
  if (!f) {
    facts.append(h('p', 'loading', 'No notes available for this species.'));
    return facts;
  }
  if (f.summary) {
    facts.append(h('p', 'summary', f.summary));
    return facts;
  }
  const section = (title, content, asParagraphs = false) => {
    if (!content || (Array.isArray(content) && !content.length)) return;
    facts.append(h('h4', '', title));
    if (Array.isArray(content) && asParagraphs) {
      content.forEach(item => facts.append(h('p', '', item)));
    } else if (Array.isArray(content)) {
      const ul = h('ul');
      content.forEach(item => ul.append(h('li', '', item)));
      facts.append(ul);
    } else {
      facts.append(h('p', '', content));
    }
  };
  // Where it lives is on the map; the notes stick to how to recognize it.
  if (f.sections) { // excerpts from the Wikipedia article
    section('What it sounds like', f.sections.voice, true);
    section('Behavior', f.sections.behavior, true);
    section('What to look for', f.sections.looks, true);
    return facts;
  }
  section('What it sounds like', f.voice);
  section('ID tricks', f.idTips);
  section('Behavior', f.behaviors);
  section('Male vs. female', f.maleVsFemale);
  section('Easily confused with', f.confusedWith);
  section('Fun facts', f.funFacts);
  return facts;
}

/* Range map: static map tiles positioned in percentages, so the map scales with its box. */
const TILE = 256;

/** Web Mercator at zoom 0, in tile pixels. */
const mercX = lng => ((lng + 180) / 360) * TILE;
function mercY(lat) {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE;
}

/** A `width` x `height` (CSS px) map fitted to where most sightings are; the world without a sample. */
function renderMap(info, width, height) {
  const MAP_W = width;
  const MAP_H = height;
  const b = info.mapBounds;
  let zoom = 0;
  let cx = TILE / 2;
  let cy = mercY(20);
  if (b) {
    const [x0, x1, y0, y1] = [mercX(b.west), mercX(b.east), mercY(b.north), mercY(b.south)];
    const fit = Math.min(MAP_W / (1.3 * Math.max(x1 - x0, 0.05)), MAP_H / (1.3 * Math.max(y1 - y0, 0.05)));
    zoom = Math.max(0, Math.min(7, Math.floor(Math.log2(fit))));
    cx = (x0 + x1) / 2;
    cy = (y0 + y1) / 2;
  }
  const scale = 2 ** zoom;
  cx *= scale;
  cy = TILE * scale <= MAP_H ? TILE * scale / 2 // nothing past the poles
    : Math.max(MAP_H / 2, Math.min(TILE * scale - MAP_H / 2, cy * scale));
  const left = cx - MAP_W / 2;
  const top = cy - MAP_H / 2;
  const pct = (v, of) => `${((v / of) * 100).toFixed(3)}%`;

  const layers = [
    (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, // greyed out in CSS
    (z, x, y) => `https://tiles.inaturalist.org/v1/taxon_ranges/${info.taxonId}/${z}/${x}/${y}.png`,
    (z, x, y) => `https://api.inaturalist.org/v1/grid/${z}/${x}/${y}.png?taxon_id=${info.taxonId}&verifiable=true`,
  ];
  const map = h('div', 'range-map');
  map.style.aspectRatio = `${MAP_W} / ${MAP_H}`;
  for (const url of layers) {
    const layer = h('div', 'layer');
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + MAP_H - 1) / TILE); ty++) {
      if (ty < 0 || ty >= scale) continue;
      for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + MAP_W - 1) / TILE); tx++) {
        const img = h('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = url(zoom, ((tx % scale) + scale) % scale, ty); // tiles repeat east-west
        img.style.cssText = `left:${pct(tx * TILE - left, MAP_W)};top:${pct(ty * TILE - top, MAP_H)};` +
          `width:${pct(TILE, MAP_W)};height:${pct(TILE, MAP_H)}`;
        img.onerror = () => img.remove(); // most species have no published range map
        layer.append(img);
      }
    }
    map.append(layer);
  }

  if (state.position) {
    const y = mercY(state.position.latitude) * scale - top;
    const world = TILE * scale;
    const x = [0, world, -world].map(d => mercX(state.position.longitude) * scale + d - left).find(v => v >= 0 && v <= MAP_W);
    if (x != null && y >= 0 && y <= MAP_H) {
      const dot = h('span', 'you');
      dot.title = 'You are here';
      dot.style.cssText = `left:${pct(x, MAP_W)};top:${pct(y, MAP_H)}`;
      map.append(dot);
      map.dataset.you = '1';
    }
  }
  map.append(h('span', 'map-credit', '© OpenStreetMap'));
  return map;
}

/** Key and links shown under the enlarged map. */
function mapCaption(info, map) {
  const legend = h('span', 'map-legend');
  legend.innerHTML = '<span class="key range"></span>Range <span class="key obs"></span>Sightings' +
    (map.dataset.you ? ' <span class="key me"></span>You' : '');
  const link = (text, href) => {
    const a = h('a', '', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  };
  legend.append(link('Explore map ↗', `https://www.inaturalist.org/observations?taxon_id=${info.taxonId}&subview=map`));
  return legend;
}

/* Photo viewer: full-resolution photos to pinch-zoom; swipe, arrow keys or ‹ › to browse. */
const lightbox = {
  photos: [], index: 0, info: null, touchX: null,
  box: els.lightbox,
  stage: els.lightbox.querySelector('.lb-stage'),
  img: els.lightbox.querySelector('img'),
};

/** `photos` are the rail's slides: photos, and possibly the range map (`{ map: true }`). */
function openLightbox(photos, index, info) {
  Object.assign(lightbox, { photos, info });
  lightbox.box.showModal(); // first, so the stage has a size to fit the map to
  showPhoto(index);
}

function showPhoto(index) {
  const { photos, info, box, img, stage } = lightbox;
  const name = info.commonName;
  lightbox.index = (index + photos.length) % photos.length;
  const photo = photos[lightbox.index];
  box.querySelector('.lb-count').textContent = photos.length > 1 ? `${lightbox.index + 1} / ${photos.length}` : '';
  box.classList.toggle('single', photos.length < 2);
  stage.querySelector('.range-map')?.remove();
  img.hidden = !!photo.map;
  if (photo.map) {
    // Redrawn at the viewer's size so it zooms in further than the thumbnail.
    const w = stage.clientWidth;
    const map = renderMap(info, w, Math.min(stage.clientHeight, Math.round(w * 0.75)));
    stage.prepend(map);
    box.querySelector('.caption').replaceChildren(mapCaption(info, map));
    return;
  }
  // Show the 1024 px version (usually preloaded) at once, then swap in the original.
  img.src = photo.full;
  if (photo.original && photo.original !== photo.full) {
    const original = new Image();
    original.onload = () => {
      if (lightbox.photos[lightbox.index] === photo) img.src = photo.original;
    };
    original.src = photo.original;
  }
  img.alt = `${name}${photo.label ? `, ${photo.label.toLowerCase()}` : ''}`;
  box.querySelector('.caption').textContent = [name, photo.label, photo.credit].filter(Boolean).join(' · ');
  // Preload the neighbours so browsing feels instant.
  for (const d of [1, -1]) {
    const next = photos[(lightbox.index + d + photos.length) % photos.length];
    if (next.full) new Image().src = next.full;
  }
}

const DOWNLOAD_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PLAY_ICON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>';
const STOP_ICON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor"/></svg>';

/** One shared player for reference recordings. */
const refAudio = {
  el: new Audio(),
  button: null,
  url: null,
  quietUntil: 0,

  toggle(button, url) {
    if (this.button === button) {
      this.stop();
      return;
    }
    this.stop();
    this.button = button;
    this.url = url;
    button.classList.add('playing');
    button.querySelector('.icon').outerHTML = STOP_ICON;
    this.el.src = url;
    this.el.play().catch(() => {
      this.stop();
      button.title = 'This recording could not be played.';
      button.disabled = true;
    });
  },

  stop() {
    this.el.pause();
    if (this.button) {
      this.button.classList.remove('playing');
      this.button.style.setProperty('--p', '0%');
      this.button.querySelector('.icon').outerHTML = PLAY_ICON;
      this.button = null;
      this.url = null;
      // Let the 3 s analysis window clear the playback before detecting again.
      this.quietUntil = Date.now() + 3500;
    }
  },

  /** Moves the playing state onto a re-rendered button for the same sound. */
  adopt(button, url) {
    if (!this.button || this.url !== url) return;
    this.button = button;
    button.classList.add('playing');
    button.querySelector('.icon').outerHTML = STOP_ICON;
  },

  blocking() {
    return !!this.button || state.playbackPaused || Date.now() < this.quietUntil;
  },
};
refAudio.el.preload = 'none';
refAudio.el.addEventListener('timeupdate', () => {
  const { currentTime, duration } = refAudio.el;
  if (refAudio.button && duration) refAudio.button.style.setProperty('--p', `${(currentTime / duration) * 100}%`);
});
refAudio.el.addEventListener('ended', () => refAudio.stop());

/* ---------------------------------------------------------------------------
   Saved sightings
   ------------------------------------------------------------------------- */

/** Save toggles a verified sighting; clicking again ("Unsave") deletes it. */
async function toggleSaved(entry) {
  const button = entry.el.querySelector('.act.save');
  button.disabled = true;
  try {
    if (entry.sightingId) {
      await deleteSighting(entry.sightingId);
    } else {
      const { scientificName, commonName } = state.labels[entry.index];
      const sighting = await backend.sightings.add({
        scientificName,
        commonName,
        confidence: entry.best,
        seenAt: new Date(entry.lastSeen).toISOString(),
        latitude: state.position?.latitude ?? null,
        longitude: state.position?.longitude ?? null,
        source: entry.note || 'live',
      });
      state.sightings.unshift(sighting);
      entry.sightingId = sighting.id;
      renderSightings();
    }
    updateSaveButton(entry);
  } catch (err) {
    console.error(err);
    button.title = 'Couldn’t update your sightings. Please try again.';
  } finally {
    button.disabled = false;
  }
}

function updateSaveButton(entry) {
  const button = entry.el.querySelector('.act.save');
  const saved = !!entry.sightingId;
  button.classList.toggle('saved', saved);
  button.setAttribute('aria-pressed', String(saved));
  button.querySelector('.lbl').textContent = saved ? 'Saved' : 'Save';
  button.title = saved ? 'Saved to My sightings. Click to unsave.' : 'Save as a verified sighting';
  button.setAttribute('aria-label', button.title);
}

async function deleteSighting(id) {
  await backend.sightings.remove(id);
  state.sightings = state.sightings.filter(x => x.id !== id);
  renderSightings();
  // Keep any list entry that created this sighting in sync.
  for (const entry of [...state.log.values(), ...state.skipped.values()]) {
    if (entry.sightingId === id) {
      entry.sightingId = null;
      updateSaveButton(entry);
    }
  }
}

async function loadSightings() {
  try {
    state.sightings = await backend.sightings.list();
  } catch (err) {
    console.error(err);
  }
  renderSightings();
}

function renderSightings() {
  els.savedCount.textContent = state.sightings.length;
  if (!state.sightings.length) {
    els.savedList.innerHTML = '<li class="empty">Tap <strong>Save</strong> on a bird you’ve confirmed to keep it here.</li>';
    return;
  }
  els.savedList.replaceChildren(...state.sightings.map(s => {
    const el = els.savedItemTpl.content.firstElementChild.cloneNode(true);
    el.querySelector('.name').textContent = s.commonName;
    el.querySelector('.thumb span').textContent = s.commonName[0];
    loadThumbnail(s.scientificName, el.querySelector('.thumb'));
    const when = new Date(s.seenAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const bits = [when];
    if (s.confidence != null) bits.push(`${Math.round(s.confidence * 100)}%`);
    if (s.latitude != null) bits.push(`${s.latitude.toFixed(2)}°, ${s.longitude.toFixed(2)}°`);
    el.querySelector('.stats').textContent = bits.join(' · ');
    el.querySelector('.act.remove').addEventListener('click', () => deleteSighting(s.id).catch(console.error));
    return el;
  }));
}

function h(tag, className = '', text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------------------
   Location filter
   ------------------------------------------------------------------------- */

function enableGeo() {
  if (!state.workerReady) return;
  if (!navigator.geolocation) {
    els.geoNote.textContent = 'Location isn’t available in this browser.';
    els.geoToggle.checked = false;
    return;
  }
  els.geoNote.textContent = 'Getting your location…';
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      if (!els.geoToggle.checked) return; // switched off while the fix was pending
      state.position = { latitude: coords.latitude, longitude: coords.longitude };
      requestGeoScores();
      // Show the fix so a wrong one (e.g. an IP-based guess) is easy to spot.
      const km = Math.round(coords.accuracy / 1000);
      els.geoNote.textContent = `Filtering for ${coords.latitude.toFixed(2)}°, ${coords.longitude.toFixed(2)}°` +
        (coords.accuracy > COARSE_FIX_M ? ` (approximate, within about ${km} km)` : '') + ' this week of the year.';
      saveSetting('birdsong.geo', '1');
    },
    err => {
      els.geoToggle.checked = false;
      els.geoNote.textContent = `Couldn’t get location (${err.message}).`;
    },
    { maximumAge: 3600_000, timeout: 15000 }
  );
}

function requestGeoScores() {
  state.geoWeek = birdnetWeek(new Date());
  state.worker.postMessage({ type: 'area', ...state.position, week: state.geoWeek });
}

/** A session left open past a week boundary gets that week's scores. */
function refreshGeoWeek() {
  if (state.position && state.geoWeek !== birdnetWeek(new Date())) requestGeoScores();
}

function disableGeo() {
  state.geoScores = null;
  state.geoWeek = null;
  state.position = null;
  els.geoNote.textContent = 'Uses your location and the time of year to rule out unlikely birds.';
  saveSetting('birdsong.geo', '0');
}

/* ---------------------------------------------------------------------------
   UI plumbing
   ------------------------------------------------------------------------- */

function setStatus(text, kind = '') {
  els.statusText.textContent = text;
  els.status.className = `status ${kind}`;
}

function setListeningUI(on) {
  els.listenBtn.setAttribute('aria-pressed', String(on));
  els.listenLabel.textContent = on ? 'Stop listening' : 'Start listening';
  if (!on) {
    els.inferMeta.textContent = '';
  } else {
    els.nowList.innerHTML = '<li class="empty">Listening… the first result arrives after 3 seconds.</li>';
  }
}

function loadString(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function loadNumber(key, fallback) {
  try {
    const v = parseFloat(localStorage.getItem(key));
    return Number.isFinite(v) ? v : fallback;
  } catch { return fallback; }
}

function saveSetting(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

els.listenBtn.addEventListener('click', () => (state.listening ? stopListening() : startListening()));
els.recordBtn.addEventListener('click', async () => {
  if (recordings.isRecording()) {
    recordings.stopRecording();
    return;
  }
  // Recording starts listening too. startListening() must run synchronously in
  // this click handler so the browser lets its AudioContext start.
  if (!state.listening) await startListening();
  if (state.listening) recordings.startRecording();
});
els.clearBtn.addEventListener('click', clearLog);
els.micSelect.addEventListener('change', () => {
  saveSetting('birdsong.mic', els.micSelect.value);
  // Switch immediately if we're already listening.
  if (state.listening) {
    stopListening({ keepRecording: true });
    startListening();
  }
});
navigator.mediaDevices?.addEventListener('devicechange', refreshMicList);
refreshMicList();
els.threshold.value = Math.round(state.threshold * 100);
els.thresholdOut.textContent = `${els.threshold.value}%`;
els.threshold.addEventListener('input', () => {
  state.threshold = els.threshold.value / 100;
  els.thresholdOut.textContent = `${els.threshold.value}%`;
  saveSetting('birdsong.threshold', String(state.threshold));
});
if (!(state.noiseFilter in NOISE_FILTERS)) state.noiseFilter = 'off';
els.noiseFilter.value = state.noiseFilter;
els.noiseFilter.addEventListener('change', () => {
  state.noiseFilter = els.noiseFilter.value;
  saveSetting('birdsong.noiseFilter', state.noiseFilter);
  audio.filter?.setCutoff(noiseCutoff());
});
els.clipsToggle.checked = state.keepClips;
els.clipsToggle.addEventListener('change', () => {
  state.keepClips = els.clipsToggle.checked;
  saveSetting('birdsong.clips', state.keepClips ? '1' : '0');
});
els.geoToggle.checked = loadNumber('birdsong.geo', 0) === 1;
els.geoToggle.addEventListener('change', () => (els.geoToggle.checked ? enableGeo() : disableGeo()));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.listening && !audio.wakeLock) requestWakeLock();
});

if (!window.isSecureContext) {
  setStatus('Needs HTTPS or localhost', 'error');
  els.hint.textContent = 'Browsers only allow microphone access on https:// pages or http://localhost.';
}
lightbox.box.querySelector('.prev').addEventListener('click', () => showPhoto(lightbox.index - 1));
lightbox.box.querySelector('.next').addEventListener('click', () => showPhoto(lightbox.index + 1));
lightbox.box.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') showPhoto(lightbox.index - 1);
  else if (e.key === 'ArrowRight') showPhoto(lightbox.index + 1);
});
lightbox.stage.addEventListener('click', e => {
  if (e.target === lightbox.stage) lightbox.box.close(); // tap on the dark area around the photo
});
lightbox.stage.addEventListener('touchstart', e => {
  // One finger on an unzoomed page: a swipe browses.
  const zoomed = (window.visualViewport?.scale ?? 1) > 1.01;
  lightbox.touchX = e.touches.length === 1 && !zoomed ? e.touches[0].clientX : null;
}, { passive: true });
lightbox.stage.addEventListener('touchend', e => {
  if (lightbox.touchX == null) return;
  const dx = e.changedTouches[0].clientX - lightbox.touchX;
  lightbox.touchX = null;
  if (Math.abs(dx) > 50) showPhoto(lightbox.index + (dx < 0 ? 1 : -1));
});

const recordings = createRecordings({
  backend, els, h, formatTime, COLORMAP, predict, filterNoise, plausibleHits, recordDetection,
  labelOf: i => state.labels[i],
  threshold: () => state.threshold,
  isListening: () => state.listening,
  // Playing a recording through the speakers would be "heard" by the mic.
  pauseDetections: on => {
    state.playbackPaused = on;
    if (!on) refAudio.quietUntil = Date.now() + 3500;
  },
});

if (backend.kind === 'browser') {
  $('savedMeta').textContent = 'saved in this browser';
  $('recMeta').textContent = 'saved in this browser';
}

startWorker();
loadSightings();
