/* ─── Real-time Phase-Vocoder AudioWorklet ────────────────────────────────────
   Two-stage processing (mirrors the original offline renderer):
     1. Phase vocoder time-stretches by (pitchFactor / tempoFactor).
        Analysis hop is always HA; synthesis hop = round(HA × pf / tf).
     2. Ring-buffer output is read at a fractional rate of pitchFactor
        (linear interpolation).  Reading faster raises frequencies.

   Net result for arbitrary pitch (pf = 2^(semitones/12)) and tempo (tf):
     output_duration = (pf / tf) / pf × input_duration = input_duration / tf ✓
     output_pitch    = pf × input_pitch                                        ✓
   ─────────────────────────────────────────────────────────────────────────── */

'use strict';

const N = 1024, HA = 256, HALF = N >> 1;
const TP = 2 * Math.PI;

/* Hann window */
const W = new Float32Array(N);
for (let i = 0; i < N; i++) W[i] = 0.5 * (1 - Math.cos(TP * i / (N - 1)));

/* In-place Cooley-Tukey radix-2 FFT */
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1;
    for (; j & b; b >>= 1) j ^= b;
    j ^= b;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 1 : -1) * TP / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let ur = 1, ui = 0;
      for (let j = 0; j < len >> 1; j++) {
        const k = i + j + (len >> 1);
        const ar = re[i+j], ai = im[i+j];
        const br = re[k]*ur - im[k]*ui;
        const bi = re[k]*ui + im[k]*ur;
        re[i+j] = ar+br; im[i+j] = ai+bi;
        re[k] = ar-br;   im[k] = ai-bi;
        const t = ur*wr - ui*wi;
        ui = ur*wi + ui*wr; ur = t;
      }
    }
  }
  if (inv) { const s = 1 / n; for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; } }
}

/* Ring buffer — 2^19 = 524 288 samples ≈ 11.9 s @ 44.1 kHz */
const RBITS = 19;
const RSIZE = 1 << RBITS;
const RMASK = RSIZE - 1;

class PVProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitch', defaultValue: 0, minValue: -24, maxValue: 24,
        automationRate: 'k-rate' },
      { name: 'tempo', defaultValue: 1, minValue: 0.25, maxValue: 4,
        automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._ch  = null;
    this._nc  = 0;
    this._il  = 0;
    this._ip  = 0;   // input read position (integer — HA is always integer)

    this._lp  = null;
    this._sp  = null;

    this._rb  = null;
    this._rw  = null;
    this._ow  = 0;   // linear ring-write counter
    this._or  = 0;   // linear ring-read  counter (integer part)
    this._orf = 0;   // fractional part of ring-read (for pitch resampling)

    this._re  = new Float32Array(N);
    this._im  = new Float32Array(N);
    this._ore = new Float32Array(N);
    this._oim = new Float32Array(N);

    this._on    = false;
    this._ended = false;

    this.port.onmessage = ({ data: d }) => {
      if (d.t === 'load') {
        this._nc = d.ch.length;
        this._il = d.ch[0].length;
        this._ch = d.ch;
        this._ip = d.s | 0;
        this._ow = 0; this._or = 0; this._orf = 0;
        this._rb  = Array.from({ length: this._nc }, () => new Float32Array(RSIZE));
        this._rw  = new Float32Array(RSIZE);
        this._lp  = Array.from({ length: this._nc }, () => new Float32Array(N));
        this._sp  = Array.from({ length: this._nc }, () => new Float32Array(N));
        this._on  = true;
        this._ended = false;

      } else if (d.t === 'seek') {
        if (!this._ch) return;
        this._ip = d.s | 0;
        this._ow = 0; this._or = 0; this._orf = 0;
        this._rb.forEach(r => r.fill(0));
        this._rw.fill(0);
        this._lp.forEach(a => a.fill(0));
        this._sp.forEach(a => a.fill(0));
        this._on = true;
        this._ended = false;

      } else if (d.t === 'stop') {
        this._on = false;
      }
    };
  }

  /* Committed ring samples (fully overlap-added, safe to drain) */
  _safe() {
    return Math.max(0, this._ow - HALF - this._or);
  }

  /* Phase-vocoder frame: time-stretch only (pitch preserved).
     Synthesis hop hs = round(HA × pf / tf) controls stretch ratio. */
  _frame(hs) {
    if (this._ow - this._or + N >= RSIZE) return;  // ring nearly full

    for (let c = 0; c < this._nc; c++) {
      const inp = this._ch[c];
      const re = this._re, im = this._im;
      const ore = this._ore, oim = this._oim;
      const lp = this._lp[c], sp = this._sp[c];
      const rb = this._rb[c];

      re.fill(0); im.fill(0);
      for (let i = 0; i < N; i++) {
        const s = this._ip - HALF + i;
        re[i] = (s >= 0 && s < this._il) ? inp[s] * W[i] : 0;
      }

      fft(re, im, false);

      ore.fill(0); oim.fill(0);
      for (let k = 0; k <= HALF; k++) {
        const mag = Math.sqrt(re[k]*re[k] + im[k]*im[k]);
        const ph  = Math.atan2(im[k], re[k]);
        let   dp  = ph - lp[k] - TP * k * HA / N;
        dp -= TP * Math.round(dp / TP);
        sp[k] += hs * (TP * k / N + dp / HA);
        lp[k]  = ph;
        ore[k] = mag * Math.cos(sp[k]);
        oim[k] = mag * Math.sin(sp[k]);
        if (k > 0 && k < HALF) { ore[N-k] = ore[k]; oim[N-k] = -oim[k]; }
      }

      fft(ore, oim, true);

      for (let i = 0; i < N; i++) {
        rb[(this._ow - HALF + i + RSIZE * 2) & RMASK] += ore[i] * W[i];
      }
    }

    const rw = this._rw;
    for (let i = 0; i < N; i++) {
      rw[(this._ow - HALF + i + RSIZE * 2) & RMASK] += W[i] * W[i];
    }

    this._ip += HA;
    this._ow += hs;
  }

  process(_inputs, outputs, parameters) {
    if (!this._on) return true;

    const out = outputs[0];
    const bs  = out[0]?.length ?? 128;

    const pitch = parameters.pitch[0] ?? 0;
    const tempo = parameters.tempo[0] ?? 1;
    const pf    = Math.pow(2, pitch / 12);

    /* Synthesis hop: phase vocoder stretches by pf/tempo.
       After resampling at rate pf the duration becomes 1/tempo × original. */
    const hs = Math.max(1, Math.round(HA * pf / tempo));

    /* Fill ring: we consume pf ring samples per output sample,
       so target lookahead is bs × pf × 8. */
    const TARGET = Math.min(Math.ceil(bs * pf) * 8, RSIZE >> 1);
    while (this._safe() < TARGET && this._ip < this._il + HALF) {
      this._frame(hs);
    }

    /* ── Drain with fractional resampling (pitch shift) ──
       Reading the ring at pf× speed raises frequencies by pf.
       _orf tracks the sub-sample fractional offset. */
    const avail = this._safe();
    /* Max output samples we can produce: need (i*pf + _orf + 1) < avail */
    const canProduce = pf <= 1
      ? avail
      : Math.max(0, Math.floor((avail - 1 - this._orf) / pf));
    const read = Math.min(canProduce, bs);

    for (let c = 0; c < out.length; c++) {
      const rb = this._rb[Math.min(c, this._nc - 1)];
      const o  = out[c];
      for (let i = 0; i < read; i++) {
        const fp   = this._orf + i * pf;
        const i0   = fp | 0;
        const frc  = fp - i0;
        const pos0 = (this._or + i0)     & RMASK;
        const pos1 = (this._or + i0 + 1) & RMASK;
        const w0   = this._rw[pos0], w1 = this._rw[pos1];
        const s0   = w0 > 1e-8 ? rb[pos0] / w0 : 0;
        const s1   = w1 > 1e-8 ? rb[pos1] / w1 : 0;
        o[i] = s0 + frc * (s1 - s0);
      }
      for (let i = read; i < bs; i++) o[i] = 0;
    }

    /* Advance the fractional ring pointer and clear consumed samples */
    if (read > 0) {
      const totalFrac = this._orf + read * pf;
      const intAdv    = totalFrac | 0;
      this._orf       = totalFrac - intAdv;

      for (let c = 0; c < this._nc; c++) {
        const rb = this._rb[c];
        for (let i = 0; i < intAdv; i++) rb[(this._or + i) & RMASK] = 0;
      }
      const rw = this._rw;
      for (let i = 0; i < intAdv; i++) rw[(this._or + i) & RMASK] = 0;
      this._or += intAdv;
    }

    /* Signal end-of-audio */
    if (this._ip >= this._il + HALF && this._safe() === 0) {
      if (!this._ended) {
        this._ended = true;
        this.port.postMessage({ t: 'ended' });
      }
      return false;
    }

    return true;
  }
}

registerProcessor('pv-proc', PVProcessor);
