/**
 * Session recording, the recordings library, and the playback view.
 *
 * Live recordings capture the exact 48 kHz mono stream the model hears and
 * stream it to the server as 16-bit PCM every few seconds, so long sessions
 * don't accumulate in memory and survive the tab closing.
 */

const MODEL_RATE = 48000;
const WINDOW_SEC = 3;
const FLUSH_MS = 3000;
const ZOOMS = [2, 5, 10, 20, 40, 80, 160]; // pixels per second
const TRACK_COLORS = ['#e07a5f', '#3d9970', '#5b8def', '#c2952d', '#a26bd6', '#d6608f'];

export function createRecordings(app) {
  const { els, h, formatTime, COLORMAP } = app;
  const store = app.backend.recordings;

  /* -------------------------------------------------------------------------
     Live recorder
     ----------------------------------------------------------------------- */

  const rec = {
    active: false,
    id: null,
    samples: 0, // samples captured so far (48 kHz)
    pending: [], // Int16Array chunks not yet sent
    chain: Promise.resolve(), // keeps appends in order
    detections: [],
    timer: null,
    starting: null,
  };

  async function startRecording() {
    if (rec.active) return;
    Object.assign(rec, { active: true, id: null, samples: 0, pending: [], detections: [], chain: Promise.resolve() });
    updateRecordButton();
    const name = `Session ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    rec.starting = store.createLive(name)
      .then(created => {
        rec.id = created.id;
        refreshList();
      })
      .catch(err => {
        console.error(err);
        rec.active = false;
        updateRecordButton('Couldn’t start recording');
      });
    rec.timer = setInterval(() => {
      flush();
      updateRecordButton();
    }, 1000);
  }

  /** Called with every chunk of 48 kHz samples the model receives. */
  function pushSamples(samples) {
    if (!rec.active) return;
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    rec.pending.push(out);
    rec.samples += samples.length;
  }

  let lastFlush = 0;
  function flush(force = false) {
    if (!rec.id || !rec.pending.length) return rec.chain;
    if (!force && Date.now() - lastFlush < FLUSH_MS) return rec.chain;
    lastFlush = Date.now();
    const body = concat(rec.pending);
    rec.pending = [];
    const id = rec.id;
    const detections = rec.detections.map(d => ({ ...d }));
    rec.chain = rec.chain.then(() => store.append(id, body.buffer, detections).catch(console.error));
    return rec.chain;
  }

  async function stopRecording() {
    if (!rec.active) return;
    rec.active = false;
    clearInterval(rec.timer);
    updateRecordButton('Saving…');
    await rec.starting;
    if (rec.id) {
      await flush(true);
      try {
        await store.finish(rec.id, { detections: rec.detections });
      } catch (err) {
        console.error(err);
      }
    }
    rec.id = null;
    updateRecordButton();
    refreshList();
  }

  /** Live detections, positioned by the sample count at the end of their 3 s window. */
  function addLiveHits(hits, windowEndSample) {
    if (!rec.active || windowEndSample == null) return;
    const end = windowEndSample / MODEL_RATE;
    const start = Math.max(0, end - WINDOW_SEC);
    for (const [i, score] of hits) {
      const label = app.labelOf(i);
      mergeDetection(rec.detections, { start, end, scientificName: label.scientificName, commonName: label.commonName, confidence: score });
    }
  }

  // Best effort if the tab closes mid-recording; audio already flushed is kept
  // and the recording is finalized later either way.
  addEventListener('pagehide', () => {
    if (!rec.active || !rec.id) return;
    store.beacon(rec.id, rec.pending.length ? concat(rec.pending).buffer : null, rec.detections);
  });

  function updateRecordButton(message) {
    const btn = els.recordBtn;
    btn.setAttribute('aria-pressed', String(rec.active));
    btn.classList.toggle('recording', rec.active);
    els.recordLabel.textContent = message ||
      (rec.active ? `${formatTime(rec.samples / MODEL_RATE)} · Stop` : 'Record');
    btn.title = rec.active ? 'Stop recording (keeps listening)' : 'Record this session';
  }

  /* -------------------------------------------------------------------------
     Library
     ----------------------------------------------------------------------- */

  let recordings = [];

  async function refreshList() {
    try {
      recordings = await store.list();
    } catch (err) {
      console.error(err);
    }
    renderList();
  }

  function renderList() {
    els.recCount.textContent = recordings.length;
    if (!recordings.length) {
      els.recList.innerHTML = '<li class="empty">Press <strong>Record</strong> while listening, or upload a recording.</li>';
      return;
    }
    els.recList.replaceChildren(...recordings.map(r => {
      const li = h('li', 'rec-item' + (player.rec?.id === r.id ? ' open' : ''));
      const main = h('button', 'rec-main');
      main.type = 'button';
      main.append(h('span', 'name', r.name));
      const live = r.status === 'recording';
      const bits = [new Date(r.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })];
      if (live) bits.push('● recording');
      else if (r.duration) bits.push(formatTime(r.duration));
      const species = speciesSummary(r.detections);
      if (species) bits.push(species);
      if (r.source === 'upload') bits.push('uploaded');
      main.append(h('span', 'stats', bits.join(' · ')));
      main.disabled = live;
      main.addEventListener('click', () => openPlayer(r));

      const download = h('button', 'act', '');
      download.type = 'button';
      download.addEventListener('click', () => store.download(r).catch(console.error));
      download.title = 'Download';
      download.setAttribute('aria-label', `Download ${r.name}`);
      download.innerHTML = DOWNLOAD_ICON;

      const del = h('button', 'act remove');
      del.type = 'button';
      del.title = 'Delete recording';
      del.setAttribute('aria-label', `Delete ${r.name}`);
      del.innerHTML = X_ICON;
      del.disabled = live;
      del.addEventListener('click', () => confirmDelete(del, r));

      li.append(main, download, del);
      return li;
    }));
  }

  function speciesSummary(detections = []) {
    const names = [...new Set(detections.map(d => d.commonName))];
    if (!names.length) return '';
    return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
  }

  // Two-step delete instead of a blocking confirm() dialog.
  function confirmDelete(btn, r) {
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.textContent = 'Delete?';
      setTimeout(() => {
        if (!btn.isConnected) return;
        btn.classList.remove('confirm');
        btn.innerHTML = X_ICON;
      }, 3000);
      return;
    }
    store.remove(r.id)
      .then(() => {
        if (player.rec?.id === r.id) closePlayer();
        return refreshList();
      })
      .catch(console.error);
  }

  function upload(file) {
    const name = file.name.replace(/\.[^.]+$/, '') || 'Upload';
    const type = file.type || guessType(file.name);
    els.uploadLabel.textContent = 'Uploading…';
    els.uploadInput.disabled = true;
    store.upload(file, name, type, p => {
      els.uploadLabel.textContent = `Uploading ${Math.round(p * 100)}%`;
    }).then(async created => {
      els.recNote.hidden = true;
      await refreshList();
      // Uploads are analysed straight away, like the old "Analyze a recording".
      openPlayer(created, { analyze: true });
    }).catch(err => {
      console.error(err);
      els.recNote.textContent = `Couldn’t upload ${file.name}${err.status === 415 ? ': unsupported audio format' : ''}.`;
      els.recNote.hidden = false;
    }).finally(() => {
      els.uploadInput.disabled = false;
      els.uploadInput.value = '';
      els.uploadLabel.textContent = 'Upload';
    });
  }

  /* -------------------------------------------------------------------------
     Player
     ----------------------------------------------------------------------- */

  const player = {
    rec: null,
    pcm: null, // 48 kHz mono, kept for "Find birds"
    spec: null, // { spec, cols, colsPerSec, bins }
    duration: 0,
    viewStart: 0,
    zoom: 3, // index into ZOOMS
    follow: true,
    lastInteraction: 0,
    loadToken: 0,
    raf: 0,
  };
  const audioEl = els.playerAudio;

  async function openPlayer(r, { analyze = false } = {}) {
    const token = ++player.loadToken;
    Object.assign(player, { rec: r, pcm: null, spec: null, duration: r.duration || 0, viewStart: 0, follow: true });
    els.player.hidden = false;
    els.playerName.value = r.name;
    els.playerMeta.textContent = new Date(r.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    store.releaseUrl(player.url);
    player.url = null;
    setPlaying(false);
    els.findBirds.disabled = true;
    renderList();
    renderTrack();
    drawView();
    els.player.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      setPlayerStatus('Loading audio…');
      const url = await store.audioUrl(r);
      if (token !== player.loadToken) return store.releaseUrl(url);
      player.url = url;
      audioEl.src = url;
      const buf = await fetch(url).then(res => res.arrayBuffer());
      if (token !== player.loadToken) return;
      setPlayerStatus('Decoding…');
      // Decoding through a 48 kHz OfflineAudioContext also resamples to the model's rate.
      const decoded = await new OfflineAudioContext(1, 1, MODEL_RATE).decodeAudioData(buf);
      if (token !== player.loadToken) return;
      player.pcm = mixToMono(decoded);
      player.duration = decoded.duration;
      if (!r.duration || Math.abs(r.duration - decoded.duration) > 0.5) {
        r.duration = decoded.duration;
        patch(r, { duration: decoded.duration }).then(refreshList);
      }
      els.findBirds.disabled = false;
      setPlayerStatus('Drawing spectrogram…');
      player.spec = await computeSpectrogram(player.pcm.slice(), p => {
        if (token === player.loadToken) setPlayerStatus(`Drawing spectrogram… ${Math.round(p * 100)}%`);
      });
      if (token !== player.loadToken) return;
      setPlayerStatus('');
      drawOverview();
      drawView();
      if (analyze) findBirds();
    } catch (err) {
      console.error(err);
      if (token === player.loadToken) setPlayerStatus('This audio format can’t be decoded by your browser.');
    }
  }

  function closePlayer() {
    player.loadToken++;
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
    store.releaseUrl(player.url);
    Object.assign(player, { rec: null, pcm: null, spec: null, url: null });
    els.player.hidden = true;
    cancelAnimationFrame(player.raf);
    renderList();
  }

  function computeSpectrogram(pcm, onProgress) {
    return new Promise((resolve, reject) => {
      const worker = new Worker('spectro-worker.js');
      worker.onmessage = ({ data }) => {
        if (data.progress != null) return onProgress(data.progress);
        worker.terminate();
        resolve(data);
      };
      worker.onerror = e => {
        worker.terminate();
        reject(e);
      };
      worker.postMessage({ pcm, sampleRate: MODEL_RATE }, [pcm.buffer]);
    });
  }

  async function findBirds() {
    const r = player.rec;
    if (!r || !player.pcm) return;
    els.findBirds.disabled = true;
    const label = els.findBirds.textContent;
    try {
      const result = await app.predict(player.pcm.slice(), p => {
        els.findBirds.textContent = `Finding… ${Math.round(p * 100)}%`;
      });
      const detections = [];
      for (const frame of result.frames) {
        for (const [i, score] of app.plausibleHits(frame.hits)) {
          if (score < app.threshold()) break;
          const l = app.labelOf(i);
          mergeDetection(detections, {
            start: frame.start, end: Math.min(frame.start + WINDOW_SEC, player.duration),
            scientificName: l.scientificName, commonName: l.commonName, confidence: score,
          });
          app.recordDetection(i, score, Date.now(), `in ${r.name} at ${formatTime(frame.start)}`);
        }
      }
      r.detections = detections;
      await patch(r, { detections });
      renderTrack();
      refreshList();
      setPlayerStatus(detections.length ? '' : `No birds above ${Math.round(app.threshold() * 100)}% confidence.`);
    } catch (err) {
      console.error(err);
      setPlayerStatus(`Couldn’t analyze: ${err.message}`);
    } finally {
      els.findBirds.textContent = label;
      els.findBirds.disabled = false;
    }
  }

  function patch(r, body) {
    return store.patch(r.id, body).catch(console.error);
  }

  /* View geometry */

  const pxPerSec = () => ZOOMS[player.zoom];
  const viewWidth = () => els.playerSpec.clientWidth;
  const viewDuration = () => viewWidth() / pxPerSec();

  function clampView() {
    const max = Math.max(0, player.duration - viewDuration());
    player.viewStart = Math.min(max, Math.max(0, player.viewStart));
  }

  function drawView() {
    const canvas = els.playerSpec;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const hgt = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== hgt) {
      canvas.width = w;
      canvas.height = hgt;
    }
    clampView();
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, hgt);
    const d = img.data;
    const s = player.spec;
    const pps = pxPerSec() * dpr;
    for (let x = 0; x < w; x++) {
      const t = player.viewStart + x / pps;
      const col = s ? Math.floor(t * s.colsPerSec) : -1;
      const inRange = s && col >= 0 && col < s.cols && t <= player.duration;
      for (let y = 0; y < hgt; y++) {
        const o = (y * w + x) * 4;
        const [r, g, b] = inRange ? COLORMAP[s.spec[col * s.bins + Math.floor((1 - y / hgt) * (s.bins - 1))]] : COLORMAP[0];
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    positionTrack();
    updatePlayhead();
    updateOverviewWindow();
  }

  function drawOverview() {
    const canvas = els.overview;
    const s = player.spec;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const hgt = Math.max(1, Math.round(canvas.clientHeight * dpr));
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, hgt);
    const d = img.data;
    for (let x = 0; x < w; x++) {
      const c0 = Math.floor((x / w) * s.cols);
      const c1 = Math.max(c0 + 1, Math.floor(((x + 1) / w) * s.cols));
      for (let y = 0; y < hgt; y++) {
        const bin = Math.floor((1 - y / hgt) * (s.bins - 1));
        let v = 0;
        for (let c = c0; c < c1; c += Math.max(1, ((c1 - c0) / 8) | 0)) v = Math.max(v, s.spec[c * s.bins + bin]);
        const [r, g, b] = COLORMAP[v];
        const o = (y * w + x) * 4;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // Detection ticks along the bottom of the overview.
    const dets = player.rec?.detections || [];
    const colors = colorMap(dets);
    for (const det of dets) {
      ctx.fillStyle = colors.get(det.scientificName);
      ctx.fillRect((det.start / player.duration) * w, hgt - 4 * dpr, Math.max(2 * dpr, ((det.end - det.start) / player.duration) * w), 4 * dpr);
    }
  }

  function updateOverviewWindow() {
    const dur = player.duration || 1;
    els.overviewWindow.style.left = `${(player.viewStart / dur) * 100}%`;
    els.overviewWindow.style.width = `${Math.min(100, (viewDuration() / dur) * 100)}%`;
  }

  function updatePlayhead() {
    const t = audioEl.currentTime || 0;
    const x = (t - player.viewStart) * pxPerSec();
    els.playhead.style.transform = `translateX(${x}px)`;
    els.playhead.hidden = x < 0 || x > viewWidth();
    els.playTime.textContent = `${formatTime(t)} / ${formatTime(player.duration)}`;
  }

  /* Detection track: one bar per merged detection, stacked in lanes */

  function renderTrack() {
    const dets = (player.rec?.detections || []).slice().sort((a, b) => a.start - b.start);
    const colors = colorMap(dets);
    const laneEnds = [];
    els.detTrack.replaceChildren(...dets.map(det => {
      let lane = laneEnds.findIndex(end => end <= det.start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = det.end;
      const bar = h('button', 'det', det.commonName);
      bar.type = 'button';
      bar.dataset.start = det.start;
      bar.dataset.end = det.end;
      bar.style.setProperty('--lane', Math.min(lane, 2));
      bar.style.setProperty('--c', colors.get(det.scientificName));
      bar.title = `${det.commonName} · ${formatTime(det.start)}–${formatTime(det.end)}${det.confidence != null ? ` · ${Math.round(det.confidence * 100)}%` : ''}`;
      bar.addEventListener('click', () => {
        seek(det.start);
        play();
      });
      return bar;
    }));
    els.detTrack.style.height = `${Math.min(3, Math.max(1, laneEnds.length)) * 20 + 4}px`;
    els.detTrack.classList.toggle('empty', !dets.length);
    positionTrack();
    if (player.spec) drawOverview();
  }

  function positionTrack() {
    const pps = pxPerSec();
    const width = viewWidth();
    for (const bar of els.detTrack.children) {
      const x0 = (bar.dataset.start - player.viewStart) * pps;
      const x1 = (bar.dataset.end - player.viewStart) * pps;
      bar.hidden = x1 < 0 || x0 > width;
      bar.style.left = `${x0}px`;
      // Keep the label readable when the bar starts off the left edge.
      bar.style.paddingLeft = `${x0 < 0 ? Math.min(-x0, x1 - x0 - 40) + 6 : 6}px`;
      bar.style.width = `${Math.max(6, x1 - x0)}px`;
    }
  }

  function colorMap(dets) {
    const map = new Map();
    for (const d of dets) if (!map.has(d.scientificName)) map.set(d.scientificName, TRACK_COLORS[map.size % TRACK_COLORS.length]);
    return map;
  }

  /* Playback */

  function seek(t) {
    audioEl.currentTime = Math.max(0, Math.min(player.duration || 0, t));
    // Bring the new position into view.
    if (t < player.viewStart || t > player.viewStart + viewDuration()) {
      player.viewStart = t - viewDuration() * 0.15;
    }
    player.follow = true;
    drawView();
  }

  function play() {
    if (app.isListening()) app.pauseDetections(true); // the mic would hear the speakers
    audioEl.play().catch(console.error);
  }

  function setPlaying(on) {
    els.playBtn.innerHTML = on ? PAUSE_ICON : PLAY_ICON;
    els.playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
  }

  audioEl.addEventListener('play', () => {
    setPlaying(true);
    player.follow = true;
    const tick = () => {
      if (audioEl.paused) return;
      const t = audioEl.currentTime;
      const vd = viewDuration();
      const idle = Date.now() - player.lastInteraction > 2500;
      if (player.follow && idle && (t > player.viewStart + vd * 0.85 || t < player.viewStart)) {
        player.viewStart = t - vd * 0.15;
        drawView();
      } else {
        updatePlayhead();
      }
      player.raf = requestAnimationFrame(tick);
    };
    tick();
  });
  audioEl.addEventListener('pause', () => {
    setPlaying(false);
    app.pauseDetections(false);
    updatePlayhead();
  });
  audioEl.addEventListener('ended', () => app.pauseDetections(false));
  audioEl.addEventListener('timeupdate', () => { if (audioEl.paused) updatePlayhead(); });

  els.playBtn.addEventListener('click', () => (audioEl.paused ? play() : audioEl.pause()));
  els.back5.addEventListener('click', () => seek((audioEl.currentTime || 0) - 5));
  els.fwd5.addEventListener('click', () => seek((audioEl.currentTime || 0) + 5));
  els.zoomIn.addEventListener('click', () => zoomAround(player.zoom + 1, audioEl.currentTime || player.viewStart));
  els.zoomOut.addEventListener('click', () => zoomAround(player.zoom - 1, audioEl.currentTime || player.viewStart));
  els.findBirds.addEventListener('click', findBirds);
  els.downloadBtn.addEventListener('click', () => player.rec && store.download(player.rec).catch(console.error));
  els.playerClose.addEventListener('click', closePlayer);
  els.playerName.addEventListener('change', async () => {
    const name = els.playerName.value.trim();
    if (!player.rec || !name) return;
    player.rec.name = name;
    await patch(player.rec, { name });
    refreshList();
  });

  function zoomAround(level, t) {
    level = Math.max(0, Math.min(ZOOMS.length - 1, level));
    if (level === player.zoom) return;
    const frac = (t - player.viewStart) / viewDuration();
    player.zoom = level;
    player.viewStart = t - frac * viewDuration();
    els.zoomIn.disabled = level === ZOOMS.length - 1;
    els.zoomOut.disabled = level === 0;
    drawView();
  }

  // Drag to pan; a click without movement seeks.
  els.playerSpec.addEventListener('pointerdown', e => {
    const startX = e.clientX;
    const startView = player.viewStart;
    let moved = false;
    els.playerSpec.setPointerCapture(e.pointerId);
    const move = ev => {
      if (Math.abs(ev.clientX - startX) > 4) moved = true;
      if (!moved) return;
      player.lastInteraction = Date.now();
      player.follow = false;
      player.viewStart = startView - (ev.clientX - startX) / pxPerSec();
      drawView();
    };
    const up = ev => {
      els.playerSpec.removeEventListener('pointermove', move);
      els.playerSpec.removeEventListener('pointerup', up);
      if (!moved) {
        const rect = els.playerSpec.getBoundingClientRect();
        seek(player.viewStart + (ev.clientX - rect.left) / pxPerSec());
      }
    };
    els.playerSpec.addEventListener('pointermove', move);
    els.playerSpec.addEventListener('pointerup', up);
  });

  // Horizontal wheel / shift+wheel pans; ctrl/cmd+wheel (and trackpad pinch) zooms.
  els.playerSpec.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = els.playerSpec.getBoundingClientRect();
      const t = player.viewStart + (e.clientX - rect.left) / pxPerSec();
      zoomAround(player.zoom + (e.deltaY < 0 ? 1 : -1), t);
      return;
    }
    const dx = e.shiftKey ? e.deltaY : e.deltaX;
    if (!dx) return; // let vertical scrolling scroll the page
    e.preventDefault();
    player.lastInteraction = Date.now();
    player.follow = false;
    player.viewStart += dx / pxPerSec();
    drawView();
  }, { passive: false });

  // Drag on the overview to move the visible window.
  els.overviewWrap.addEventListener('pointerdown', e => {
    els.overviewWrap.setPointerCapture(e.pointerId);
    const go = ev => {
      const rect = els.overviewWrap.getBoundingClientRect();
      const t = ((ev.clientX - rect.left) / rect.width) * player.duration;
      player.lastInteraction = Date.now();
      player.follow = false;
      player.viewStart = t - viewDuration() / 2;
      drawView();
    };
    go(e);
    els.overviewWrap.addEventListener('pointermove', go);
    els.overviewWrap.addEventListener('pointerup', () => els.overviewWrap.removeEventListener('pointermove', go), { once: true });
  });

  addEventListener('resize', () => {
    if (!player.rec) return;
    drawView();
    if (player.spec) drawOverview();
  });

  function setPlayerStatus(text) {
    els.playerStatus.textContent = text;
    els.playerStatus.hidden = !text;
  }

  els.uploadInput.addEventListener('change', () => {
    const file = els.uploadInput.files[0];
    if (file) upload(file);
  });

  refreshList();

  return {
    startRecording, stopRecording, pushSamples, addLiveHits,
    isRecording: () => rec.active,
    samplesRecorded: () => (rec.active ? rec.samples : null),
    stopPlayback: () => audioEl.pause(),
  };
}

/* ---------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------- */

/** Extends the previous detection of the same species if they touch or overlap. */
function mergeDetection(list, det) {
  for (let i = list.length - 1; i >= 0 && i >= list.length - 12; i--) {
    const prev = list[i];
    if (prev.scientificName === det.scientificName && det.start <= prev.end + 0.5) {
      prev.end = Math.max(prev.end, det.end);
      prev.confidence = Math.max(prev.confidence ?? 0, det.confidence ?? 0);
      return;
    }
  }
  list.push({ ...det });
}

function mixToMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buffer.numberOfChannels;
  }
  return out;
}

function concat(chunks) {
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function guessType(name) {
  const ext = name.split('.').pop().toLowerCase();
  return { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac' }[ext] || 'application/octet-stream';
}

const PLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/></svg>';
const X_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const DOWNLOAD_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v9M6 8.5l4 4 4-4M4 15.5h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
