/**
 * BirdNET inference worker.
 *
 * Loads the BirdNET v2.4 TF.js model (raw 48 kHz audio in, ~6,500 class
 * probabilities out) plus the optional location/season "area" model.
 *
 * The MelSpecLayerSimple layer and WebGL STFT kernel are taken from
 * BirdNET Live (https://github.com/birdnet-team/real-time-pwa, MIT), which is
 * itself based on https://github.com/georg95/birdnet-web.
 */

importScripts('vendor/tf.min.js');

const MODEL_PATH = 'models/birdnet/model.json';
const AREA_MODEL_PATH = 'models/birdnet/area-model/model.json';
const LABELS_PATH = 'models/birdnet/labels/en_us.txt';

const SAMPLE_RATE = 48000;
const WINDOW_SAMPLES = 144000; // 3 s
const MAX_BATCH = 16; // frames per predict() call when analysing long files
const MIN_REPORTED = 0.03; // drop near-zero scores before posting back

// Classes that are sounds rather than species.
const NON_SPECIES = new Set([
  'Dog', 'Engine', 'Environmental', 'Fireworks', 'Gun', 'Human non-vocal',
  'Human vocal', 'Human whistle', 'Noise', 'Power tools', 'Siren',
]);

let birdModel = null;
let areaModel = null;
let labels = []; // { scientificName, commonName, isSpecies }

/* ---------------------------------------------------------------------------
   Custom layer + kernel required by the model
   ------------------------------------------------------------------------- */

class MelSpecLayerSimple extends tf.layers.Layer {
  constructor(config) {
    super(config);
    this.sampleRate = config.sampleRate;
    this.specShape = config.specShape;
    this.frameStep = config.frameStep;
    this.frameLength = config.frameLength;
    this.melFilterbank = tf.tensor2d(config.melFilterbank);
  }

  build() {
    this.magScale = this.addWeight(
      'magnitude_scaling', [], 'float32',
      tf.initializers.constant({ value: 1.23 })
    );
    super.build();
  }

  computeOutputShape(inputShape) {
    return [inputShape[0], this.specShape[0], this.specShape[1], 1];
  }

  call(inputs) {
    return tf.tidy(() => {
      const x = inputs[0];
      return tf.stack(x.split(x.shape[0]).map(input => {
        let spec = input.squeeze();
        spec = tf.sub(spec, tf.min(spec, -1, true));
        spec = tf.div(spec, tf.max(spec, -1, true).add(1e-6));
        spec = tf.sub(spec, 0.5).mul(2.0);
        spec = tf.engine().runKernel('STFT', {
          signal: spec,
          frameLength: this.frameLength,
          frameStep: this.frameStep
        });
        spec = tf.matMul(spec, this.melFilterbank).pow(2.0);
        spec = spec.pow(tf.div(1.0, tf.add(1.0, tf.exp(this.magScale.read()))));
        spec = tf.reverse(spec, -1);
        spec = tf.transpose(spec).expandDims(-1);
        return spec;
      }));
    });
  }

  static get className() { return 'MelSpecLayerSimple'; }
}

tf.registerKernel({
  kernelName: 'STFT',
  backendName: 'webgl',
  kernelFunc: ({ backend, inputs: { signal, frameLength, frameStep } }) => {
    const innerDim = frameLength / 2;
    const batch = (signal.size - frameLength + frameStep) / frameStep | 0;

    // Windowing & bit-reversal
    let currentTensor = backend.runWebGLProgram({
      variableNames: ['x'],
      outputShape: [batch, frameLength],
      userCode: `void main(){
        ivec2 c=getOutputCoords();
        int p=c[1]%${innerDim};
        int k=0;
        for(int i=0;i<${Math.log2(innerDim)};++i){
          if((p & (1<<i))!=0){ k|=(1<<(${Math.log2(innerDim) - 1}-i)); }
        }
        int i=2*k;
        if(c[1]>=${innerDim}){ i=2*(k%${innerDim})+1; }
        int q=c[0]*${frameLength}+i;
        float val=getX((q/${frameLength})*${frameStep}+ q % ${frameLength});
        float cosArg=${2.0 * Math.PI / frameLength}*float(q);
        float mul=0.5-0.5*cos(cosArg);
        setOutput(val*mul);
      }`
    }, [signal], 'float32');

    // FFT butterflies
    for (let len = 1; len < innerDim; len *= 2) {
      const prevTensor = currentTensor;
      currentTensor = backend.runWebGLProgram({
        variableNames: ['x'],
        outputShape: [batch, innerDim * 2],
        userCode: `void main(){
          ivec2 c=getOutputCoords();
          int b=c[0];
          int i=c[1];
          int k=i%${innerDim};
          int isHigh=(k%${len * 2})/${len};
          int highSign=(1 - isHigh*2);
          int baseIndex=k - isHigh*${len};
          float t=${Math.PI / len}*float(k%${len});
          float a=cos(t);
          float bsin=sin(-t);
          float oddK_re=getX(b, baseIndex+${len});
          float oddK_im=getX(b, baseIndex+${len + innerDim});
          if(i<${innerDim}){
            float evenK_re=getX(b, baseIndex);
            setOutput(evenK_re + (oddK_re*a - oddK_im*bsin)*float(highSign));
          } else {
            float evenK_im=getX(b, baseIndex+${innerDim});
            setOutput(evenK_im + (oddK_re*bsin + oddK_im*a)*float(highSign));
          }
        }`
      }, [prevTensor], 'float32');
      backend.disposeIntermediateTensorInfo(prevTensor);
    }

    // Real RFFT output
    const real = backend.runWebGLProgram({
      variableNames: ['x'],
      outputShape: [batch, innerDim + 1],
      userCode: `void main(){
        ivec2 c=getOutputCoords();
        int b=c[0];
        int i=c[1];
        int zI=i%${innerDim};
        int conjI=(${innerDim}-i)%${innerDim};
        float Zk0=getX(b,zI);
        float Zk1=getX(b,zI+${innerDim});
        float Zk_conj0=getX(b,conjI);
        float Zk_conj1=-getX(b,conjI+${innerDim});
        float t=${-2.0 * Math.PI}*float(i)/float(${innerDim * 2});
        float diff0=Zk0 - Zk_conj0;
        float diff1=Zk1 - Zk_conj1;
        float result=(Zk0+Zk_conj0 + cos(t)*diff1 + sin(t)*diff0)*0.5;
        setOutput(result);
      }`
    }, [currentTensor], 'float32');
    backend.disposeIntermediateTensorInfo(currentTensor);
    return real;
  }
});

/* ---------------------------------------------------------------------------
   Loading
   ------------------------------------------------------------------------- */

init().catch(err => {
  console.error(err);
  postMessage({ type: 'error', error: String(err && err.message || err) });
});

async function init() {
  const ok = await tf.setBackend('webgl');
  if (!ok) throw new Error('WebGL is not available in this browser, and the model requires it.');
  tf.serialization.registerClass(MelSpecLayerSimple);

  birdModel = await tf.loadLayersModel(MODEL_PATH, {
    onProgress: p => postMessage({ type: 'progress', stage: 'Downloading model', progress: p * 0.85 })
  });

  postMessage({ type: 'progress', stage: 'Warming up', progress: 0.88 });
  tf.tidy(() => birdModel.predict(tf.zeros([1, WINDOW_SAMPLES])).dataSync());

  postMessage({ type: 'progress', stage: 'Loading location model', progress: 0.94 });
  try {
    areaModel = await tf.loadGraphModel(AREA_MODEL_PATH);
  } catch (e) {
    console.warn('Area model failed to load; location filtering disabled.', e);
  }

  const text = await fetch(LABELS_PATH).then(r => r.text());
  labels = text.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const [scientificName, commonName] = line.split('_');
    return {
      scientificName,
      commonName: commonName || scientificName,
      isSpecies: !NON_SPECIES.has(scientificName),
    };
  });

  postMessage({ type: 'ready', labels, hasAreaModel: !!areaModel });
}

/* ---------------------------------------------------------------------------
   Messages
   ------------------------------------------------------------------------- */

onmessage = async ({ data }) => {
  try {
    if (data.type === 'predict') await predict(data);
    else if (data.type === 'area') await areaScores(data);
  } catch (err) {
    console.error(err);
    postMessage({ type: 'error', id: data.id, error: String(err && err.message || err) });
  }
};

/**
 * Splits `pcm` (48 kHz mono) into back-to-back 3 s frames (the last one
 * zero-padded) and returns, for each frame, the scores above MIN_REPORTED.
 */
async function predict({ id, pcm }) {
  const numFrames = Math.max(1, Math.ceil(pcm.length / WINDOW_SAMPLES));
  const frames = [];
  const t0 = performance.now();

  for (let start = 0; start < numFrames; start += MAX_BATCH) {
    const count = Math.min(MAX_BATCH, numFrames - start);
    const batch = new Float32Array(count * WINDOW_SAMPLES);
    batch.set(pcm.subarray(start * WINDOW_SAMPLES, (start + count) * WINDOW_SAMPLES));

    const input = tf.tensor2d(batch, [count, WINDOW_SAMPLES]);
    const output = birdModel.predict(input);
    const scores = await output.data();
    input.dispose();
    output.dispose();

    const numClasses = scores.length / count;
    for (let f = 0; f < count; f++) {
      const hits = [];
      for (let i = 0; i < numClasses; i++) {
        const s = scores[f * numClasses + i];
        if (s >= MIN_REPORTED) hits.push([i, s]);
      }
      hits.sort((a, b) => b[1] - a[1]);
      frames.push({ start: (start + f) * WINDOW_SAMPLES / SAMPLE_RATE, hits });
    }
    if (numFrames > 1) {
      postMessage({ type: 'predict-progress', id, progress: (start + count) / numFrames });
    }
  }

  postMessage({ type: 'prediction', id, frames, ms: performance.now() - t0 });
}

/** Per-species likelihood of occurring at this location and week of year. */
async function areaScores({ latitude, longitude }) {
  if (!areaModel) return;
  const now = new Date();
  // BirdNET uses a 48-week year (4 weeks per month).
  const week = Math.min(48, now.getMonth() * 4 + Math.ceil(now.getDate() / 7.75));
  const scores = tf.tidy(() => areaModel.predict(tf.tensor([[latitude, longitude, week]])));
  const data = await scores.data();
  scores.dispose();
  postMessage({ type: 'area', scores: Array.from(data) });
}
