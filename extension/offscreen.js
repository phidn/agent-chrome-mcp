// Offscreen document: the only place an MV3 extension can run MediaRecorder.
// Two transports feed the recorder:
//   - "screencast": background streams CDP Page.screencastFrame JPEGs here (fully
//     autonomous tab/area capture — no user gesture, no picker). We paint the
//     latest frame onto a canvas and record canvas.captureStream().
//   - "stream": a desktopCapture streamId (screen/window) consumed via
//     getUserMedia. Needs a one-time native picker, handled in background.
// Driven by background.js via chrome.runtime messaging (target: "offscreen").

let recorder = null;       // MediaRecorder
let chunks = [];           // recorded Blob parts
let activeMime = "";

// screencast transport state
let canvas = null;
let ctx = null;
let rafId = null;
let latestBitmap = null;   // most recent decoded frame (ImageBitmap)
let cfg = null;            // { source, region, fps }
let recorderStarted = false;

// stream transport state
let sourceStream = null;   // raw getUserMedia stream (desktop)
let audioCtx = null;       // re-pipes captured audio so it stays audible

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  switch (msg.cmd) {
    case "start":
      startRecording(msg)
        .then((r) => sendResponse(r))
        .catch((e) => { cleanup(); sendResponse({ ok: false, error: errStr(e) }); });
      return true; // async
    case "frame":
      onScreencastFrame(msg.data).catch(() => {});
      return false; // fire-and-forget
    case "stop":
      stopRecording()
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: errStr(e) }));
      return true; // async
  }
});

const errStr = (e) => String((e && e.message) || e);

async function startRecording(msg) {
  if (recorder || cfg) throw new Error("A recording is already in progress.");
  activeMime = pickMime(msg.mimeType);

  if (msg.transport === "screencast") {
    cfg = { source: msg.source, region: msg.region || null, fps: msg.fps || 30,
            videoBitsPerSecond: msg.videoBitsPerSecond };
    canvas = document.createElement("canvas");
    // For "area" the size is known; for "tab" it's set from the first frame.
    if (cfg.source === "area" && cfg.region) {
      canvas.width = Math.max(1, cfg.region.width | 0);
      canvas.height = Math.max(1, cfg.region.height | 0);
    } else {
      canvas.width = 1280;
      canvas.height = 720;
    }
    ctx = canvas.getContext("2d");
    // Recorder starts lazily once the first frame sets real dimensions.
    return { ok: true, mimeType: activeMime || "video/webm" };
  }

  // transport === "stream" (desktopCapture screen/window)
  const constraints = {
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: msg.streamId,
        maxWidth: 3840,
        maxHeight: 2160,
        maxFrameRate: msg.fps || 30,
      },
    },
  };
  if (msg.audio) {
    constraints.audio = { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: msg.streamId } };
  }
  sourceStream = await navigator.mediaDevices.getUserMedia(constraints);
  if (msg.audio && sourceStream.getAudioTracks().length) {
    audioCtx = new AudioContext();
    audioCtx.createMediaStreamSource(sourceStream).connect(audioCtx.destination);
  }
  startRecorder(sourceStream, msg.videoBitsPerSecond);
  const vTrack = sourceStream.getVideoTracks()[0];
  if (vTrack) vTrack.addEventListener("ended", () => { if (recorder) stopRecording().catch(() => {}); });
  return { ok: true, mimeType: activeMime || "video/webm" };
}

async function onScreencastFrame(base64) {
  if (!cfg || !canvas) return;
  const bitmap = await base64ToBitmap(base64);
  if (latestBitmap && latestBitmap.close) { try { latestBitmap.close(); } catch {} }
  latestBitmap = bitmap;

  if (!recorderStarted) {
    if (cfg.source !== "area") {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    startDrawLoop();
    startRecorder(canvas.captureStream(cfg.fps), cfg.videoBitsPerSecond);
    recorderStarted = true;
  }
}

function startDrawLoop() {
  const draw = () => {
    if (latestBitmap) {
      try {
        if (cfg.source === "area" && cfg.region) {
          const r = cfg.region;
          ctx.drawImage(latestBitmap, Math.max(0, r.x | 0), Math.max(0, r.y | 0),
            canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        } else {
          ctx.drawImage(latestBitmap, 0, 0, canvas.width, canvas.height);
        }
      } catch {}
    }
    rafId = requestAnimationFrame(draw);
  };
  draw();
}

function startRecorder(stream, videoBitsPerSecond) {
  const opts = {};
  if (activeMime) opts.mimeType = activeMime;
  if (videoBitsPerSecond) opts.videoBitsPerSecond = videoBitsPerSecond;
  chunks = [];
  recorder = new MediaRecorder(stream, opts);
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.start(1000); // flush a chunk every second so long captures aren't lost
}

function base64ToBitmap(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
}

function pickMime(preferred) {
  const candidates = [
    preferred,
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp8",
    "video/webm",
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch {}
  }
  return "";
}

function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!recorder) {
      // screencast set up but no frame ever arrived
      cleanup();
      resolve({ ok: false, error: "No frames were captured." });
      return;
    }
    const rec = recorder;
    rec.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: activeMime || "video/webm" });
        const size = blob.size;
        const dataUrl = await blobToDataUrl(blob);
        cleanup();
        resolve({ ok: true, dataUrl, size, mimeType: activeMime || "video/webm" });
      } catch (e) { cleanup(); reject(e); }
    };
    try { rec.stop(); } catch (e) { cleanup(); reject(e); }
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function cleanup() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  try { if (sourceStream) sourceStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (audioCtx) audioCtx.close(); } catch {}
  if (latestBitmap && latestBitmap.close) { try { latestBitmap.close(); } catch {} }
  recorder = null; chunks = []; cfg = null; canvas = null; ctx = null;
  latestBitmap = null; recorderStarted = false; sourceStream = null; audioCtx = null;
}
