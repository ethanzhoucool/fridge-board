// Tiny synthesized sounds, no audio files. The context is created on the first tap,
// since browsers only allow audio after a user gesture.

let ctx;
function ac() {
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// A burst of filtered noise sounds like a marker dragged across a whiteboard.
function scratch(c, at, dur, from, to, gain) {
  const len = Math.ceil(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(from, at);
  bp.frequency.exponentialRampToValueAtTime(to, at + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  src.connect(bp).connect(g).connect(c.destination);
  src.start(at);
  src.stop(at + dur);
}

function bell(c, at, freq, dur, gain) {
  for (const [mult, amp] of [[1, 1], [2, 0.25], [3.01, 0.08]]) {
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.value = freq * mult;
    const g = c.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain * amp, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, at + dur);
    o.connect(g).connect(c.destination);
    o.start(at);
    o.stop(at + dur);
  }
}

export const sfx = {
  // One tally mark: a short marker flick.
  mark() {
    try { const c = ac(), t = c.currentTime; scratch(c, t, 0.07, 2600, 1400, 0.22); } catch {}
  },
  // Rubbing a mark out: a softer, lower swipe.
  erase() {
    try { const c = ac(), t = c.currentTime; scratch(c, t, 0.12, 900, 500, 0.12); } catch {}
  },
  // Goal finished: the strike-through swipe, then a bright two-note chime.
  done() {
    try {
      const c = ac(), t = c.currentTime;
      scratch(c, t, 0.26, 1800, 4200, 0.2);
      bell(c, t + 0.2, 659.25, 0.9, 0.18);
      bell(c, t + 0.31, 987.77, 1.3, 0.16);
    } catch {}
  },
};
