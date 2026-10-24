// Computes a whole-recording spectrogram (0-12 kHz) for the playback view.
// In:  { pcm: Float32Array (mono), sampleRate }
// Out: { spec: Uint8Array (cols x BINS, column-major), cols, colsPerSec, bins }

const FFT_SIZE = 1024;
const MAX_FREQ = 12000;

onmessage = ({ data: { pcm, sampleRate } }) => {
  const duration = pcm.length / sampleRate;
  const hop = duration > 1200 ? FFT_SIZE : FFT_SIZE / 2;
  const bins = Math.min(FFT_SIZE / 2, Math.floor(MAX_FREQ / (sampleRate / FFT_SIZE)));
  const cols = Math.max(1, Math.floor((pcm.length - FFT_SIZE) / hop) + 1);
  const db = new Float32Array(cols * bins);

  const window = Float32Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const fft = makeFft(FFT_SIZE);

  let max = -Infinity;
  for (let c = 0; c < cols; c++) {
    const off = c * hop;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = (pcm[off + i] || 0) * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      const v = 10 * Math.log10(re[b] * re[b] + im[b] * im[b] + 1e-12);
      db[c * bins + b] = v;
      if (v > max) max = v;
    }
    if (c % 2000 === 0) postMessage({ progress: c / cols });
  }

  // Measure each frequency bin against its own typical (median) level, so steady
  // background noise fades and calls stand out. Show 0-30 dB above that floor.
  const spec = new Uint8Array(cols * bins);
  const step = Math.max(1, Math.floor(cols / 3000));
  const sample = new Float32Array(Math.ceil(cols / step));
  for (let b = 0; b < bins; b++) {
    let n = 0;
    for (let c = 0; c < cols; c += step) sample[n++] = db[c * bins + b];
    const sorted = sample.subarray(0, n).sort();
    const floor = Math.max(sorted[n >> 1], max - 90);
    for (let c = 0; c < cols; c++) {
      const v = ((db[c * bins + b] - floor) / 30) * 255;
      spec[c * bins + b] = v <= 0 ? 0 : v >= 255 ? 255 : v;
    }
  }
  postMessage({ spec, cols, colsPerSec: sampleRate / hop, bins }, [spec.buffer]);
};

/** In-place iterative radix-2 FFT. */
function makeFft(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j;
          const b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}
