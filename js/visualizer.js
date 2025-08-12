// js/visualizer.js
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js?module';

export class Visualizer {
  constructor(canvas, { onLegend } = {}){
    this.canvas = canvas;
    this.onLegend = onLegend || (()=>{});

    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 500;
    this.camera = new THREE.PerspectiveCamera(45, w/h, 0.1, 100);
    this.camera.position.set(0.2, 1.25, 3.4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 8;
    this.controls.maxPolarAngle = Math.PI * 0.9;

    const amb = new THREE.AmbientLight(0x66ffff, 0.45);
    const dir = new THREE.DirectionalLight(0x99ffff, 0.65);
    dir.position.set(2.2,3.2,2.2);
    this.scene.add(amb, dir);

    const grid = new THREE.GridHelper(7, 28, 0x12343b, 0x0a1a1a);
    grid.material.opacity = 0.25; grid.material.transparent = true;
    this.scene.add(grid);

    this.sumLine = this._makeNeonLine(0x00fff0, .95, .25);
    this.activeLine = this._makeNeonLine(0xffffff, .95, .25);
    this.scene.add(this.sumLine.group, this.activeLine.group);

    // подписи (спрайты) для каждого признака
    this.labelsGroup = new THREE.Group();
    this.scene.add(this.labelsGroup);

    // спектрограмма (водопад)
    this.spectroCanvas = document.createElement('canvas');
    this.spectroCanvas.width = 256; // X = время
    this.spectroCanvas.height = 128; // Y = частота
    this.spectroCtx = this.spectroCanvas.getContext('2d');
    this.spectroTex = new THREE.CanvasTexture(this.spectroCanvas);
    this.spectroTex.minFilter = THREE.LinearFilter; this.spectroTex.magFilter = THREE.LinearFilter;

    const planeGeom = new THREE.PlaneGeometry(6.4, 1.8);
    const planeMat = new THREE.MeshBasicMaterial({ map: this.spectroTex, transparent:true, opacity:0.95, side: THREE.DoubleSide });
    this.spectroPlane = new THREE.Mesh(planeGeom, planeMat);
    this.spectroPlane.position.set(0, 0.75, -0.2);
    this.scene.add(this.spectroPlane);

    // оси (16 столбцов)
    this.axesGroup = new THREE.Group();
    this.scene.add(this.axesGroup);
    this._buildAxes(16);

    this.harmonics = [];
    this.time = 0;

    this._resize();
    window.addEventListener('resize', ()=>this._resize());
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  _makeNeonLine(colorHex, core=0.95, glow=0.22){
    const group = new THREE.Group();
    const geom = new THREE.BufferGeometry();
    const matCore = new THREE.LineBasicMaterial({ color: colorHex, transparent:true, opacity: core });
    const line = new THREE.Line(geom, matCore);
    const matGlow = new THREE.LineBasicMaterial({
      color: colorHex, transparent:true, opacity: glow, blending: THREE.AdditiveBlending, depthWrite:false
    });
    const glowLine = new THREE.Line(geom.clone(), matGlow);
    glowLine.scale.set(1.015, 1.03, 1.015);
    group.add(line, glowLine);
    return { group, line, glow: glowLine, geom, matCore, matGlow };
  }

  _resize(){
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w/h;
    this.camera.updateProjectionMatrix();
  }

  _textSprite(text, color){
    const pad = 8;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = '14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial';
    const textW = Math.ceil(ctx.measureText(text).width);
    canvas.width = textW + pad*2;
    canvas.height = 28;

    // bg
    ctx.fillStyle = 'rgba(9,17,22,0.75)';
    ctx.strokeStyle = '#103039';
    ctx.lineWidth = 2;
    ctx.roundRect(1,1,canvas.width-2,canvas.height-2,6);
    ctx.fill(); ctx.stroke();

    // dot
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(10, canvas.height/2, 4, 0, Math.PI*2); ctx.fill();

    // text
    ctx.fillStyle = '#bfeaf0';
    ctx.font = '13px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.fillText(text, 20, 18);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite:false });
    const sprite = new THREE.Sprite(mat);
    const scale = 0.008; // мировая шкала
    sprite.scale.set(canvas.width*scale, canvas.height*scale, 1);
    return sprite;
  }

  _updateLabels(){
    // очистить
    while (this.labelsGroup.children.length) this.labelsGroup.remove(this.labelsGroup.children[0]);
    // расставить подписи по амплитуде
    const baseX = -3.2, stepX = 6.4 / Math.max(1, this.harmonics.length-1);
    this.harmonics.forEach((h, i)=>{
      const hue = (h.colorIndex*27) % 360;
      const color = `hsl(${hue}, 100%, 65%)`;
      const pct = Math.round((Math.abs(h.amp||0))*100);
      const txt = `${h.name || '—'} • ${pct}%`;
      const sp = this._textSprite(txt, color);
      const x = baseX + i*stepX;
      const y = (h.amp || 0) * 0.55 + 0.15;
      const z = -0.9 - 0.15*Math.sin(i*0.7);
      sp.position.set(x,y,z);
      sp.renderOrder = 10;
      this.labelsGroup.add(sp);
    });
  }

  _buildAxes(n){
    // равномерно расставим 16 столбцов по дуге
    while (this.axesGroup.children.length) this.axesGroup.remove(this.axesGroup.children[0]);
    const radius = 2.6;
    for (let i=0;i<n;i++){
      const t = (i/(n))*Math.PI*1.2 + Math.PI*0.2; // дуга спереди
      const x = radius*Math.cos(t);
      const z = radius*Math.sin(t) - 0.6;
      const geom = new THREE.CylinderGeometry(0.05, 0.05, 0.001, 12);
      const mat = new THREE.MeshStandardMaterial({ color: 0x0bbfbb, emissive: 0x08222a, metalness: 0.2, roughness: 0.35 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(x, 0.05, z);
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.userData.baseY = mesh.position.y;
      this.axesGroup.add(mesh);
    }
  }

  setAxes(values){
    // values: массив длиной = числу столбцов, значения [-1..1]
    const n = Math.min(values.length, this.axesGroup.children.length);
    for (let i=0;i<n;i++){
      const v = values[i] || 0;
      const h = Math.max(0.02, Math.abs(v)*1.4);
      const mesh = this.axesGroup.children[i];
      const geom = mesh.geometry;
      geom.dispose();
      mesh.geometry = new THREE.CylinderGeometry(0.06, 0.06, h, 16);
      mesh.position.y = h/2;
      const hue = (i*27)%360;
      const sat = 80;
      const light = 30 + Math.min(50, Math.abs(v)*50);
      mesh.material.color = new THREE.Color(`hsl(${hue}, ${sat}%, ${light}%)`);
      mesh.material.emissive = new THREE.Color(`hsl(${hue}, ${sat}%, ${Math.max(10, light-20)}%)`);
    }
  }

  setHarmonics(harmonics){
    // ожидаем [{amp,freq,phase, active, colorIndex, name}]
    this.harmonics = harmonics || [];
    const active = this.harmonics.find(h=>h.active);
    const hue = active ? (active.colorIndex*27)%360 : 180;
    const col = new THREE.Color(`hsl(${hue},100%,65%)`);
    this.activeLine.matCore.color.copy(col);
    this.activeLine.matGlow.color.copy(col);

    // выдать легенду наверх
    this.onLegend(this.harmonics);

    // обновить подписи
    this._updateLabels();
  }

  setSpectrogram(frames){
    if (!frames || !frames.length) return;
    const W = this.spectroCanvas.width;
    const H = this.spectroCanvas.height;
    const ctx = this.spectroCtx;
    // прокрутка влево
    const img = ctx.getImageData(0,0,W,H);
    ctx.clearRect(0,0,W,H);
    ctx.putImageData(img, -1, 0);
    // последний столбец — новые данные, растянем bins по высоте
    const bins = frames[frames.length-1].length;
    for (let y=0;y<H;y++){
      const i = Math.floor((1 - y/H) * (bins-1)); // сверху — высокие частоты
      const v = Math.max(0, Math.min(1, frames[frames.length-1][i]));
      const hue = 180 + 120*v; // бирюзово-зелёный
      const alpha = 160 + Math.floor(95*v);
      ctx.fillStyle = `hsla(${hue}, 80%, ${30+v*40}%, ${alpha/255})`;
      ctx.fillRect(W-1, y, 1, 1);
    }
    this.spectroTex.needsUpdate = true;
  }

  _composeSignal(){
    const samples = 900;
    const ptsSum = new Float32Array(samples*3);
    const ptsAct = new Float32Array(samples*3);

    const act = this.harmonics.find(h=>h.active) || {amp:0,freq:1,phase:0};
    for (let i=0;i<samples;i++){
      const u = i/(samples-1);
      const x = (u-0.5)*6.4;
      const sSum = this.harmonics.reduce((acc,h)=>{
        const A = h.amp||0, f=h.freq||1, p=h.phase||0;
        return acc + A*Math.sin(2*Math.PI*(f*u + 0.1*Math.sin(0.25*this.time)) + p);
      },0);
      const sAct = (act.amp||0)*Math.sin(2*Math.PI*((act.freq||1)*u)+ (act.phase||0));
      const ySum = sSum*0.48;
      const yAct = sAct*0.58;
      const z = Math.sin(u*Math.PI*2 + 0.15*this.time)*0.12 - 0.6;

      const k=i*3;
      ptsSum[k]=x; ptsSum[k+1]=ySum; ptsSum[k+2]=z;
      ptsAct[k]=x; ptsAct[k+1]=yAct; ptsAct[k+2]=z+0.02;
    }
    this.sumLine.geom.setAttribute('position', new THREE.BufferAttribute(ptsSum,3));
    this.sumLine.geom.computeBoundingSphere();
    this.activeLine.geom.setAttribute('position', new THREE.BufferAttribute(ptsAct,3));
    this.activeLine.geom.computeBoundingSphere();
  }

  tapPulse(){
    this.sumLine.matCore.opacity = 1.0;
    this.sumLine.matGlow.opacity = 0.35;
    setTimeout(()=>{
      this.sumLine.matCore.opacity = 0.95;
      this.sumLine.matGlow.opacity = 0.22;
    }, 180);
  }

  _tick(ts){
    this.time = ts/1000;
    this._composeSignal();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._tick);
  }
}
