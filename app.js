/* PaintYCompanion — touch & pen painting over a map. No dependencies. */
(() => {
  'use strict';

  // ---------- Config ----------
  const HISTORY_STEPS = 30;
  const WORLD_LONG_SIDE = 2400;        // painting resolution (long edge, px)
  const BUILTIN_MAP = 'assets/panaji-map.svg';
  const STORE_KEY = 'paintyc.settings.v1';

  const DEFAULT_COLORS = [
    { name: 'Laterite Red',  hex: '#c8442f' },
    { name: 'Mango Yellow',  hex: '#f5b700' },
    { name: 'Cashew Orange', hex: '#f07c24' },
    { name: 'Monsoon Green', hex: '#2e9b4f' },
    { name: 'Mandovi Blue',  hex: '#1e6fd9' },
    { name: 'Bougainvillea', hex: '#d6338a' },
    { name: 'Coconut Brown', hex: '#7a4a2a' },
    { name: 'Night Ink',     hex: '#25282c' },
  ];

  const DEFAULTS = {
    bgMode: 'builtin',      // builtin | url | upload | none
    bgUrl: '',
    uploadName: '',
    bgOpacity: 1,
    outlinesTop: true,
    palettePos: 'bottom',   // bottom | top | left | right
    colors: DEFAULT_COLORS,
    selected: 0,
    brushSize: 14,
    pressure: true,
    penOnly: false,
  };

  // ---------- Settings persistence ----------
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = Object.assign({}, DEFAULTS, JSON.parse(raw));
        if (!Array.isArray(s.colors) || !s.colors.length) s.colors = DEFAULT_COLORS;
        return s;
      }
    } catch (_) {}
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (_) {}
  }
  const S = loadSettings();
  S.colors = S.colors.map(c => ({ name: String(c.name || ''), hex: String(c.hex || '#000000') }));
  if (S.selected >= S.colors.length) S.selected = 0;

  // Uploaded background is kept in IndexedDB (too big for localStorage).
  const idb = {
    open() {
      return new Promise((res, rej) => {
        try {
          const r = indexedDB.open('paintyc', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('files');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        } catch (e) { rej(e); }
      });
    },
    async put(key, val) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put(val, key);
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
    },
    async get(key) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const r = db.transaction('files').objectStore('files').get(key);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    },
  };

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const board = $('board');
  const ctx = board.getContext('2d');
  const paletteEl = $('palette');
  const flashEl = $('flash');
  const undoBtn = $('undoBtn');
  const redoBtn = $('redoBtn');

  // ---------- Layers ----------
  // paint: the live painting at world resolution.
  // base:  everything older than the undo window, baked into pixels.
  const paint = document.createElement('canvas');
  const pctx = paint.getContext('2d');
  const base = document.createElement('canvas');
  const bctx = base.getContext('2d');
  let baseDirty = false;
  const bgLayer = document.createElement('canvas'); // map rasterised at screen size
  const bgctx = bgLayer.getContext('2d');

  let bgImage = null;
  let world = { w: 0, h: 0 };
  let view = { x: 0, y: 0, w: 0, h: 0, s: 1 }; // board rect on screen (CSS px), s = screen px per world px
  let dpr = 1;

  function setWorld(aspect) {
    let w, h;
    if (aspect >= 1) { w = WORLD_LONG_SIDE; h = Math.round(WORLD_LONG_SIDE / aspect); }
    else { h = WORLD_LONG_SIDE; w = Math.round(WORLD_LONG_SIDE * aspect); }
    if (w === world.w && h === world.h) return;

    // Keep the current painting: fit it into the new board, history resets.
    let old = null;
    if (world.w && !isBlank()) {
      old = document.createElement('canvas');
      old.width = world.w; old.height = world.h;
      old.getContext('2d').drawImage(paint, 0, 0);
    }
    world = { w, h };
    for (const c of [paint, base]) { c.width = w; c.height = h; }
    pctx.lineCap = bctx.lineCap = 'round';
    pctx.lineJoin = bctx.lineJoin = 'round';
    ops.length = 0; redoStack.length = 0;
    baseDirty = false;
    if (old) {
      const k = Math.min(w / old.width, h / old.height);
      const dw = old.width * k, dh = old.height * k;
      bctx.drawImage(old, (w - dw) / 2, (h - dh) / 2, dw, dh);
      baseDirty = true;
      pctx.drawImage(base, 0, 0);
    }
    updateHistoryButtons();
  }

  // ---------- History ----------
  const ops = [];        // strokes / clears inside the undo window
  const redoStack = [];

  function applyOp(c, op) {
    if (op.type === 'clear') { c.clearRect(0, 0, world.w, world.h); return; }
    drawStroke(c, op);
  }
  function commit(op) {
    ops.push(op);
    redoStack.length = 0;
    if (ops.length > HISTORY_STEPS) {
      applyOp(bctx, ops.shift());
      baseDirty = true;
    }
    updateHistoryButtons();
  }
  function rebuild() {
    pctx.clearRect(0, 0, world.w, world.h);
    if (baseDirty) pctx.drawImage(base, 0, 0);
    for (const op of ops) applyOp(pctx, op);
    requestRender();
  }
  function undo() {
    if (!ops.length || stroke) return;
    redoStack.push(ops.pop());
    rebuild();
    updateHistoryButtons();
  }
  function redo() {
    if (!redoStack.length || stroke) return;
    const op = redoStack.pop();
    ops.push(op);
    applyOp(pctx, op);
    requestRender();
    updateHistoryButtons();
  }
  function isBlank() {
    if (!ops.length) return !baseDirty;
    return ops[ops.length - 1].type === 'clear';
  }
  function clearCanvas() {
    if (stroke) return;
    if (!isBlank()) {
      const op = { type: 'clear' };
      commit(op);
      applyOp(pctx, op);
      requestRender();
    }
    flash('Cleared', '#25282c');
  }
  function updateHistoryButtons() {
    undoBtn.disabled = !ops.length;
    redoBtn.disabled = !redoStack.length;
  }

  // ---------- Stroke rendering (shared by live drawing and replay) ----------
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  function dot(c, p, color) {
    c.fillStyle = color;
    c.beginPath(); c.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2); c.fill();
  }
  function line(c, a, b, w) {
    c.lineWidth = w;
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
  }
  function curve(c, a, b, d) { // from mid(a,b) to mid(b,d), control b
    const m1 = mid(a, b), m2 = mid(b, d);
    c.lineWidth = b.w;
    c.beginPath(); c.moveTo(m1.x, m1.y); c.quadraticCurveTo(b.x, b.y, m2.x, m2.y); c.stroke();
  }
  // Draws the part of a stroke contributed by point i (live, incremental).
  function drawStep(c, s, i, final) {
    const p = s.pts;
    c.strokeStyle = s.color;
    if (i === 0) { dot(c, p[0], s.color); return; }
    if (i === 1) line(c, p[0], mid(p[0], p[1]), (p[0].w + p[1].w) / 2);
    else curve(c, p[i - 2], p[i - 1], p[i]);
    if (final) line(c, mid(p[i - 1], p[i]), p[i], p[i].w);
  }
  function drawStroke(c, s) {
    const n = s.pts.length;
    for (let i = 0; i < n; i++) drawStep(c, s, i, i === n - 1);
  }

  // ---------- Input ----------
  let stroke = null;       // stroke in progress
  let activeId = null;
  let lastPenTime = 0;

  function toWorld(e) {
    return { x: (e.clientX - view.x) / view.s, y: (e.clientY - view.y) / view.s };
  }
  function widthFor(e) {
    const baseW = S.brushSize / view.s; // brush size is in screen px
    if (e.pointerType === 'pen' && S.pressure && e.pressure > 0) {
      return baseW * Math.min(1.8, 0.3 + 1.4 * e.pressure);
    }
    return baseW;
  }
  function addPoint(e) {
    const q = toWorld(e);
    const p = stroke.pts;
    const last = p[p.length - 1];
    if (last && Math.hypot(q.x - last.x, q.y - last.y) < 0.75) return;
    q.w = widthFor(e);
    p.push(q);
    drawStep(pctx, stroke, p.length - 1, false);
  }

  board.addEventListener('pointerdown', e => {
    if (activeId !== null) return;              // one stroke at a time (ignores palms / 2nd finger)
    if (e.pointerType === 'pen') lastPenTime = performance.now();
    if (e.pointerType === 'touch' && (S.penOnly || performance.now() - lastPenTime < 1500)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const color = S.colors[S.selected] ? S.colors[S.selected].hex : '#000';
    activeId = e.pointerId;
    try { board.setPointerCapture(e.pointerId); } catch (_) {}
    stroke = { type: 'stroke', color, pts: [] };
    addPoint(e);
    requestRender();
    e.preventDefault();
  });

  board.addEventListener('pointermove', e => {
    if (e.pointerType === 'pen') lastPenTime = performance.now();
    if (e.pointerId !== activeId || !stroke) return;
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (list && list.length) for (const ce of list) addPoint(ce);
    else addPoint(e);
    requestRender();
  });

  function endStroke(e) {
    if (e.pointerId !== activeId || !stroke) return;
    const s = stroke, n = s.pts.length;
    if (n > 1) line(pctx, mid(s.pts[n - 2], s.pts[n - 1]), s.pts[n - 1], s.pts[n - 1].w);
    stroke = null; activeId = null;
    commit(s);
    requestRender();
  }
  board.addEventListener('pointerup', endStroke);
  board.addEventListener('pointercancel', endStroke);
  board.addEventListener('lostpointercapture', endStroke);

  document.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', e => {
    if (e.target.matches('input')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); }
  });
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  // ---------- Layout & render ----------
  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  function boardArea() {
    const W = innerWidth, H = innerHeight;
    const r = paletteEl.getBoundingClientRect();
    const g = 12;
    let t = 68, b = g, l = g, rt = g;
    const pos = S.palettePos;
    if (pos === 'bottom') b = H - r.top + g;
    if (pos === 'top') { t = r.bottom + g; b = 68; }
    if (pos === 'left') l = r.right + g;
    if (pos === 'right') { rt = W - r.left + g; b = 64; }
    return { x: l, y: t, w: Math.max(50, W - l - rt), h: Math.max(50, H - t - b) };
  }

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const W = innerWidth, H = innerHeight;
    board.width = Math.round(W * dpr);
    board.height = Math.round(H * dpr);
    const a = boardArea();
    if (!world.w) setWorld(a.w / a.h);
    const s = Math.min(a.w / world.w, a.h / world.h);
    const w = world.w * s, h = world.h * s;
    view = { x: a.x + (a.w - w) / 2, y: a.y + (a.h - h) / 2, w, h, s };

    // Rasterise background at exact screen resolution (keeps SVG lines crisp).
    bgLayer.width = Math.max(1, Math.round(w * dpr));
    bgLayer.height = Math.max(1, Math.round(h * dpr));
    bgctx.clearRect(0, 0, bgLayer.width, bgLayer.height);
    if (bgImage) {
      try { bgctx.drawImage(bgImage, 0, 0, bgLayer.width, bgLayer.height); } catch (_) {}
    }
    requestRender();
  }

  function render() {
    renderQueued = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, board.width, board.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = view;

    // Paper
    ctx.save();
    ctx.shadowColor = 'rgba(30,34,40,0.10)';
    ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(v.x, v.y, v.w, v.h);
    ctx.restore();

    ctx.save();
    ctx.beginPath(); ctx.rect(v.x, v.y, v.w, v.h); ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    const drawBg = () => { if (bgImage) { ctx.globalAlpha = S.bgOpacity; ctx.drawImage(bgLayer, v.x, v.y, v.w, v.h); ctx.globalAlpha = 1; } };
    if (!S.outlinesTop) drawBg();
    ctx.drawImage(paint, v.x, v.y, v.w, v.h);
    if (S.outlinesTop) { ctx.globalCompositeOperation = 'multiply'; drawBg(); ctx.globalCompositeOperation = 'source-over'; }
    ctx.restore();
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 60); });

  // ---------- Background ----------
  let bgUrlObject = null;
  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('Could not load ' + src));
      img.src = src;
    });
  }
  async function applyBackground() {
    setBgError('');
    let img = null;
    try {
      if (S.bgMode === 'builtin') img = await loadImage(BUILTIN_MAP);
      else if (S.bgMode === 'url' && S.bgUrl.trim()) img = await loadImage(S.bgUrl.trim());
      else if (S.bgMode === 'upload') {
        const blob = await idb.get('bg').catch(() => null);
        if (blob) {
          if (bgUrlObject) URL.revokeObjectURL(bgUrlObject);
          bgUrlObject = URL.createObjectURL(blob);
          img = await loadImage(bgUrlObject);
        }
      }
    } catch (err) {
      setBgError('Couldn’t load that image. Check the path.');
      img = null;
    }
    bgImage = img;
    if (img && img.naturalWidth && img.naturalHeight) setWorld(img.naturalWidth / img.naturalHeight);
    else if (!world.w) { const a = boardArea(); setWorld(a.w / a.h); }
    layout();
  }

  // ---------- Palette ----------
  const TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

  function renderPalette() {
    document.body.dataset.palette = S.palettePos;
    paletteEl.innerHTML = '';
    S.colors.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.setProperty('--c', c.hex);
      b.setAttribute('aria-label', c.name || c.hex);
      b.setAttribute('aria-pressed', String(i === S.selected));
      b.addEventListener('click', () => selectColor(i));
      paletteEl.appendChild(b);
    });
    const sep = document.createElement('span'); sep.className = 'sep';
    paletteEl.appendChild(sep);
    const clr = document.createElement('button');
    clr.id = 'clearBtn'; clr.className = 'icon-btn';
    clr.setAttribute('aria-label', 'Clear canvas');
    clr.innerHTML = TRASH;
    clr.addEventListener('click', clearCanvas);
    paletteEl.appendChild(clr);
  }

  function selectColor(i) {
    S.selected = i;
    [...paletteEl.querySelectorAll('.swatch')].forEach((el, j) => el.setAttribute('aria-pressed', String(j === i)));
    saveSettings();
    const c = S.colors[i];
    flash(c.name || c.hex, c.hex);
  }

  function luminance(hex) {
    const m = hex.replace('#', '');
    const n = m.length === 3 ? m.split('').map(x => x + x).join('') : m;
    const [r, g, b] = [0, 2, 4].map(k => {
      const v = parseInt(n.substr(k, 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function flash(text, color) {
    flashEl.textContent = text;
    flashEl.style.color = color;
    flashEl.style.textShadow = luminance(color) > 0.45
      ? '0 0 1px rgba(0,0,0,.55), 0 2px 3px rgba(0,0,0,.25), 0 0 28px rgba(0,0,0,.18)'
      : '0 0 2px #fff, 0 0 4px #fff, 0 0 22px rgba(255,255,255,.95), 0 0 48px rgba(255,255,255,.8)';
    flashEl.classList.remove('show');
    void flashEl.offsetWidth; // restart animation
    flashEl.classList.add('show');
  }

  // ---------- Settings UI ----------
  const sheet = $('settings'), scrim = $('scrim');
  function openSettings() { syncSettingsUI(); sheet.hidden = false; scrim.hidden = false; }
  function closeSettings() { sheet.hidden = true; scrim.hidden = true; }
  $('settingsBtn').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  scrim.addEventListener('click', closeSettings);

  function setSeg(el, val) {
    el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === val));
  }
  function segment(id, key, onChange) {
    const el = $(id);
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      S[key] = b.dataset.v; setSeg(el, S[key]); saveSettings(); onChange();
    });
  }

  let bgErrorEl = null;
  function setBgError(msg) {
    if (!bgErrorEl) {
      bgErrorEl = document.createElement('p');
      bgErrorEl.className = 'fine';
      bgErrorEl.style.color = '#c8442f';
      $('bgUrl').closest('.row').after(bgErrorEl);
    }
    bgErrorEl.textContent = msg;
    bgErrorEl.hidden = !msg;
  }

  function showBgRows() {
    sheet.querySelectorAll('[data-show]').forEach(r => { r.hidden = r.dataset.show !== S.bgMode; });
  }

  segment('bgMode', 'bgMode', () => { showBgRows(); applyBackground(); });
  segment('palettePos', 'palettePos', () => { renderPalette(); layout(); });

  let urlTimer = 0;
  $('bgUrl').addEventListener('input', e => {
    S.bgUrl = e.target.value; saveSettings();
    clearTimeout(urlTimer); urlTimer = setTimeout(applyBackground, 500);
  });
  $('bgFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    S.uploadName = f.name; saveSettings();
    $('uploadName').textContent = f.name;
    try { await idb.put('bg', f); } catch (_) { setBgError('Couldn’t store the image on this device.'); }
    applyBackground();
  });
  $('bgOpacity').addEventListener('input', e => { S.bgOpacity = +e.target.value; saveSettings(); requestRender(); });
  $('outlinesTop').addEventListener('change', e => { S.outlinesTop = e.target.checked; saveSettings(); requestRender(); });
  $('brushSize').addEventListener('input', e => { S.brushSize = +e.target.value; $('sizeOut').textContent = S.brushSize; saveSettings(); });
  $('pressure').addEventListener('change', e => { S.pressure = e.target.checked; saveSettings(); });
  $('penOnly').addEventListener('change', e => { S.penOnly = e.target.checked; saveSettings(); });

  // Colour editor
  const colorList = $('colorList');
  function renderColorEditor() {
    colorList.innerHTML = '';
    S.colors.forEach((c, i) => {
      const row = document.createElement('div'); row.className = 'color-row';
      const pick = document.createElement('input'); pick.type = 'color'; pick.value = c.hex;
      pick.addEventListener('input', () => { c.hex = pick.value; saveSettings(); renderPalette(); });
      const name = document.createElement('input'); name.type = 'text'; name.value = c.name; name.placeholder = 'Colour name';
      name.addEventListener('input', () => { c.name = name.value; saveSettings(); renderPalette(); });
      const del = document.createElement('button'); del.className = 'icon-btn'; del.setAttribute('aria-label', 'Remove colour');
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      del.disabled = S.colors.length <= 1;
      del.addEventListener('click', () => {
        S.colors.splice(i, 1);
        if (S.selected >= S.colors.length) S.selected = S.colors.length - 1;
        else if (S.selected > i) S.selected--;
        saveSettings(); renderColorEditor(); renderPalette(); layout();
      });
      row.append(pick, name, del);
      colorList.appendChild(row);
    });
    $('addColor').disabled = S.colors.length >= 16;
  }
  $('addColor').addEventListener('click', () => {
    if (S.colors.length >= 16) return;
    const h = Math.floor(Math.random() * 360);
    S.colors.push({ name: 'Colour ' + (S.colors.length + 1), hex: hslToHex(h, 70, 50) });
    saveSettings(); renderColorEditor(); renderPalette(); layout();
  });
  $('resetColors').addEventListener('click', () => {
    S.colors = DEFAULT_COLORS.map(c => ({ ...c })); S.selected = 0;
    saveSettings(); renderColorEditor(); renderPalette(); layout();
  });
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, '0');
    return '#' + f(0) + f(8) + f(4);
  }

  // Save / fullscreen
  $('saveImage').addEventListener('click', () => {
    const out = document.createElement('canvas');
    out.width = world.w; out.height = world.h;
    const o = out.getContext('2d');
    o.fillStyle = '#fff'; o.fillRect(0, 0, world.w, world.h);
    const bg = () => { if (bgImage) { o.globalAlpha = S.bgOpacity; o.drawImage(bgImage, 0, 0, world.w, world.h); o.globalAlpha = 1; } };
    if (!S.outlinesTop) bg();
    o.drawImage(paint, 0, 0);
    if (S.outlinesTop) { o.globalCompositeOperation = 'multiply'; bg(); o.globalCompositeOperation = 'source-over'; }
    out.toBlob(blob => {
      if (!blob) return;
      const a = document.createElement('a');
      const t = new Date();
      const stamp = t.getFullYear() + String(t.getMonth() + 1).padStart(2, '0') + String(t.getDate()).padStart(2, '0') + '-' + String(t.getHours()).padStart(2, '0') + String(t.getMinutes()).padStart(2, '0');
      a.href = URL.createObjectURL(blob); a.download = 'paintycompanion-' + stamp + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  });
  $('fullscreen').addEventListener('click', () => {
    const d = document;
    if (d.fullscreenElement) d.exitFullscreen && d.exitFullscreen();
    else (d.documentElement.requestFullscreen || d.documentElement.webkitRequestFullscreen || (() => {})).call(d.documentElement);
  });

  function syncSettingsUI() {
    setSeg($('bgMode'), S.bgMode);
    setSeg($('palettePos'), S.palettePos);
    $('bgUrl').value = S.bgUrl;
    $('uploadName').textContent = S.uploadName || 'No image chosen';
    $('bgOpacity').value = S.bgOpacity;
    $('outlinesTop').checked = S.outlinesTop;
    $('brushSize').value = S.brushSize;
    $('sizeOut').textContent = S.brushSize;
    $('pressure').checked = S.pressure;
    $('penOnly').checked = S.penOnly;
    showBgRows();
    renderColorEditor();
  }

  // ---------- Boot ----------
  renderPalette();
  syncSettingsUI();
  updateHistoryButtons();
  layout();
  applyBackground();

  // Debug/test hook
  window.PaintY = { undo, redo, clearCanvas, state: () => ({ ops: ops.length, redo: redoStack.length, world, view }) };
})();
