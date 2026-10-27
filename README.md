# Birdsong

A web app that listens to your microphone and identifies the birds it hears, in real time.
Everything runs in the browser: the [BirdNET](https://birdnet.cornell.edu/) v2.4 model
(~6,500 species) executes locally via TensorFlow.js, so no audio ever leaves your device.

## Run it

```bash
npm install   # also downloads the BirdNET model (~55 MB) into public/models
npm start     # http://localhost:8080
```

Click **Start listening** and allow microphone access. Microphones only work on `https://`
pages or `http://localhost`, so deploy `public/` behind HTTPS if you host it elsewhere.

## Features

- **Live identification**: analyzes the last 3 seconds of audio every second and shows the
  top candidates with confidence bars.
- **Session log**: every species identified, with best confidence and number of encounters. Per bird:
  - **Details**: male/female photos (tap to enlarge), reference recordings to play in place, and
    notes: voice, field marks, male vs. female, look-alikes, fun facts. Detection pauses while a
    reference sound plays so the mic doesn't "hear" it.
  - **Save**: records a verified sighting in **My sightings** (stored in `data/sightings.json`).
  - **Skip**: hides the bird for the rest of the session. **×** removes it until it's heard again.
- **Live spectrogram** with a label at the moment each new bird is detected.
- **Location filter** (optional): BirdNET's range model uses your location and the week of the year
  to drop species that wouldn't plausibly be there. This removes most false positives.
- **Session recording**: **Record** captures exactly what the model hears (48 kHz mono WAV), along
  with the timestamps of live detections. Audio streams to the server every few seconds, so long
  sessions don't build up in browser memory and a closed tab still leaves a usable file.
- **Recordings library**: upload any audio file (it's analyzed automatically), download, rename,
  delete. The player shows a scrollable spectrogram of the whole session with detections as labeled
  bars: drag or use the overview strip to move around, ctrl/⌘+scroll or −/+ to zoom, click to seek,
  click a bar to hear that detection. **Find birds** re-runs identification over the whole file.
- **Microphone picker**: choose any input device; the choice is remembered, and switching while
  listening takes effect immediately.
- **Sensitivity**: minimum confidence defaults to 15%, with 3 s windows analyzed every 0.5 s (live and
  in recordings). On a noisy test soundscape this caught 2.5-3x more birdsong than 25% with
  back-to-back windows. Turn on the location filter to weed out the extra out-of-range guesses.
- **Noise filter** (optional): a 150 Hz high-pass for steady traffic or hum. In quiet or windy
  conditions filtering made detection worse (the model is trained on unfiltered audio), so it's off
  by default.

## Two ways to run it

| | `npm start` (local server) | Static hosting (GitHub Pages, [birdsong.live](https://birdsong.live)) |
| --- | --- | --- |
| Live identification, spectrogram, location filter | ✓ | ✓ |
| Bird details | iNaturalist + Wikipedia, or Claude / xeno-canto with keys | iNaturalist + Wikipedia, fetched by the browser |
| My sightings, recordings | Stored by the server in `data/` | Stored in each visitor's browser (IndexedDB); download recordings to keep copies |

The page checks `/api/health` at startup and picks the server or browser storage automatically.

### Deploying

Pushing to `main` runs `.github/workflows/pages.yml`, which runs `npm ci` (downloading the model
files, pinned to a fixed BirdNET commit) and publishes `public/` to GitHub Pages. The custom domain
comes from `public/CNAME`.

## Optional API keys

Bird details work without any keys. Two optional environment variables improve them:

```bash
ANTHROPIC_API_KEY=sk-ant-... XC_API_KEY=... npm start
```

| Variable | Without it | With it |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Notes are the Wikipedia summary | Claude writes field-guide notes: voice, field marks, male vs. female, look-alikes, fun facts (one call per species, cached) |
| `XC_API_KEY` ([free xeno-canto key](https://xeno-canto.org/explore/api)) | Recordings from iNaturalist, mostly unlabeled | Recordings labelled song / call / alarm call / flight call, with lengths |

Details are cached for 30 days in `data/cache/`; adding a key upgrades cached entries automatically.

## How it works

| File | Role |
| --- | --- |
| `public/app.js` | Mic capture (browser noise suppression / AGC disabled, since they erase birdsong), 48 kHz resampling, 3 s ring buffer, spectrogram, UI |
| `public/audio-processor.js` | AudioWorklet that forwards raw mic samples |
| `public/worker.js` | Loads the model in a Web Worker (WebGL backend) and runs inference |
| `scripts/setup.mjs` | Downloads and size-verifies model files; vendors `tf.min.js` |
| `public/recordings.js` | Session recorder, recordings library, and playback view |
| `public/spectro-worker.js` | Computes the playback spectrogram (noise-normalized per frequency) |
| `server.mjs` | Static server plus `/api/bird`, `/api/sightings`, `/api/recordings` |
| `lib/recordings.mjs` | Recording storage in `data/recordings/` (streamed WAV writes, Range requests for seeking) |
| `lib/birdinfo.mjs` | Gathers photos (iNaturalist), sounds (xeno-canto / iNaturalist) and notes (Claude / Wikipedia) |
| `lib/sightings.mjs` | Saved sightings store |

The model's custom mel-spectrogram layer and WebGL STFT kernel come from
[BirdNET Live](https://github.com/birdnet-team/real-time-pwa) (MIT), based on
[georg95/birdnet-web](https://github.com/georg95/birdnet-web).

## Requirements

A browser with WebGL and AudioWorklet support. Tested in Chrome; current Edge, Firefox, and Safari
should also work (when the mic can't run at 48 kHz, as in Firefox, audio is resampled in JS).

## License & attribution

Model and labels: BirdNET by the K. Lisa Yang Center for Conservation Bioacoustics (Cornell Lab of
Ornithology) and Chemnitz University of Technology, licensed CC BY-SA 4.0 as distributed in the
BirdNET Live repo. Check the BirdNET terms before any commercial use.

> Kahl, S., Wood, C. M., Eibl, M., & Klinck, H. (2021). BirdNET: A deep learning solution for avian
> diversity monitoring. *Ecological Informatics*, 61, 101236.
