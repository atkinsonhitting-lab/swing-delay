import { initPose, wristPos, poseActive } from "./pose.js";

/* Delay cam: live camera -> rolling 1s-chunk ring -> ping-pong smooth playback.
   Front camera is shown/saved true (non-mirrored) per spec. */
const $ = (id) => document.getElementById(id);

const SENS = {
  low:  { start: 0.60, end: 0.20, label: "Low" },
  med:  { start: 0.45, end: 0.15, label: "Med" },
  high: { start: 0.30, end: 0.10, label: "High" }
};

function pickMime(){
  if (!window.MediaRecorder) return "";
  const cands = ['video/mp4;codecs="avc1.640034,mp4a.40.2"','video/mp4;codecs="avc1.42E01E,mp4a.40.2"','video/mp4','video/webm;codecs=vp9','video/webm'];
  for (const m of cands){ try { if (MediaRecorder.isTypeSupported(m)) return m; } catch(e){} }
  return "";
}

export const cam = {
  stream: null, ready: false, starting: false,
  facing: "user",
  delay: 5, autoClip: true, sens: "med", zoom: 1,
  hitter: null,           // {id, name}
  onClip: null, onToast: null,

  rec: null,              // {canvas, recorder, chunks[], initChunk, mime}
  src: null, dpA: null, dpB: null,
  capTimer: null, rafId: 0, dpTimer: null, recLastT: 0,
  capCanvas: null, motionCtx: null, prevMotion: null,
  prevWrist: null, prevWristT: 0,
  // swing state
  swingState: "idle", consecHigh: 0, consecLow: 0,
  swingT0: 0, peakAct: 0, peakT: 0, lastClipAt: 0,

  // delay player state
  dpShowing: "A", dpCurT: -1, dpUrls: { A: null, B: null }, dpLoadedT: { A: -1, B: -1 },

  toast(m){ (this.onToast || ((x) => {}))(m); },

  init(){
    this.src = $("src"); this.liveView = $("liveView");
    this.dpA = $("dpA"); this.dpB = $("dpB");
    this.capCanvas = document.createElement("canvas");
    const mc = document.createElement("canvas");
    mc.width = 48; mc.height = 27;
    this.motionCtx = mc.getContext("2d", { willReadFrequently: true });
    this._mc = mc;
    try {
      const z = parseFloat(localStorage.getItem("sd-zoom"));
      if ([1, 1.3, 1.6, 2].indexOf(z) >= 0) this.zoom = z;
    } catch(e){}
    this.wire();
    this.sync();
  },

  wire(){
    $("delayRange").addEventListener("input", (e) => {
      this.delay = Math.min(30, Math.max(1, parseInt(e.target.value, 10) || 5));
      this.sync();
    });
    $("modeDelay").onclick = () => this.setMode("delay");
    $("modeLive").onclick = () => this.setMode("live");
    $("camSwitch").onclick = async () => {
      this.facing = this.facing === "user" ? "environment" : "user";
      this.sync();
      if (this.ready) await this.start();
      this.toast(this.facing === "user" ? "Front camera" : "Back camera");
    };
    $("saveClipBtn").onclick = () => this.saveManual();
    $("autoClipBtn").onclick = () => {
      this.autoClip = !this.autoClip; this.sync(); this.resetDetect();
      this.toast(this.autoClip ? "Auto-clip on" : "Auto-clip off");
    };
    $("sensBtn").onclick = () => {
      const order = ["low", "med", "high"];
      this.sens = order[(order.indexOf(this.sens) + 1) % order.length];
      this.sync(); this.resetDetect();
    };
    $("zoomBtn").onclick = () => {
      const levels = [1, 1.3, 1.6, 2];
      const i = levels.indexOf(this.zoom);
      this.zoom = levels[(i + 1) % levels.length];
      try { localStorage.setItem("sd-zoom", String(this.zoom)); } catch(e){}
      this.sync();
      const zl = this.zoom % 1 === 0 ? this.zoom + "×" : this.zoom.toFixed(1) + "×";
      this.toast("Zoom " + zl);
    };
    $("startBtn").onclick = () => this.start();
    this.dpA.addEventListener("ended", () => this.dpOnEnded("A"));
    this.dpB.addEventListener("ended", () => this.dpOnEnded("B"));
  },

  sync(){
    $("delayRange").value = this.delay;
    $("delayVal").textContent = this.delay + "s";
    $("modeDelay").classList.toggle("on", this.mode !== "live");
    $("modeLive").classList.toggle("on", this.mode === "live");
    $("camSwitch").textContent = this.facing === "user" ? "🤳 Front" : "📷 Back";
    $("autoClipBtn").textContent = "✂️ Auto-clip: " + (this.autoClip ? "On" : "Off");
    $("autoClipBtn").classList.toggle("on", this.autoClip);
    $("sensBtn").textContent = "Sensitivity: " + SENS[this.sens].label;
    const z = this.zoom || 1;
    $("zoomBtn").textContent = z % 1 === 0 ? z + "×" : z.toFixed(1) + "×";
    if (this.liveView) this.liveView.style.transform = z !== 1 ? "scale(" + z + ")" : "none";
    this.updateStage();
  },
  setMode(m){ this.mode = m; this.sync(); },
  updateStage(){
    const delayMode = this.mode !== "live";
    $("delayStage").style.display = (this.ready && delayMode) ? "block" : "none";
    if (this.liveView) this.liveView.style.display = (this.ready && !delayMode) ? "block" : "none";
    if (!this.ready || !delayMode) this.dpHide();
  },

  async start(){
    if (this.starting) return;
    if (window.navigator.standalone === true){
      $("camErrorText").textContent = "Apple blocks the camera in installed home-screen apps. Open SwingDelay in Safari instead.";
      $("camError").hidden = false;
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      $("camErrorText").textContent = "This browser can't reach the camera. Open this page in Safari (iPhone) or Chrome (Android).";
      $("camError").hidden = false;
      return;
    }
    this.starting = true;
    const btn = $("startBtn");
    btn.disabled = true; btn.textContent = "Starting…";
    this.stop();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
        audio: false
      });
    } catch(err){
      this.starting = false;
      btn.disabled = false; btn.textContent = "Start Camera";
      $("camErrorText").textContent = "Camera blocked (" + (err && err.name) + "). Allow camera access and try again.";
      $("camError").hidden = false;
      return;
    }
    this.src.srcObject = this.stream;
    if (this.liveView){
      this.liveView.srcObject = this.stream;
      try { await this.liveView.play(); } catch(e){}
    }
    try { await this.src.play(); } catch(e){}
    this.ready = true;
    $("startOverlay").hidden = true;
    $("camError").hidden = true;
    $("recDot").hidden = false;
    try {
      const vs = this.stream.getVideoTracks()[0].getSettings();
      const cm = $("camMode");
      if (vs.width){ cm.textContent = vs.width + "×" + vs.height + " @ " + Math.round(vs.frameRate || 0) + "fps"; cm.hidden = false; }
    } catch(e){}
    // recorder: ~1080p, 1s chunks, 45s ring
    const vw = this.src.videoWidth || 1280, vh = this.src.videoHeight || 720;
    const sc = Math.min(1, 1920 / Math.max(vw, vh), 1080 / Math.min(vw, vh));
    const rw = Math.max(2, Math.round(vw * sc / 2) * 2), rh = Math.max(2, Math.round(vh * sc / 2) * 2);
    this.startRecorder(rw, rh);
    this.resetDetect();
    this.capTimer = setInterval(() => this.capture(), 100);
    cancelAnimationFrame(this.rafId);
    this.recLastT = 0;
    this.rafId = requestAnimationFrame(() => this.recLoop());
    this.dpTimer = setInterval(() => this.dpWatchdog(), 400);
    this.updateStage();
    this.starting = false;
    btn.disabled = false; btn.textContent = "Start Camera";
    // pose model loads in background; motion fallback meanwhile
    initPose((ok) => { $("poseBadge").hidden = !ok; });
  },

  stop(){
    this.ready = false;
    [this.capTimer, this.dpTimer].forEach((t) => { if (t) clearInterval(t); });
    this.capTimer = this.dpTimer = null;
    cancelAnimationFrame(this.rafId);
    if (this.rec && this.rec.recorder && this.rec.recorder.state !== "inactive"){
      try { this.rec.recorder.stop(); } catch(e){}
    }
    this.rec = null;
    if (this.stream){ this.stream.getTracks().forEach((t) => { try { t.stop(); } catch(e){} }); this.stream = null; }
    this.src.srcObject = null;
    if (this.liveView){ this.liveView.srcObject = null; this.liveView.style.display = "none"; }
    this.dpHide();
    $("startOverlay").hidden = false;
    $("warmup").hidden = true;
    $("recDot").hidden = true;
    $("camMode").hidden = true;
    $("poseBadge").hidden = true;
    this.updateStage();
  },

  /* ---------- recorder ---------- */
  startRecorder(w, h){
    const mime = pickMime();
    if (!mime){ this.toast("This browser cannot record video."); return; }
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const rec = { canvas, recorder: null, chunks: [], initChunk: null, mime };
    let rs = null;
    try { rs = canvas.captureStream(60); } catch(e){ return; }
    try {
      const bps = Math.min(14000000, Math.max(6000000, Math.round(w * h * 60 * 0.12)));
      rec.recorder = new MediaRecorder(rs, { mimeType: mime, videoBitsPerSecond: bps });
    } catch(e){ return; }
    rec.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0){
        if (!rec.initChunk) rec.initChunk = e.data;
        rec.chunks.push({ blob: e.data, t: Date.now() });
        const cut = Date.now() - 45000;
        while (rec.chunks.length && rec.chunks[0].t < cut) rec.chunks.shift();
      }
    };
    rec.recorder.onerror = () => {};
    try { rec.recorder.start(1000); } catch(e){ return; }
    this.rec = rec;
  },

  recLoop(){
    this.rafId = requestAnimationFrame(() => this.recLoop());
    if (!this.ready || this.src.readyState < 2 || !this.rec) return;
    const now = performance.now();
    if (now - this.recLastT < 16) return;
    this.recLastT = now;
    const ctx = this.rec.canvas.getContext("2d");
    const cw = this.rec.canvas.width, ch = this.rec.canvas.height;
    const vw = this.src.videoWidth, vh = this.src.videoHeight;
    if (!vw || !vh) return;
    const s = Math.max(cw / vw, ch / vh) * (this.zoom || 1), dw = vw * s, dh = vh * s;
    ctx.drawImage(this.src, (cw - dw) / 2, (ch - dh) / 2, dw, dh); // true orientation, never mirrored
  },

  extractClip(t0, t1){
    const rec = this.rec;
    if (!rec || !rec.recorder || !rec.initChunk || rec.chunks.length < 3) return null;
    const segs = rec.chunks.filter((c) => {
      if (c.blob === rec.initChunk) return false;
      return (c.t - 1000) <= t1 && c.t >= t0;
    }).map((c) => c.blob);
    if (!segs.length) return null;
    return new Blob([rec.initChunk].concat(segs), { type: rec.mime });
  },

  /* ---------- swing detection ---------- */
  resetDetect(){
    this.swingState = "idle"; this.consecHigh = 0; this.consecLow = 0;
    this.prevMotion = null; this.prevWrist = null;
  },

  motionScore(){
    const mc = this._mc, mctx = this.motionCtx;
    mctx.drawImage(this.capCanvas, 0, 0, mc.width, mc.height);
    let d;
    try { d = mctx.getImageData(0, 0, mc.width, mc.height).data; } catch(e){ return 0; }
    if (!this.prevMotion){
      this.prevMotion = new Uint8ClampedArray(d.length); this.prevMotion.set(d); return 0;
    }
    let sum = 0;
    const n = mc.width * mc.height;
    for (let i = 0; i < d.length; i += 4){
      const g = (d[i] + d[i+1] + d[i+2]) / 3;
      const pg = (this.prevMotion[i] + this.prevMotion[i+1] + this.prevMotion[i+2]) / 3;
      sum += Math.abs(g - pg);
    }
    this.prevMotion.set(d);
    return sum / n / 255;
  },

  capture(){
    if (!this.ready || this.src.readyState < 2) return;
    const vw = this.src.videoWidth, vh = this.src.videoHeight;
    if (!vw || !vh) return;
    const W = 320, H = Math.round(W * vh / vw);
    if (this.capCanvas.width !== W || this.capCanvas.height !== H){
      this.capCanvas.width = W; this.capCanvas.height = H;
    }
    const ctx = this.capCanvas.getContext("2d");
    const s = Math.max(W / vw, H / vh);
    ctx.drawImage(this.src, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);

    // activity 0..1: pose wrists preferred, motion fallback
    let activity = 0, viaPose = false;
    const now = performance.now();
    const wp = wristPos(this.capCanvas);
    if (wp && this.prevWrist){
      const dt = Math.max(1, now - this.prevWristT) / 1000;
      const dist = Math.hypot(wp.x - this.prevWrist.x, wp.y - this.prevWrist.y);
      activity = Math.min(1, (dist / dt) / 2.5);
      viaPose = true;
    }
    if (wp){ this.prevWrist = wp; this.prevWristT = now; }
    if (!viaPose) activity = Math.min(1, this.motionScore() / 0.20);

    this.updateSwing(activity, viaPose);
  },

  updateSwing(a, viaPose){
    const now = Date.now();
    if (!this.autoClip || !this.hitter || !this.ready){ this.resetDetect(); return; }
    if (now - this.lastClipAt < 5000){ if (this.swingState !== "idle") this.resetDetect(); return; }
    const th = SENS[this.sens];
    if (this.swingState === "idle"){
      this.consecHigh = (a > th.start) ? this.consecHigh + 1 : 0;
      if (this.consecHigh >= 3){
        this.swingState = "swinging"; this.swingT0 = now;
        this.peakAct = a; this.peakT = now; this.consecLow = 0;
      }
    } else {
      if (a > this.peakAct){ this.peakAct = a; this.peakT = now; }
      this.consecLow = (a < th.end) ? this.consecLow + 1 : 0;
      const dur = now - this.swingT0;
      if ((this.consecLow >= 6 && dur > 700) || dur > 4000) this.finishSwing();
    }
  },

  finishSwing(){
    const peakT = this.peakT;
    this.resetDetect();
    this.lastClipAt = Date.now();
    // clip: ~2s before contact to ~2s after (contact ~= peak hand speed)
    const t0 = peakT - 2000, t1 = peakT + 2000;
    const wait = Math.max(0, t1 - Date.now());
    const mime = this.rec ? this.rec.mime : "video/mp4";
    const onClip = this.onClip;
    setTimeout(() => {
      const blob = this.extractClip(t0, t1);
      if (!blob || !onClip) return;
      onClip(blob, mime, { durationS: Math.round((t1 - t0) / 1000), source: "auto" });
    }, wait);
  },

  saveManual(){
    if (!this.hitter){ this.toast("Pick a hitter first."); return; }
    const now = Date.now();
    const blob = this.extractClip(now - 10000, now);
    if (!blob){ this.toast("Still rolling — try again in a few seconds."); return; }
    if (this.onClip) this.onClip(blob, this.rec.mime, { durationS: 10, source: "manual" });
  },

  /* ---------- delay player (ping-pong) ---------- */
  dpEl(n){ return n === "A" ? this.dpA : this.dpB; },
  dpRevoke(n){
    if (this.dpUrls[n]){ try { URL.revokeObjectURL(this.dpUrls[n]); } catch(e){} this.dpUrls[n] = null; }
    this.dpLoadedT[n] = -1;
  },
  dpPrepare(name, t){
    const rec = this.rec;
    if (!rec || this.dpLoadedT[name] === t) return true;
    const c = rec.chunks.find((x) => x.t === t && x.blob !== rec.initChunk);
    if (!c || !rec.initChunk) return false;
    this.dpRevoke(name);
    this.dpUrls[name] = URL.createObjectURL(new Blob([rec.initChunk, c.blob], { type: rec.mime }));
    this.dpLoadedT[name] = t;
    const el = this.dpEl(name);
    el.preload = "auto"; el.src = this.dpUrls[name];
    try { el.load(); } catch(e){}
    return true;
  },
  dpShow(name, t, offset){
    const other = name === "A" ? "B" : "A";
    const el = this.dpEl(name), hideEl = this.dpEl(other);
    const doShow = () => {
      try { el.currentTime = Math.min(0.94, Math.max(0, offset || 0)); } catch(e){}
      el.style.opacity = "1"; hideEl.style.opacity = "0";
      try { const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); } catch(e){}
      this.dpShowing = name; this.dpCurT = t;
      const nxt = this.dpNextChunkT(t);
      if (nxt) this.dpPrepare(other, nxt);
    };
    if (this.dpLoadedT[name] === t && el.readyState >= 1) doShow();
    else {
      if (!this.dpPrepare(name, t)) return;
      const onMeta = () => { el.removeEventListener("loadedmetadata", onMeta); doShow(); };
      el.addEventListener("loadedmetadata", onMeta);
    }
  },
  dpNextChunkT(t){
    const rec = this.rec;
    if (!rec) return null;
    let best = null, bestD = 1e9;
    for (const c of rec.chunks){
      if (c.blob === rec.initChunk) continue;
      const d = c.t - t;
      if (d > 200 && d < bestD){ bestD = d; best = c; }
    }
    return best ? best.t : null;
  },
  dpChunkFor(target){
    const rec = this.rec;
    if (!rec) return null;
    for (let i = rec.chunks.length - 1; i >= 0; i--){
      const c = rec.chunks[i];
      if (c.blob === rec.initChunk) continue;
      if (c.t - 1000 <= target) return c;
    }
    return null;
  },
  dpWatchdog(){
    if (!this.ready || this.mode === "live" || !this.rec) return;
    if (!this.rec.initChunk || this.rec.chunks.length < 3){ $("warmup").hidden = false; return; }
    const target = Date.now() - this.delay * 1000;
    const c = this.dpChunkFor(target);
    if (!c){ $("warmup").hidden = false; return; }
    $("warmup").hidden = true;
    const offset = Math.min(0.94, Math.max(0, (target - (c.t - 1000)) / 1000));
    if (c.t === this.dpCurT){
      const el = this.dpEl(this.dpShowing);
      if (el.paused){ try { const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); } catch(e){} }
      else {
        try { if (el.readyState >= 1 && Math.abs(el.currentTime - offset) > 0.6) el.currentTime = offset; }
        catch(e){}
      }
      return;
    }
    this.dpShow(this.dpShowing === "A" ? "B" : "A", c.t, offset);
  },
  dpOnEnded(name){
    if (!this.ready || this.mode === "live") return;
    const nxt = this.dpNextChunkT(this.dpCurT);
    if (nxt) this.dpShow(name === "A" ? "B" : "A", nxt, 0);
  },
  dpHide(){
    ["A", "B"].forEach((n) => {
      const el = this.dpEl(n);
      try { el.pause(); } catch(e){}
      el.removeAttribute("src"); try { el.load(); } catch(e){}
      this.dpRevoke(n);
      el.style.opacity = "0";
    });
    this.dpCurT = -1; this.dpShowing = "A";
  }
};
cam.mode = "delay";
