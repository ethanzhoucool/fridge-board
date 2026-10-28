// Image resizing and voice recording helpers.

// Downscale a photo to keep uploads small; returns a JPEG Blob.
export async function resizeImage(file, maxSide = 1600, quality = 0.82) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
}

export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

// Safari records mp4/aac, Chrome and Firefox record webm/opus.
function pickMime() {
  for (const t of ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]) {
    if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  }
  return "";
}

export async function startRecording({ onLevel, maxSecs = 120, onLimit }) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 64;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let raf;
  const tick = () => {
    analyser.getByteFrequencyData(data);
    onLevel?.(data);
    raf = requestAnimationFrame(tick);
  };
  tick();

  const started = Date.now();
  const limit = setTimeout(() => onLimit?.(), maxSecs * 1000);
  rec.start(250);

  const cleanup = () => {
    clearTimeout(limit);
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
  };

  return {
    elapsed: () => (Date.now() - started) / 1000,
    stop: () =>
      new Promise((res) => {
        rec.onstop = () => {
          cleanup();
          const type = rec.mimeType || mime || "audio/webm";
          res({ blob: new Blob(chunks, { type }), secs: Math.round((Date.now() - started) / 1000), type });
        };
        rec.stop();
      }),
    cancel: () => {
      rec.onstop = cleanup;
      rec.stop();
    },
  };
}

// Stable pseudo-waveform per post so the feed looks like audio without decoding it.
export function wave(seed, n = 18) {
  let x = (Number(seed) * 9301 + 49297) % 233280;
  return Array.from({ length: n }, (_, i) => {
    x = (x * 9301 + 49297) % 233280;
    const env = Math.sin((i / n) * Math.PI) * 0.6 + 0.4;
    return Math.max(0.12, (x / 233280) * env);
  });
}

export const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
