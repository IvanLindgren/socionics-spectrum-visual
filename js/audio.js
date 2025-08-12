// js/audio.js
import { SAMPLE_RATE, SIGNAL_SECONDS, SCALE } from '../data.js';

function mixHarmonicsSample(harmonics, tNorm, lfo, lfoDepth){
  // tNorm ∈ [0..1] вдоль сигнала
  let s = 0;
  for (const h of harmonics){
    const A = h.amp || 0;
    const f = (h.freq || 1);
    const p = (h.phase || 0);
    s += A * Math.sin(2*Math.PI * (f*tNorm + lfoDepth*lfo) + p);
  }
  return s;
}

function normalize(buf){
  let peak = 0;
  for (let i=0;i<buf.length;i++) peak = Math.max(peak, Math.abs(buf[i]));
  const k = peak>0 ? 0.98/peak : 1;
  if (k !== 1) for (let i=0;i<buf.length;i++) buf[i] *= k;
}

function computeRmsPeak(buf){
  let sumSq = 0;
  let peak = 0;
  for (let i=0;i<buf.length;i++){
    const s = buf[i];
    sumSq += s*s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, buf.length));
  const crest = rms > 0 ? peak / rms : 0;
  return { rms, peak, crest };
}

function hannWindow(n, N){
  return 0.5 * (1 - Math.cos(2*Math.PI*n/(N-1)));
}

function computeSpectrumMono(ch, sr, fftSize = 512){
  // Простейший DFT с окном Ханна, возвращает массив амплитуд [0..1] для N/2 бинов
  const N = Math.min(fftSize, ch.length);
  const start = Math.max(0, Math.floor((ch.length - N)/2));
  const win = new Float32Array(N);
  for (let n=0; n<N; n++) win[n] = hannWindow(n, N);
  const re = new Float32Array(N/2);
  const im = new Float32Array(N/2);
  const mags = new Float32Array(N/2);
  for (let k=0; k<N/2; k++){
    let sumRe = 0, sumIm = 0;
    for (let n=0; n<N; n++){
      const x = ch[start+n] * win[n];
      const ph = -2*Math.PI*k*n/N;
      sumRe += x * Math.cos(ph);
      sumIm += x * Math.sin(ph);
    }
    re[k] = sumRe; im[k] = sumIm;
    mags[k] = Math.sqrt(sumRe*sumRe + sumIm*sumIm);
  }
  // нормализация
  let peak = 0; for (let k=0;k<mags.length;k++) peak = Math.max(peak, mags[k]);
  const norm = peak>0 ? 1/peak : 1;
  for (let k=0;k<mags.length;k++) mags[k] *= norm;

  // спектральный центроид
  let num = 0, den = 0;
  for (let k=1;k<mags.length;k++){
    const f = (k * sr) / N;
    num += f * mags[k];
    den += mags[k];
  }
  const centroidHz = den>0 ? num/den : 0;
  return { mags, centroidHz };
}

export async function renderBuffer(harmonics, seconds = SIGNAL_SECONDS, sr = SAMPLE_RATE){
  const length = Math.floor(seconds * sr);
  const offline = new OfflineAudioContext(1, length, sr);

  const buffer = offline.createBuffer(1, length, sr);
  const ch = buffer.getChannelData(0);

  // глубина LFO зависит от средней амплитуды, чтобы на малых значениях не было "дрожи"
  const meanAmp = harmonics.length ? (harmonics.reduce((acc,h)=>acc + Math.abs(h.amp||0),0) / harmonics.length) : 0;
  const lfoDepth = 0.02 + 0.05 * meanAmp; // [0.02..0.07]

  let lfoPhase = 0;
  const lfoStep = 2*Math.PI / (sr*3.2); // чуть медленнее, ≈0.31 Гц

  // плавная огибающая с косинусными окнами (attack/release)
  const attackS = Math.floor(sr * 0.035);
  const releaseS = Math.floor(sr * 0.16);

  for (let i=0;i<length;i++){
    const tNorm = i / (length-1); // 0..1
    const sample = mixHarmonicsSample(harmonics, tNorm, Math.sin(lfoPhase), lfoDepth);

    let env = 1;
    if (i < attackS){
      const u = i/Math.max(1,attackS);
      env *= (1 - Math.cos(Math.PI*u)) * 0.5; // 0..1
    }
    if (i > length-1-releaseS){
      const u = (length-1 - i)/Math.max(1,releaseS);
      env *= (1 - Math.cos(Math.PI*Math.max(0,u))) * 0.5; // 1..0
    }

    ch[i] = sample * 0.38 * env;
    lfoPhase += lfoStep;
  }

  normalize(ch);

  const src = offline.createBufferSource();
  src.buffer = buffer;

  const preEqHi = offline.createBiquadFilter();
  preEqHi.type = 'highshelf';
  preEqHi.frequency.value = 9000;
  preEqHi.gain.value = -1.5;

  const preEqLo = offline.createBiquadFilter();
  preEqLo.type = 'lowshelf';
  preEqLo.frequency.value = 120;
  preEqLo.gain.value = 0.8;

  const comp = offline.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 12;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.12;

  src.connect(preEqHi).connect(preEqLo).connect(comp).connect(offline.destination);
  src.start();

  const rendered = await offline.startRendering();

  try{
    const met = computeRmsPeak(rendered.getChannelData(0));
    console.debug('[audio]', `RMS=${met.rms.toFixed(4)}`, `Peak=${met.peak.toFixed(4)}`, `Crest=${met.crest.toFixed(2)}`);
  }catch{}

  return rendered;
}

export function playBuffer(ctx, audioBuffer){
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  const gain = ctx.createGain();
  gain.gain.value = 0.9;
  src.connect(gain).connect(ctx.destination);
  src.start();
  return { src, gain };
}

// WAV encoder (PCM 16-bit little-endian) со стерео-ширителем и очень лёгким dither
function encodeWAV(audioBuffer){
  const sr = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const numChannels = audioBuffer.numberOfChannels; // Используем количество каналов из буфера
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample * numChannels;
  const byteRate = sr * blockAlign;
  const dataSize = numFrames * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buf = new ArrayBuffer(totalSize);
  const dv = new DataView(buf);

  let p = 0;
  function writeString(s){ for(let i=0;i<s.length;i++) dv.setUint8(p++, s.charCodeAt(i)); }
  function writeUint32(v){ dv.setUint32(p, v, true); p+=4; }
  function writeUint16(v){ dv.setUint16(p, v, true); p+=2; }

  writeString('RIFF');
  writeUint32(totalSize-8);
  writeString('WAVE');
  writeString('fmt ');
  writeUint32(16);
  writeUint16(1);
  writeUint16(numChannels);
  writeUint32(sr);
  writeUint32(byteRate);
  writeUint16(blockAlign);
  writeUint16(16);
  writeString('data');
  writeUint32(dataSize);

  // подготовка стерео: правый канал — слегка задержан и ослаблен (ширитель ~15ms)
  const ditherAmp = 1/32768 * 0.6; // очень лёгкий треугольный dither
  const tailStart = Math.max(0, numFrames - Math.round(sr * 0.5));

  for (let i=0;i<numFrames;i++){
    for (let channel=0; channel<numChannels; channel++){
      const data = audioBuffer.getChannelData(channel);
      let sample = data[i];
      // лёгкий dither; на последней 0.5с чуть больше на -66 dB
      const dith = (Math.random() - Math.random()) * (i>=tailStart ? ditherAmp*1.6 : ditherAmp);
      sample = Math.max(-1, Math.min(1, sample + dith));
      dv.setInt16(p, sample < 0 ? sample*0x8000 : sample*0x7fff, true); p += 2;
    }
  }
  return new Blob([dv], {type:'audio/wav'});
}

export async function exportWAV(harmonics, seconds = SIGNAL_SECONDS, sr = SAMPLE_RATE){
  const rendered = await renderBuffer(harmonics, seconds, sr);
  return encodeWAV(rendered);
}

// Анализ готового буфера: метрики + компактный спектр (64 бина)
export function analyzeAudioBuffer(audioBuffer){
  const ch = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  const { rms, peak, crest } = computeRmsPeak(ch);
  const { mags, centroidHz } = computeSpectrumMono(ch, sr, 512);
  // агрегация в 64 столбца лог-шкалой
  const bins = 64;
  const out = new Float32Array(bins);
  for (let i=0;i<bins;i++){
    const a = Math.floor((i   /bins) * (mags.length));
    const b = Math.floor(((i+1)/bins) * (mags.length));
    let m = 0; let cnt=0;
    for (let k=a;k<b;k++){ m = Math.max(m, mags[k]||0); cnt++; }
    out[i] = m;
  }
  return { rms, peak, crest, centroidHz, spectrum: out };
}

// ===== Музыкальный слой (продвинутый) =====
function midiToHz(midi){ return 440 * Math.pow(2, (midi - 69)/12); }

// Дополнительная шкала: C мажор пентатоника (2 октавы)
const MAJOR_SCALE = [48, 50, 52, 55, 57, 60, 62, 64, 67, 69, 72];

function pickTopHarmonics(harmonics, n=8){
  return harmonics
    .slice()
    .sort((a,b)=>Math.abs(b.amp||0)-Math.abs(a.amp||0))
    .slice(0,n);
}

function quantizeFreqToScale(freq, scale=SCALE){
  const midi = 69 + 12*Math.log2(freq/440);
  let best = scale[0];
  let bestDiff = Infinity;
  for (const m of scale){
    const d = Math.abs(m - midi);
    if (d < bestDiff){ bestDiff = d; best = m; }
  }
  return midiToHz(best);
}

function makeDelayReverb(ctx){
  const delay = ctx.createDelay(1.0); delay.delayTime.value = 0.23;
  const fb = ctx.createGain(); fb.gain.value = 0.32;
  const tone = ctx.createBiquadFilter(); tone.type='lowpass'; tone.frequency.value = 4200;
  delay.connect(fb).connect(tone).connect(delay);
  return { in: delay, out: delay, setTime:(t)=>delay.delayTime.setValueAtTime(t, ctx.currentTime) };
}

export async function renderMusicBuffer(harmonics, seconds = 16, sr = SAMPLE_RATE){
  const length = Math.floor(seconds * sr);
  const offline = new OfflineAudioContext(2, length, sr);

  const tops = pickTopHarmonics(harmonics, 8);

  // Считаем карту score по ключу признака
  const scoreByKey = Object.create(null);
  for (const h of harmonics){ if (h && h.key) scoreByKey[h.key] = Number.isFinite(h.score) ? h.score : 0; }
  const s = (key)=> (Number.isFinite(scoreByKey[key]) ? scoreByKey[key] : 0);

  // ритм и темп с учётом признаков
  const baseBpm = 96 + Math.round(8 * Math.max(0, s('Yeel-Ser'))); // веселость → чуть быстрее
  const bpm = Math.max(72, Math.min(132, baseBpm));
  const beatDur = 60/bpm;         // 1/4
  const stepDur = beatDur/2;      // 1/8
  const swingAmt = Math.max(0, 0.02 + 0.10*Math.max(0, s('Proc-Res')) + 0.05*Math.max(0, s('Stat-Dyn'))); // процесс/динамика → больше свинга

  const master = offline.createGain();
  master.gain.value = 0.9;

  // ширина стерео и панорама зависят от E-I и Dem-Aris
  const stereoWidth = Math.max(0.2, Math.min(1.2, 0.7 + 0.35*Math.max(0, s('E-I')) + 0.25*Math.max(0, s('Dem-Aris')) - 0.2*Math.max(0, -s('Dem-Aris'))));

  // сумматоры L/R
  const sumL = offline.createGain();
  const sumR = offline.createGain();
  sumL.gain.value = 1; sumR.gain.value = 1;

  const panToLR = (pan)=>{
    const p = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0));
    const angle = (p*stereoWidth + 1) * Math.PI/4;
    return { L: Math.cos(angle), R: Math.sin(angle) };
  };

  const startAt = 0.05;
  const totalSteps = Math.floor((seconds-0.1)/stepDur);

  // эффект эхо/реверб, время зависит от E-I
  const fx = makeDelayReverb(offline);
  const fxSend = offline.createGain(); fxSend.gain.value = 0.18 + 0.18*Math.max(0, s('Con-Emo')) + 0.12*Math.max(0, s('E-I'));
  try { fx.setTime(0.18 + 0.14*Math.max(0, s('E-I'))); } catch {}
  const wetL = offline.createGain(); const wetR = offline.createGain(); wetL.gain.value = 0.9; wetR.gain.value=0.9;
  fx.in.connect(wetL).connect(sumL);
  fx.out.connect(wetR).connect(sumR);

  // простая перкуссия: хэт на 1/8, кик на 1 и 3 доли, уровень зависит от Result
  const hatNoiseBuf = offline.createBuffer(1, Math.floor(sr*0.05), sr);
  const hatData = hatNoiseBuf.getChannelData(0);
  for (let i=0;i<hatData.length;i++) hatData[i] = (Math.random()*2-1) * (1 - i/hatData.length);

  function scheduleHat(t0){
    const src = offline.createBufferSource(); src.buffer = hatNoiseBuf;
    const bp = offline.createBiquadFilter(); bp.type='highpass'; bp.frequency.value=6000;
    const g = offline.createGain(); g.gain.value=0.15;
    src.connect(bp).connect(g).connect(sumL);
    src.connect(bp).connect(g).connect(sumR);
    src.start(t0);
  }

  function scheduleKick(t0, level=0.9){
    const osc = offline.createOscillator(); osc.type='sine';
    const g = offline.createGain(); g.gain.value = Math.max(0.2, Math.min(1.4, level));
    const env = offline.createGain(); env.gain.setValueAtTime(0, t0);
    env.gain.exponentialRampToValueAtTime(1.0, t0+0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t0+0.18);
    // эмуляция питч-энв: frequency от 120 до 48 Гц
    osc.frequency.setValueAtTime(120, t0);
    osc.frequency.exponentialRampToValueAtTime(48, t0+0.18);
    osc.connect(g).connect(env).connect(sumL);
    osc.connect(g).connect(env).connect(sumR);
    osc.start(t0); osc.stop(t0+0.22);
  }

  // мелодический голос: три осциллятора, фильтр, огибающая, панорама и посыл в FX
  function voiceAt(t0, freq, amp, pan, shape='sine', detune=0, filterCutoff=3000, filterQ=0.6, envAttack=0.02, envRelease=0.4){
    const o1 = offline.createOscillator(); o1.type = shape; o1.frequency.value = Math.max(10, freq + detune);
    const o2 = offline.createOscillator(); o2.type = shape; o2.frequency.value = Math.max(10, freq*Math.pow(2, 6/1200) + detune);
    const o3 = offline.createOscillator(); o3.type = shape; o3.frequency.value = Math.max(10, freq*Math.pow(2, -7/1200) + detune);

    const mix = offline.createGain(); mix.gain.value = Math.max(0, amp);
    const filt = offline.createBiquadFilter(); filt.type = 'lowpass';
    filt.frequency.value = Math.max(50, Math.min(20000, filterCutoff||3000));
    filt.Q.value = Math.max(0.0001, Math.min(25, filterQ||0.6));

    // громкостная огибающая
    const env = offline.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(1.0, t0 + Math.max(0.001, envAttack||0.02));
    env.gain.exponentialRampToValueAtTime(0.25, t0 + 0.10);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.12, envRelease||0.4));

    o1.connect(mix); o2.connect(mix); o3.connect(mix);
    mix.connect(filt).connect(env);

    // панорамирование в L/R
    const lr = panToLR(pan);
    const gL = offline.createGain(); gL.gain.value = lr.L;
    const gR = offline.createGain(); gR.gain.value = lr.R;
    env.connect(gL).connect(sumL);
    env.connect(gR).connect(sumR);

    // FX send
    env.connect(fxSend).connect(fx.in);

    o1.start(t0); o2.start(t0); o3.start(t0);
    const stopT = t0 + Math.max(0.2, Math.min(1.2, envRelease||0.4)) + 0.2;
    o1.stop(stopT); o2.stop(stopT); o3.stop(stopT);
  }

  // выбор формы волны на основе T-F и P-J
  function chooseShape(){
    const tf = s('T-F'); // >0 логика, <0 этика
    const pj = s('P-J'); // >0 иррациональность? в нашей модели P-J: v>=0 Иррациональность, J на отрицательном
    if (tf>0.4 && pj<0) return 'square';
    if (pj>0.4) return 'sawtooth';
    if (tf< -0.4) return 'triangle';
    return 'sine';
  }

  const chosenScale = (s('Yeel-Ser')>0 ? MAJOR_SCALE : SCALE);

  // сгенерируем партитуру на основе вкладов
  const meanAmp = tops.reduce((a,h)=>a+Math.abs(h.amp||0),0)/Math.max(1,tops.length);

  for (let si=0; si<totalSteps; si++){
    const tBase = startAt + si*stepDur;
    const t0 = tBase + ((si%2) ? swingAmt*stepDur : 0); // свинг на каждую вторую восьмую

    // перкуссия
    scheduleHat(t0);
    if (si % 4 === 0) {
      const kickLvl = 0.9 + 0.4 * Math.max(0, -s('Proc-Res')) + 0.2*Math.abs(s('Rass-Resh')); // результат и решительность → сильнее удар
      scheduleKick(t0, kickLvl);
    }

    // мелодические голоса по сильным гармоникам
    for (let vi=0; vi<tops.length; vi++){
      const h = tops[vi];
      const act = Math.abs(h.amp||0);
      const rnd = (Math.sin((vi+1)*53.17 + si*0.77) * 0.5 + 0.5); // детерминированный
      // плотность фраз: тактика больше нот, стратегия меньше + беспечность даёт ещё синкоп
      const tacStr = s('Tac-Str');
      const care = s('Care-Plan');
      const densityBias = (tacStr>=0 ? -0.12*Math.min(1, tacStr) : +0.12*Math.min(1, -tacStr)) + (care>0 ? -0.08*care : +0.06*Math.abs(Math.min(0,care)));
      if (rnd > (0.55 + 0.35*(1-act) + densityBias)) continue; // реже для слабых/стратегии/предусмотрительности

      // базовая частота к масштабу и октава от N-S (интуиция — выше, сенсорика — ниже)
      const base = quantizeFreqToScale((h.freq||1) * 220, chosenScale);
      let octave = vi%3===0 ? 0.5 : (vi%3===1 ? 1 : 2);
      const ns = s('N-S');
      if (ns>0.3) octave *= 2; else if (ns<-0.3) octave *= 0.5;
      const freq = base * octave;
      const amp = 0.10 + 0.35*act*act; // Усиление влияния амплитуды

      // безопасные значения score и pan
      const score = Number.isFinite(h.score) ? h.score : 0;
      let pan = Number.isFinite(h.pan) ? h.pan : Math.sin(vi*0.9 + si*0.2);
      if (!Number.isFinite(pan)) pan = 0;
      pan = Math.max(-1, Math.min(1, pan));

      const shape = chooseShape();
      // детюн: от score + «нервность» по Ques-Decl
      let detune = score * 8;
      const qd = s('Ques-Decl');
      detune += (qd>0 ? qd*6 : 0) * Math.sin(si*0.31 + vi*0.7);

      // параметры фильтра и огибающих с предохраняющими clamp
      let filterCutoff = 1800 + 3400 * (0.5 + score * 0.5) + 800*Math.max(0, s('Pos-Neg')); // позитивизм → ярче
      filterCutoff = Math.max(200, Math.min(12000, Number.isFinite(filterCutoff) ? filterCutoff : 3000));
      let filterQ = 0.8 + 0.6 * act;
      filterQ = Math.max(0.0001, Math.min(20, Number.isFinite(filterQ) ? filterQ : 0.8));
      let envAttack = 0.01 + 0.05 * (1 - Math.abs(score)) + 0.03*Math.max(0, s('P-J'));
      envAttack = Math.max(0.001, Math.min(0.25, Number.isFinite(envAttack) ? envAttack : 0.02));
      let envRelease = 0.28 + 0.5 * (0.5 + score * 0.5) + 0.25*Math.max(0, -s('P-J')) + 0.2*Math.max(0, -s('Tac-Str'));
      envRelease = Math.max(0.12, Math.min(1.6, Number.isFinite(envRelease) ? envRelease : 0.4));

      voiceAt(t0, freq, amp, pan, shape, detune, filterCutoff, filterQ, envAttack, envRelease);
    }
  }

  // мастер цепочка
  const stereo = offline.createChannelMerger(2);
  sumL.connect(stereo, 0, 0);
  sumR.connect(stereo, 0, 1);

  const comp = offline.createDynamicsCompressor();
  comp.threshold.value = -18 - 4*Math.max(0, s('Yield-Head')); // упрямство → сильнее компрессия
  comp.knee.value = 12;
  comp.ratio.value = 3.4 + 1.2*Math.abs(s('Yield-Head'));
  comp.attack.value = 0.006;
  comp.release.value = 0.18;

  stereo.connect(comp).connect(master).connect(offline.destination);

  const rendered = await offline.startRendering();
  return rendered;
}

export function playMusic(ctx, audioBuffer){
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  const gain = ctx.createGain();
  gain.gain.value = 0.95;
  src.connect(gain).connect(ctx.destination);
  src.start();
  return { src, gain };
}

// Компактная спектрограмма: массив кадров (Float32Array) длиной bins, не более maxFrames
export function computeSpectrogram(audioBuffer, bins = 64, windowSize = 1024, hopSize = 512, maxFrames = 120){
  const ch = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  const frames = [];
  const N = windowSize;
  const win = new Float32Array(N);
  for (let n=0; n<N; n++) win[n] = hannWindow(n, N);
  const total = Math.floor((ch.length - N) / hopSize) + 1;
  const step = Math.max(1, Math.floor(total / maxFrames));
  for (let fi=0, idx=0; idx < ch.length - N; fi++, idx += hopSize*step){
    const re = new Float32Array(N/2);
    const im = new Float32Array(N/2);
    for (let k=0; k<N/2; k++){
      let sumRe = 0, sumIm = 0;
      for (let n=0; n<N; n++){
        const x = ch[idx+n] * win[n];
        const ph = -2*Math.PI*k*n/N;
        sumRe += x * Math.cos(ph);
        sumIm += x * Math.sin(ph);
      }
      re[k] = sumRe; im[k] = sumIm;
    }
    // magnitudes
    const mags = new Float32Array(N/2);
    let peak = 0;
    for (let k=0;k<N/2;k++){ const m = Math.hypot(re[k], im[k]); mags[k]=m; if (m>peak) peak=m; }
    const norm = peak>0 ? 1/peak : 1;
    for (let k=0;k<mags.length;k++) mags[k]*=norm;
    // compress to bins
    const out = new Float32Array(bins);
    for (let i=0;i<bins;i++){
      const a = Math.floor((i   /bins) * (mags.length));
      const b = Math.floor(((i+1)/bins) * (mags.length));
      let m = 0; for (let k=a;k<b;k++) m = Math.max(m, mags[k]||0);
      out[i]=m;
    }
    frames.push(out);
    if (frames.length >= maxFrames) break;
  }
  return { frames, sr, bins };
}

// ===== Пользовательское аудио (усиленная обработка) =====
export async function decodeUserAudio(file){
  const arrayBuf = await file.arrayBuffer();
  const tmp = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await tmp.decodeAudioData(arrayBuf);
  const targetSr = SAMPLE_RATE;
  const len = Math.floor(decoded.duration * targetSr);
  const offline = new OfflineAudioContext(1, len, targetSr);
  // ресэмпл + микс в моно
  const mono = offline.createBuffer(1, len, targetSr);
  const out = mono.getChannelData(0);
  const ch0 = decoded.getChannelData(0);
  const ch1 = decoded.numberOfChannels>1 ? decoded.getChannelData(1) : null;
  for (let i=0;i<len;i++){
    const t = i/len;
    const srcIdx = Math.min(decoded.length-1, Math.floor(t*decoded.length));
    const s = ch0[srcIdx] * (ch1?0.5:1) + (ch1 ? ch1[srcIdx]*0.5 : 0);
    out[i] = s;
  }
  try{ tmp.close(); }catch{}
  return mono;
}

export async function applyTypeToAudio(inputBuffer, harmonics){
  const sr = inputBuffer.sampleRate;
  const length = inputBuffer.length;
  const offline = new OfflineAudioContext(2, length, sr);

  const src = offline.createBufferSource();
  src.buffer = inputBuffer;

  // агрегированные параметры из гармоник
  const meanAmp = harmonics.reduce((a,h)=>a+Math.abs(h.amp||0),0)/Math.max(1,harmonics.length);
  const brightness = harmonics.reduce((a,h)=>a + (h.freq||0)*Math.abs(h.amp||0), 0) / Math.max(1,harmonics.length);
  const polarity = harmonics.reduce((a,h)=>a + ((h.phase||0)>=0?1:-1)*Math.abs(h.amp||0), 0) / Math.max(1,harmonics.length);

  // многополосная обработка
  const lo = offline.createBiquadFilter(); lo.type='lowshelf'; lo.frequency.value=140; lo.gain.value = 3*meanAmp;
  const hi = offline.createBiquadFilter(); hi.type='highshelf'; hi.frequency.value=6500; hi.gain.value = (brightness>1.2?3:1);
  const tilt = offline.createBiquadFilter(); tilt.type='peaking'; tilt.frequency.value=1200; tilt.Q.value=0.6; tilt.gain.value = polarity*2.2; // позитив/негатив

  // автофильтр (динамика от статика/динамика, упростим через meanAmp)
  const autoFilt = offline.createBiquadFilter(); autoFilt.type='lowpass'; autoFilt.frequency.value=8000;
  const afLFO = offline.createOscillator(); afLFO.type='sine'; afLFO.frequency.value = 0.15 + 0.5*meanAmp;
  const afDepth = offline.createGain(); afDepth.gain.value = 3200 + 2400*meanAmp;
  afLFO.connect(afDepth);
  afDepth.connect(autoFilt.frequency);

  // ритмический гейт (процесс/результат => плотность/акценты)
  const bpm = 96; const beat = 60/bpm; const step = beat/2;
  const gate = offline.createGain(); gate.gain.value = 1.0;
  for (let t=0; t<length/sr; t+=step){
    const on = (t % (beat*4)) < (beat*2.5) ? 0.85 : 0.55; // чуть «качает»
    gate.gain.setValueAtTime(on, t);
    gate.gain.linearRampToValueAtTime(1.0, t+step*0.4);
  }

  // панорама: лёгкая авто-панорама
  const panLFO = offline.createOscillator(); panLFO.type='sine'; panLFO.frequency.value = 0.08 + 0.18*meanAmp;
  const panGain = offline.createGain(); panGain.gain.value = 0.6*meanAmp;
  panLFO.connect(panGain);

  const splitL = offline.createGain(); const splitR = offline.createGain();
  const merger = offline.createChannelMerger(2);
  // LR формула
  const basePan = 0.0;
  const panToLR = (pan)=>({ L: Math.cos((pan + 1)*Math.PI/4), R: Math.sin((pan + 1)*Math.PI/4) });
  const leftMod = offline.createGain(); const rightMod = offline.createGain();
  panGain.connect(leftMod.gain); panGain.connect(rightMod.gain);
  leftMod.gain.value = panToLR(basePan).L; rightMod.gain.value = panToLR(basePan).R;

  // цепочка
  src.connect(lo).connect(tilt).connect(hi).connect(autoFilt).connect(gate);
  gate.connect(splitL).connect(leftMod).connect(merger, 0, 0);
  gate.connect(splitR).connect(rightMod).connect(merger, 0, 1);

  const comp = offline.createDynamicsCompressor();
  comp.threshold.value = -18; comp.knee.value=12; comp.ratio.value=3; comp.attack.value=0.004; comp.release.value=0.22;

  merger.connect(comp).connect(offline.destination);

  src.start(); afLFO.start(); panLFO.start();
  const rendered = await offline.startRendering();
  return rendered;
}

export async function exportProcessedWav(processedBuffer){
  return encodeWAV(processedBuffer);
}
