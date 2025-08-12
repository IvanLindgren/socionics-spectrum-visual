// js/main.js
import { TRAITS } from '../data.js';
import { exportWAV, analyzeAudioBuffer, renderMusicBuffer } from './audio.js';
import { computeSpectrogram, decodeUserAudio, applyTypeToAudio, exportProcessedWav } from './audio.js';

const els = {
  name: document.getElementById('trait-name'),
  desc: document.getElementById('trait-description'),
  neg: document.getElementById('neg-label'),
  pos: document.getElementById('pos-label'),
  slider: document.getElementById('trait-slider'),
  bubble: document.getElementById('slider-bubble'),
  valueChip: document.getElementById('value-chip'),
  valueSide: document.getElementById('value-chip-side'),
  valuePct: document.getElementById('value-chip-pct'),
  progressFill: document.getElementById('progress-fill'),
  progressText: document.getElementById('progress-text'),
  prev: document.getElementById('prev-btn'),
  next: document.getElementById('next-btn'),
  fallbackBtn: document.getElementById('fallback-quiz') ? document.getElementById('fallback-btn') : document.getElementById('fallback-btn'),
  quiz: document.getElementById('fallback-quiz'),
  quizList: document.getElementById('quiz-list'),
  quizApply: document.getElementById('quiz-apply'),
  quizClear: document.getElementById('quiz-clear'),
  quizClose: document.getElementById('quiz-close'),
  helpBtn: document.getElementById('help-btn'),
  helpModal: document.getElementById('help-modal'),
  helpClose: document.getElementById('help-close'),
  helpOk: document.getElementById('help-ok'),
  guideBtn: document.getElementById('guide-btn'),
  guideModal: document.getElementById('guide-modal'),
  guideContent: document.getElementById('guide-content'),
  guidePrev: document.getElementById('guide-prev'),
  guideNext: document.getElementById('guide-next'),
  guideSkip: document.getElementById('guide-skip'),
  legend: document.getElementById('legend'),
  wavePlot: document.getElementById('wave-plot'),
  ridgePlot: document.getElementById('ridge-plot'),
  specStrip: document.getElementById('spec-strip'),
  musicBtn: document.getElementById('music-btn'),
  stopBtn: document.getElementById('stop-btn'),
  exportBtn: document.getElementById('export-btn'),
  mRms: document.getElementById('m-rms'),
  mPeak: document.getElementById('m-peak'),
  mCrest: document.getElementById('m-crest'),
  mCentroid: document.getElementById('m-centroid'),
  spectrum: document.getElementById('spectrum'),
  userAudio: document.getElementById('user-audio'),
  applyToAudio: document.getElementById('apply-to-audio'),
  exportProcessed: document.getElementById('export-processed'),
  eqLow: document.getElementById('eq-low'),
  eqMid: document.getElementById('eq-mid'),
  eqHigh: document.getElementById('eq-high'),
  deltaToggle: document.getElementById('delta-toggle'),
  tooltip: document.getElementById('trait-tooltip'),
  inspectSignal: document.getElementById('inspect-signal'),
  inspectMusic: document.getElementById('inspect-music'),
  eqVisual: document.getElementById('eq-visual'),
};

let current = 0;
const values = new Map(TRAITS.map(t => [t.key, 0]));
let lastProcessed = null;
let lastRenderedMusic = null; // Буфер последней сгенерированной музыки для экспорта

let audioCtx = null;
let playing = null; // {src,gain}
let lastHarmonics = null; // для тултипа/дельты
let uiStage = 1; // 1: подбор признаков; 2: музыка и графики

let rafId = null;
let analyser = null; let analyserBuf = null;

function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }

// Центральный визуальный эквалайзер
let eqVisCtx = null; let eqVisW = 0; let eqVisH = 0;
function drawEqVisualFrame(){
  const canvas = els.eqVisual; // Используем els.eqVisual
  if (!canvas || !analyser) return;
  if (!eqVisCtx) eqVisCtx = canvas.getContext('2d');
  if (eqVisW === 0 || eqVisH === 0) { // Обновляем размеры, если они изменились или не инициализированы
    const rect = canvas.getBoundingClientRect();
    eqVisW = Math.floor(rect.width * window.devicePixelRatio); 
    eqVisH = Math.floor(rect.height * window.devicePixelRatio);
    canvas.width = eqVisW;
    canvas.height = eqVisH;
  }
  const ctx = eqVisCtx;
  const W = eqVisW, H = eqVisH;

  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = '#0e1a1f'; ctx.fillRect(0,0,W,H);

  // спектр-полосы
  analyser.getByteFrequencyData(analyserBuf); // Обновляем данные анализатора
  const data = analyserBuf; if (!data) return;
  const n = data.length; const bars = 96; // сглаживаем до 96 столбцов
  for (let i=0;i<bars;i++){
    const a = Math.floor(i   * n / bars);
    const b = Math.floor((i+1) * n / bars);
    let m=0; for (let k=a;k<b;k++) m = Math.max(m, data[k]);
    const v = m/255;
    const x = i * (W/bars);
    const h = Math.max(2, (H*0.8)*v);
    const y = H - h - 4;
    const hue = 160 + 150*v;
    ctx.fillStyle = `hsl(${hue}, 85%, ${30+v*40}%)`;
    ctx.fillRect(x+1, y, (W/bars)-2, h);
  }

  // октавные толстые столбцы поверх
  ctx.globalAlpha = 0.25;
  const octs = 10; const step = Math.floor(bars/octs);
  for (let i=0;i<octs;i++){
    const idx = i*step;
    const x = idx * (W/bars);
    ctx.fillStyle = '#66ffe6';
    ctx.fillRect(x, 0, 2, H);
  }
  ctx.globalAlpha = 1;
}

function startLiveMeters(ctx, nodeAfterEQ){
  analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.75;
  nodeAfterEQ.connect(analyser);
  analyserBuf = new Uint8Array(analyser.frequencyBinCount);
  const meterLow = document.getElementById('meter-low');
  const meterMid = document.getElementById('meter-mid');
  const meterHigh = document.getElementById('meter-high');

  const loop = ()=>{
    // Обновление метров НЧ/СЧ/ВЧ
    analyser.getByteFrequencyData(analyserBuf);
    const n = analyserBuf.length;
    const lowBand = analyserBuf.slice(0, Math.floor(n*0.2));
    const midBand = analyserBuf.slice(Math.floor(n*0.2), Math.floor(n*0.6));
    const highBand = analyserBuf.slice(Math.floor(n*0.6));
    const avg = (arr)=> arr.reduce((a,b)=>a+b,0)/Math.max(1,arr.length);
    const l = avg(lowBand)/255, m = avg(midBand)/255, h = avg(highBand)/255;
    if (meterLow) meterLow.style.height = `${Math.round(10 * (0.2 + 0.8*l))}px`;
    if (meterMid) meterMid.style.height = `${Math.round(10 * (0.2 + 0.8*m))}px`;
    if (meterHigh) meterHigh.style.height = `${Math.round(10 * (0.2 + 0.8*h))}px`;

    drawEqVisualFrame();
    rafId = requestAnimationFrame(loop);
  };
  if (rafId) cancelAnimationFrame(rafId); rafId = requestAnimationFrame(loop);
}

function stopLiveMeters(){ 
  if (rafId) cancelAnimationFrame(rafId); rafId=null; 
  if (analyser && analyser.disconnect) analyser.disconnect(); // Отключаем анализатор
  analyser=null; 
  analyserBuf=null;
  // Очищаем EQ визуализатор и метры
  if (eqVisCtx) {
    eqVisCtx.clearRect(0,0,eqVisW,eqVisH);
    eqVisCtx.fillStyle = '#0e1a1f'; eqVisCtx.fillRect(0,0,eqVisW,eqVisH);
  }
  const meterLow = document.getElementById('meter-low');
  const meterMid = document.getElementById('meter-mid');
  const meterHigh = document.getElementById('meter-high');
  if (meterLow) meterLow.style.height = `4px`;
  if (meterMid) meterMid.style.height = `4px`;
  if (meterHigh) meterHigh.style.height = `4px`;
}

// Восстановим updateAnalysisUI
async function updateAnalysisUI(audioBuffer){
  try{
    const a = analyzeAudioBuffer(audioBuffer);
    els.mRms.textContent = a.rms.toFixed(3);
    els.mPeak.textContent = a.peak.toFixed(3);
    els.mCrest.textContent = a.crest.toFixed(2);
    els.mCentroid.textContent = `${Math.round(a.centroidHz)} Hz`;
    els.spectrum.innerHTML = '';
    for (let i=0;i<a.spectrum.length;i++){
      const v = a.spectrum[i];
      const bar = document.createElement('div');
      bar.style.height = `${Math.max(4, Math.round(52 * v))}px`;
      els.spectrum.appendChild(bar);
    }
  }catch{}
}

function showMusicPanels(show){
  document.querySelectorAll('.waves2d, .ridge2d, .specstrip2d, .eq-row, .analysis, .upload-row, .eq-visual')
    .forEach(el => el.classList.toggle('hidden', !show));
  // Управление кнопками: на первом этапе только musicBtn активна, на втором - все
  els.musicBtn.classList.toggle('primary', !show);
  els.musicBtn.classList.toggle('ghost', show);
  els.stopBtn.classList.toggle('hidden', !show);
  els.exportBtn.classList.toggle('hidden', !show);
  els.musicBtn.textContent = show ? '♪ Обновить музыку' : '♪ Сгенерировать музыку';

  document.body.classList.toggle('stage-setup', !show);
  document.body.classList.toggle('stage-music', show);
}

function updateProgress(){
  const pct = ((current+1)/TRAITS.length)*100;
  els.progressFill.style.width = `${pct}%`;
  els.progressText.textContent = `${current+1} / ${TRAITS.length}`;
}

function setSliderGradient(val){
  const mid = ((val+1)/2)*100;
  els.slider.style.background = `linear-gradient(90deg,#ff6a00 0%,#ff6a00 ${mid}%,#00fff0 ${mid}%,#00fff0 100%)`;
}

function updateBubble(){
  const val = parseFloat(els.slider.value);
  const pct = Math.round(Math.abs(val)*100);
  els.bubble.textContent = `${pct}%`;
  const rect = els.slider.getBoundingClientRect();
  const x = ((val+1)/2) * rect.width;
  els.bubble.style.left = `${x}px`;
  els.valuePct.textContent = `${pct}%`;
  const trait = TRAITS[current];
  els.valueSide.textContent = val < 0 ? trait.poles[0] : val>0 ? trait.poles[1] : "—";
}

function harmonicsFromValues(){
  return TRAITS.map((tr, idx) => ({
    name: tr.name,
    colorIndex: idx,
    active: idx===current,
    key: tr.key,
    score: values.get(tr.key) || 0,
    ...tr.toHarmonic(values.get(tr.key) || 0)
  }));
}

function fillInspect(){
  const t = TRAITS[current];
  const v = values.get(t.key) || 0;
  // в сигнал: A=|v|, f=base±, φ по полюсу
  const A = Math.round(Math.abs(v)*100);
  const pol = v>0 ? t.poles[1] : v<0 ? t.poles[0] : 'центр';
  els.inspectSignal.textContent = `амплитуда ${A}%, полюс: ${pol}`;
  els.inspectMusic.textContent = t.musicHint || '—';
}

function drawLegend(harmonics){
  const container = els.legend; container.innerHTML = '';
  harmonics.forEach((h, i) => {
    const pct = Math.round(Math.abs(h.amp||0)*100);
    const hue = (i*27)%360;
    const hint = TRAITS[i].musicHint || '';
    const item = document.createElement('div');
    item.className='item' + (i===current?' active':'');
    item.dataset.index = String(i);
    item.title = hint;
    item.innerHTML = `
      <span class="dot" style="color:hsl(${hue},100%,65%)"></span>
      <div style="min-width:14px">${String(pct).padStart(2,'0')}%</div>
      <div class="bar" title="${h.name}">
        <span style="width:${pct}%;"></span>
      </div>
    `;
    item.addEventListener('click', () => goto(i));
    item.addEventListener('mouseenter', (e)=> showTooltip(e.currentTarget, i));
    item.addEventListener('mouseleave', hideTooltip);
    const note = document.createElement('div');
    note.style.cssText = 'grid-column: 1 / -1; font-size:12px; color:#8fbfc7; opacity:.9; margin:-2px 0 4px';
    note.textContent = hint;
    container.appendChild(item);
    if (hint) container.appendChild(note);
  });
}

function showTooltip(targetEl, idx){
  const rect = targetEl.getBoundingClientRect();
  const t = TRAITS[idx];
  const val = values.get(t.key) || 0;
  const sign = val===0? 'центр' : (val>0? t.poles[1] : t.poles[0]);
  const h = lastHarmonics ? lastHarmonics[idx] : {amp:0,freq:1,phase:0};
  const ampPct = Math.round(Math.abs(h.amp||0)*100);
  const phase = (h.phase||0);
  const phaseText = phase===0? 'φ = 0' : (phase>0? 'φ > 0' : 'φ < 0');
  els.tooltip.innerHTML = `<div style="font-weight:600; margin-bottom:4px">${t.name}</div>
    <div>Полюс: ${sign}</div>
    <div>Вклад: ${ampPct}%</div>
    <div>Фаза: ${phaseText}</div>
    <div style="margin-top:4px; color:#9ed6db">${t.musicHint||''}</div>`;
  els.tooltip.style.left = `${Math.round(rect.left + window.scrollX + rect.width + 8)}px`;
  els.tooltip.style.top = `${Math.round(rect.top + window.scrollY)}px`;
  els.tooltip.classList.remove('hidden');
}
function hideTooltip(){ els.tooltip.classList.add('hidden'); }

function render2DWaves(harmonics){
  const canvas = els.wavePlot;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const DPR = Math.min(2, window.devicePixelRatio||1);
  const Wcss = canvas.clientWidth || 360; const Hcss = canvas.height;
  if (canvas.width !== Math.floor(Wcss*DPR)){
    canvas.width = Math.floor(Wcss*DPR); canvas.height = Math.floor(Hcss*DPR);
  }
  const W = canvas.width; const H = canvas.height;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = '#0e1a1f'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle = '#12333a'; ctx.lineWidth = 1; ctx.beginPath();
  ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();

  const S = 256;
  const sum = new Float32Array(S);
  const act = harmonics[current];
  for (let i=0;i<S;i++){
    const u = i/(S-1);
    let s=0; for (const h of harmonics){ s += (h.amp||0)*Math.sin(2*Math.PI*((h.freq||1)*u) + (h.phase||0)); }
    sum[i]=s;
  }
  let peak = 0; for (let i=0;i<S;i++) peak = Math.max(peak, Math.abs(sum[i]));
  const k = peak>0 ? (H*0.35)/peak : 1;

  // Δ-вклад: сумма с активной гармоникой и без неё
  if (els.deltaToggle && els.deltaToggle.checked){
    const sumNoAct = new Float32Array(S);
    for (let i=0;i<S;i++){
      const u = i/(S-1);
      let s=0; for (let j=0;j<harmonics.length;j++){ if (j===current) continue; const hh = harmonics[j]; s += (hh.amp||0)*Math.sin(2*Math.PI*((hh.freq||1)*u) + (hh.phase||0)); }
      sumNoAct[i]=s;
    }
    ctx.strokeStyle = 'rgba(255,106,0,.9)'; ctx.lineWidth = 2; ctx.beginPath();
    for (let i=0;i<S;i++){
      const u = i/(S-1);
      const y = H/2 - (sum[i]-sumNoAct[i]) * k;
      const x = u * (W-1);
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }

  // активная
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2; ctx.beginPath();
  for (let i=0;i<S;i++){
    const u = i/(S-1);
    const y = H/2 - (act.amp||0)*Math.sin(2*Math.PI*((act.freq||1)*u) + (act.phase||0)) * (H*0.35);
    const x = u * (W-1);
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();

  // сумма
  ctx.strokeStyle = 'rgba(0,255,240,.85)'; ctx.lineWidth = 2; ctx.beginPath();
  for (let i=0;i<S;i++){
    const u = i/(S-1);
    const y = H/2 - sum[i] * k;
    const x = u * (W-1);
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();
}

function renderRidgePlot(harmonics){
  const canvas = els.ridgePlot; if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const DPR = Math.min(2, window.devicePixelRatio||1);
  const Wcss = canvas.clientWidth || 360; const Hcss = canvas.height;
  if (canvas.width !== Math.floor(Wcss*DPR)){
    canvas.width = Math.floor(Wcss*DPR); canvas.height = Math.floor(Hcss*DPR);
  }
  const W = canvas.width; const H = canvas.height;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = '#0e1a1f'; ctx.fillRect(0,0,W,H);

  const rows = TRAITS.length + 1; // sum + traits
  const S = 192;
  const rowH = H / rows;

  function drawRow(yBase, wave, color){
    let peak = 0; for (let i=0;i<wave.length;i++) peak = Math.max(peak, Math.abs(wave[i]));
    const k = peak>0 ? (rowH*0.38)/peak : 1;
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
    for (let i=0;i<wave.length;i++){
      const u = i/(wave.length-1);
      const y = yBase - wave[i]*k;
      const x = u * (W-16) + 8;
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = color; ctx.lineTo(W-8, yBase); ctx.lineTo(8, yBase); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // sum
  const sum = new Float32Array(S);
  for (let i=0;i<S;i++){
    const u = i/(S-1);
    let s=0; for (const h of harmonics){ s += (h.amp||0)*Math.sin(2*Math.PI*((h.freq||1)*u) + (h.phase||0)); }
    sum[i] = s;
  }
  drawRow(rowH*0.9, sum, 'hsl(175,95%,65%)');

  // traits
  for (let t=0;t<TRAITS.length;t++){
    const h = harmonics[t];
    const wave = new Float32Array(S);
    for (let i=0;i<S;i++){
      const u = i/(S-1);
      wave[i] = (h.amp||0)*Math.sin(2*Math.PI*((h.freq||1)*u) + (h.phase||0));
    }
    const hue = (t*27)%360;
    drawRow(rowH*(t+1.9), wave, `hsl(${hue},95%,65%)`);
  }
}

function renderSpecStrip(frames){
  const canvas = els.specStrip; if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const DPR = Math.min(2, window.devicePixelRatio||1);
  const Wcss = canvas.clientWidth || 360; const Hcss = canvas.height;
  if (canvas.width !== Math.floor(Wcss*DPR)){
    canvas.width = Math.floor(Wcss*DPR); canvas.height = Math.floor(Hcss*DPR);
  }
  const W = canvas.width; const H = canvas.height;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = '#0e1a1f'; ctx.fillRect(0,0,W,H);

  if (!frames || !frames.length) return;
  const cols = Math.min(frames.length, Math.floor(W));
  for (let x=0;x<cols;x++){
    const f = frames[x];
    for (let y=0;y<H;y++){
      const i = Math.floor((1 - y/H) * (f.length-1));
      const v = Math.max(0, Math.min(1, f[i]));
      const hue = 180 + 120*v; const light = 25 + v*45;
      ctx.fillStyle = `hsl(${hue},85%,${light}%)`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function renderAllPlots(harmonics, specFrames){
  lastHarmonics = harmonics;
  drawLegend(harmonics);
  if (uiStage===2){
    render2DWaves(harmonics);
    renderRidgePlot(harmonics);
    if (specFrames) renderSpecStrip(specFrames);
  }
}

function goto(idx){ current = clamp(idx, 0, TRAITS.length-1); renderTrait(); }

function renderTrait(){
  const t = TRAITS[current];
  els.name.textContent = t.name;
  els.desc.textContent = t.description;
  els.neg.textContent = t.poles[0];
  els.pos.textContent = t.poles[1];
  const val = values.get(t.key) ?? 0;
  els.slider.value = val;
  setSliderGradient(val);
  updateBubble();
  updateProgress();

  fillInspect();
  const harmonics = harmonicsFromValues();
  renderAllPlots(harmonics);
}

/* Slider */
els.slider.addEventListener('input', () => { const v = parseFloat(els.slider.value); values.set(TRAITS[current].key, v); setSliderGradient(v); updateBubble(); fillInspect(); if (uiStage===2){ const hs = harmonicsFromValues(); renderAllPlots(hs); } });

/* Nav */
els.prev.addEventListener('click', () => goto(current-1));
els.next.addEventListener('click', () => goto(current+1));

// Навигация стрелками
window.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') goto(current-1); else if (e.key === 'ArrowRight') goto(current+1); });

// Двойной клик по чипу — сброс признака в 0
els.valueChip.addEventListener('dblclick', () => { values.set(TRAITS[current].key, 0); renderTrait(); });

/* Mini-quiz */
els.fallbackBtn.addEventListener('click', () => {
  if (!els.quiz || !els.quizList) {
    alert('Мини-опрос временно отключён в этой версии.');
    return;
  }
  const t = TRAITS[current];
  els.quizList.innerHTML = "";
  const qs = (t.questions && t.questions.length ? t.questions : Array.from({length:10}, (_,i)=>`Вопрос ${i+1} для «${t.name}»`)).slice(0,10);
  qs.forEach((q, i) => {
    const li = document.createElement('li'); li.className = 'quiz-item';
    li.innerHTML = `
      <div class="q-text">${q}</div>
      <div class="q-scale">
        <label><input type="radio" name="q${i}" value="-1"> Совсем не согласен</label>
        <label><input type="radio" name="q${i}" value="-0.5"> Скорее не согласен</label>
        <label><input type="radio" name="q${i}" value="0"> Нейтрально</label>
        <label><input type="radio" name="q${i}" value="0.5"> Скорее согласен</label>
        <label><input type="radio" name="q${i}" value="1"> Полностью согласен</label>
      </div>`;
    els.quizList.appendChild(li);
  });
  els.quiz.classList.remove('hidden');
});
els.quizApply?.addEventListener('click', () => {
  if (!els.quizList || !els.quiz) return;
  const inputs = els.quizList.querySelectorAll('input[type=radio]:checked');
  if (!inputs.length){ els.quiz.classList.add('hidden'); return; }
  let sum = 0; inputs.forEach(i => sum += parseFloat(i.value));
  const avg = sum / inputs.length;         // [-1..1]
  values.set(TRAITS[current].key, clamp(avg, -1, 1));
  els.quiz.classList.add('hidden');
  renderTrait();
});
els.quizClear?.addEventListener('click', () => { els.quizList?.querySelectorAll('input[type=radio]')?.forEach(i => i.checked=false); });
els.quizClose?.addEventListener('click', () => els.quiz?.classList.add('hidden'));

/* Help modal */
els.helpBtn.addEventListener('click', () => els.helpModal.showModal());
els.helpClose.addEventListener('click', () => els.helpModal.close());
els.helpOk.addEventListener('click', () => els.helpModal.close());

/* Guide (учебник) */
const steps = [
  { title: 'Признаки и гармоники', body: 'Каждый признак порождает гармонику. Сумма гармоник — ваш сигнальный профиль.'},
  { title: 'Музыка из профиля', body: 'Сильные признаки становятся ведущими голосами, масштабируются в ноты, ритм и панораму.'},
  { title: 'Визуализация', body: 'Осциллограмма — сумма, ридж‑плот — вклад каждого признака, снизу — компактная спектролента.'},
  { title: 'Эквалайзер', body: 'Регулируйте НЧ/СЧ/ВЧ после генерации музыки, чтобы подстроить общий тонбаланс.'},
  { title: 'Обработка аудио', body: 'Загрузите свой файл и «окрасьте» его под тип: EQ, гейт, автофильтр, панорама.'}
];
let stepIdx = 0;
function renderGuide(){
  els.guideContent.innerHTML = '';
  const s = steps[stepIdx];
  const div = document.createElement('div');
  div.className = 'step active';
  div.innerHTML = `<p><strong>${s.title}</strong></p><p>${s.body}</p>`;
  els.guideContent.appendChild(div);
}
els.guideBtn.addEventListener('click', ()=>{ stepIdx=0; renderGuide(); els.guideModal.showModal(); });
els.guidePrev.addEventListener('click', ()=>{ stepIdx = Math.max(0, stepIdx-1); renderGuide(); });
els.guideNext.addEventListener('click', ()=>{ stepIdx = Math.min(steps.length-1, stepIdx+1); renderGuide(); if (stepIdx===steps.length-1) els.guideNext.textContent='Готово'; else els.guideNext.textContent='Далее'; });
els.guideSkip.addEventListener('click', ()=>{ els.guideModal.close(); });

/* Audio & EQ */
let eqNodes = null; let lastRender = null;
async function ensureCtx(){ if (!audioCtx){ audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 }); } if (audioCtx.state === 'suspended') await audioCtx.resume(); return audioCtx; }
function attachEQ(ctx, destination){ const lows = ctx.createBiquadFilter(); lows.type='lowshelf'; lows.frequency.value=150; lows.gain.value=0; const mids = ctx.createBiquadFilter(); mids.type='peaking'; mids.frequency.value=1000; mids.Q.value=0.7; mids.gain.value=0; const highs = ctx.createBiquadFilter(); highs.type='highshelf'; highs.frequency.value=6000; highs.gain.value=0; const preGain = ctx.createGain(); preGain.gain.value=1; preGain.connect(lows).connect(mids).connect(highs).connect(destination); eqNodes = { lows, mids, highs, preGain }; return eqNodes; }
function updateEQ(){ if (!eqNodes) return; eqNodes.lows.gain.value = parseFloat(els.eqLow.value); eqNodes.mids.gain.value = parseFloat(els.eqMid.value); eqNodes.highs.gain.value = parseFloat(els.eqHigh.value); }
els.eqLow?.addEventListener('input', updateEQ); els.eqMid?.addEventListener('input', updateEQ); els.eqHigh?.addEventListener('input', updateEQ);
async function playMusicWithEQ(ctx, audioBuffer){
  const src = ctx.createBufferSource(); src.buffer = audioBuffer;
  const master = ctx.createGain(); master.gain.value = 0.95;
  const eq = attachEQ(ctx, master);
  src.connect(eq.preGain);
  master.connect(ctx.destination);
  src.start();
  startLiveMeters(ctx, master);
  return { src, gain: master };
}

// Кнопки музыки
els.musicBtn.addEventListener('click', async () => {
  if (playing) { // Если музыка играет, останавливаем и перегенерируем
    stopLiveMeters();
    try { playing.src.stop(); } catch(e) {} // Останавливаем старый источник
    playing = null; // Сбрасываем playing
  }

  // Визуальный отклик на нажатие (можно добавить спиннер)
  els.musicBtn.disabled = true; // Отключаем кнопку на время генерации
  els.musicBtn.textContent = 'Генерация...';

  try{
    uiStage = 2; showMusicPanels(true);
    const ctx = await ensureCtx();
    const hs = harmonicsFromValues();
    const rendered = await renderMusicBuffer(hs, 16, ctx.sampleRate);
    lastRenderedMusic = rendered; // Сохраняем сгенерированный буфер
    
    playing = await playMusicWithEQ(ctx, rendered);
    const spec = computeSpectrogram(rendered, 64, 1024, 512, 256);
    renderAllPlots(hs, spec.frames);
    updateAnalysisUI(rendered);

  }catch(err){ alert('Не удалось сгенерировать музыку: '+err.message); console.error(err); }
  finally {
    els.musicBtn.disabled = false; // Включаем кнопку обратно
    els.musicBtn.textContent = '♪ Обновить музыку';
  }
});

els.stopBtn.addEventListener('click', () => { if (playing){ try{ playing.src.stop(); }catch{} playing=null; stopLiveMeters(); } });

els.exportBtn.addEventListener('click', async () => {
  try{
    if (!lastRenderedMusic) { alert('Сначала сгенерируйте музыку.'); return; }
    const blob = await exportProcessedWav(lastRenderedMusic);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'socionics-music.wav';
    document.body.appendChild(a); a.click(); requestAnimationFrame(()=>{ URL.revokeObjectURL(url); a.remove(); });
  }catch(err){ alert('Экспорт не удался: '+err.message); console.error(err); }
});

// Пользовательское аудио (появится только после генерации)
let userBuffer = null; els.userAudio?.addEventListener('change', async (e)=>{ const f=e.target.files && e.target.files[0]; if(!f) return; try{ userBuffer = await decodeUserAudio(f); alert('Аудио загружено. Нажмите «Применить тип к аудио».'); }catch(err){ alert('Не удалось загрузить аудио: '+err.message); } });
els.applyToAudio?.addEventListener('click', async ()=>{ 
  if (!userBuffer){ alert('Сначала загрузите аудио файл.'); return; }

  if (playing) { // Останавливаем текущую музыку перед новой генерацией/обработкой
    stopLiveMeters();
    try { playing.src.stop(); } catch(e) {} 
    playing = null;
  }

  els.applyToAudio.disabled = true;
  els.applyToAudio.textContent = 'Обработка...';

  try{
    const ctx = await ensureCtx();
    const hs = harmonicsFromValues();
    const processed = await applyTypeToAudio(userBuffer, hs);
    lastProcessed=processed;
    lastRenderedMusic = processed; // Сохраняем обработанный буфер для экспорта

    playing = await playMusicWithEQ(ctx, processed);
    const spec = computeSpectrogram(processed, 64, 1024, 512, 256);
    renderSpecStrip(spec.frames); // Обновляем спектроленту
    updateAnalysisUI(processed); // Обновляем метрики
  }catch(err){ alert('Ошибка обработки аудио: '+err.message); console.error(err); }
  finally {
    els.applyToAudio.disabled = false;
    els.applyToAudio.textContent = 'Применить тип к аудио';
  }
});

els.exportProcessed?.addEventListener('click', async ()=>{ 
  try{
    if (!lastProcessed){ alert('Нет обработанного аудио для экспорта.'); return; }
    const blob = await exportWAV(lastProcessed, lastProcessed.duration, lastProcessed.sampleRate); // Исправлено
    const url = URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download='processed-by-socionics.wav'; document.body.appendChild(a); a.click(); requestAnimationFrame(()=>{ URL.revokeObjectURL(url); a.remove(); });
  }catch(err){ alert('Экспорт не удался: '+err.message); console.error(err); }
});

function serializeState(){
  // в URL пишем баллы признаков в виде base64 JSON
  const obj = {};
  for (const t of TRAITS){ obj[t.key] = values.get(t.key) || 0; }
  const json = JSON.stringify(obj);
  return btoa(unescape(encodeURIComponent(json)));
}
function deserializeState(b64){
  try{
    const json = decodeURIComponent(escape(atob(b64)));
    const obj = JSON.parse(json);
    for (const t of TRAITS){ if (typeof obj[t.key] === 'number' && isFinite(obj[t.key])) values.set(t.key, Math.max(-1, Math.min(1, obj[t.key]))); }
    renderTrait();
    return true;
  }catch{ return false; }
}

// кнопка Поделиться
const shareBtn = document.getElementById('share-btn');
shareBtn?.addEventListener('click', async ()=>{
  const token = serializeState();
  const url = `${location.origin}${location.pathname}?share=${encodeURIComponent(token)}`;
  try{ await navigator.clipboard.writeText(url); alert('Ссылка скопирована в буфер обмена'); }
  catch{ prompt('Скопируйте ссылку:', url); }
});

// парсинг входящей ссылки
(function initShare(){
  const params = new URLSearchParams(location.search);
  const token = params.get('share');
  if (token){
    const ok = deserializeState(token);
    if (ok){
      uiStage = 2; showMusicPanels(true);
      // сразу сгенерируем музыку для просмотра результата
      els.musicBtn.click();
    }
  }
})();

/* init */
showMusicPanels(false); // этап 1 — без графиков/eq/аналитики
renderTrait();
// автопоказ учебника при загрузке
setTimeout(()=>{ if (els.guideModal && els.guideContent){ stepIdx = 0; renderGuide(); try{ els.guideModal.showModal(); }catch{} } }, 0);

// Обновление EQ визуализатора при изменении размеров окна
window.addEventListener('resize', () => {
  if (uiStage === 2 && els.eqVisual) {
    eqVisW = 0; eqVisH = 0; // Сброс размеров для пересчёта
    drawEqVisualFrame();
  }
});
