/* Paint your Panaji (PaintYCompanion) — touch & pen painting over a map. No dependencies. */
(() => {
  'use strict';

  // ---------- Config ----------
  const HISTORY_STEPS = 30;
  const MAP_LONG_SIDE = 1800;          // map resolution inside the painting (long edge, px)
  const WORLD_MAX_SIDE = 3200;         // cap on the painting canvas (memory)
  const BUILTIN_MAP = 'assets/panjim-outline.svg';
  const STORE_KEY = 'paintyc.settings.v1';
  const COUNT_KEY = 'paintyc.saveCount';

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
    mapRotate: 0,           // degrees
    mapScale: 1,            // 1 = fit to screen
    outlinesTop: true,
    palettePos: 'bottom',   // bottom | top | left | right
    colors: DEFAULT_COLORS,
    selected: 0,
    brushSize: 14,
    pressure: true,
    penOnly: false,
    sound: true,
    idleSecs: 8,            // 0 = never fade the title back in
    soundVol: 0.8,
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
  S.colors = S.colors.map(c => ({ name: String(c.name || ''), hex: String(c.hex || '#000000'), free: !!c.free }));
  if (S.selected >= S.colors.length) S.selected = 0;
  if (/panaji-map\.svg/.test(S.bgUrl)) { S.bgMode = 'builtin'; S.bgUrl = ''; }

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

  // ---------- Map mask: which pixels are inside the outline ----------
  // Built once per background by flood-filling the image from its border: every light pixel
  // reachable from the edge is "outside"; the rest (inside + the outline itself) is the map.
  const maskC = document.createElement('canvas');    // world-space alpha mask (map's rotated box)
  const mctx = maskC.getContext('2d');
  const tintC = document.createElement('canvas');    // mask filled with the current colour
  const tctx = tintC.getContext('2d');
  let inside = null;                                  // { w, h, a: Uint8Array } in map-image pixels
  let maskBox = null, maskValid = false, tintColor = null, maskVer = 0;

  function buildInside() {
    inside = null;
    if (!bgImage || !map.w) return;
    const W = map.w, H = map.h, N = W * H;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    try { g.drawImage(bgImage, 0, 0, W, H); } catch (_) { return; }
    const d = g.getImageData(0, 0, W, H).data;
    const wall = new Uint8Array(N);
    for (let i = 0, j = 0; i < N; i++, j += 4) if (d[j] * 0.3 + d[j + 1] * 0.59 + d[j + 2] * 0.11 < 200) wall[i] = 1;
    const out = new Uint8Array(N);
    const stack = new Int32Array(N);
    let sp = 0;
    const push = i => { if (!wall[i] && !out[i]) { out[i] = 1; stack[sp++] = i; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (sp) {
      const i = stack[--sp], x = i % W;
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (i >= W) push(i - W);
      if (i < N - W) push(i + W);
    }
    let count = 0;
    const a = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (!out[i]) { a[i] = 1; count++; }
    if (count < N * 0.02 || count > N * 0.98) return;   // open outline / no outline: don't restrict
    inside = { w: W, h: H, a };
  }

  function placeMask() {
    maskValid = false; tintColor = null; maskVer++;
    if (!inside) return;
    const { w: W, h: H, a } = inside;
    const src = document.createElement('canvas'); src.width = W; src.height = H;
    const sg = src.getContext('2d');
    const img = sg.createImageData(W, H);
    for (let i = 0, j = 3; i < a.length; i++, j += 4) if (a[i]) img.data[j] = 255;
    sg.putImageData(img, 0, 0);
    const t = mapTf();
    maskBox = { x: Math.floor(t.cx - t.ew / 2), y: Math.floor(t.cy - t.eh / 2), w: Math.ceil(t.ew) + 2, h: Math.ceil(t.eh) + 2 };
    maskC.width = tintC.width = maskBox.w; maskC.height = tintC.height = maskBox.h;
    mctx.save();
    mctx.translate(t.cx - maskBox.x, t.cy - maskBox.y); mctx.rotate(t.rot);
    mctx.drawImage(src, -t.cw / 2, -t.ch / 2, t.cw, t.ch);
    mctx.restore();
    maskValid = true;
  }

  // The map's placement inside the painting (world px), including rotation / size offsets.
  function mapTf() {
    const k = S.mapScale || 1, rot = (S.mapRotate || 0) * Math.PI / 180;
    const cw = map.w * k, ch = map.h * k, c = Math.abs(Math.cos(rot)), sn = Math.abs(Math.sin(rot));
    return { k, rot, cw, ch, ew: cw * c + ch * sn, eh: cw * sn + ch * c, cx: map.x + map.w / 2, cy: map.y + map.h / 2 };
  }

  // Is a world point inside the map outline?
  function isInsideMap(x, y) {
    if (!inside || !maskValid) return true;
    const t = mapTf(), dx = x - t.cx, dy = y - t.cy;
    const cs = Math.cos(-t.rot), sn = Math.sin(-t.rot);
    const ix = Math.floor((dx * cs - dy * sn) / t.k + inside.w / 2);
    const iy = Math.floor((dx * sn + dy * cs) / t.k + inside.h / 2);
    if (ix < 0 || iy < 0 || ix >= inside.w || iy >= inside.h) return false;
    return inside.a[iy * inside.w + ix] === 1;
  }

  // Paint style for a stroke: plain colour, or a pattern that only exists inside the map.
  function styleFor(c, s) {
    if (!s.clip || !maskValid) return s.color;
    if (tintColor !== s.color) {
      tctx.globalCompositeOperation = 'copy'; tctx.drawImage(maskC, 0, 0);
      tctx.globalCompositeOperation = 'source-in'; tctx.fillStyle = s.color; tctx.fillRect(0, 0, tintC.width, tintC.height);
      tctx.globalCompositeOperation = 'source-over';
      tintColor = s.color; maskVer++;
    }
    const cache = c.__pat;
    if (cache && cache.v === maskVer) return cache.p;
    const pat = c.createPattern(tintC, 'no-repeat');
    if (pat.setTransform) pat.setTransform(new DOMMatrix().translateSelf(maskBox.x, maskBox.y));
    c.__pat = { v: maskVer, p: pat };
    return pat;
  }
  let world = { w: 0, h: 0 };
  let map = { x: 0, y: 0, w: 0, h: 0 };   // where the map sits inside the painting (world px)
  let view = { x: 0, y: 0, w: 0, h: 0, s: 1 }; // board rect on screen (CSS px), s = screen px per world px
  let dpr = 1;

  // The painting is larger than the map so the whole screen is paintable in portrait AND landscape:
  // the map sits in the middle, the extra room covers the screen's widest aspect either way round.
  function setWorld(aspect) {
    const sw = screen.width || innerWidth, sh = screen.height || innerHeight;
    const room = Math.min(sw, sh) < 600 ? 1.65 : 1.3;   // phones lose more height to the palette / undo bar
    const F = Math.min(3.8, Math.max(1.2, Math.max(sw, sh) / Math.min(sw, sh)) * room);
    const L = Math.min(MAP_LONG_SIDE, Math.floor(WORLD_MAX_SIDE / F));
    const mw = aspect >= 1 ? L : Math.round(L * aspect);
    const mh = aspect >= 1 ? Math.round(L / aspect) : L;
    const w = Math.round(Math.max(mw, mh * F)), h = Math.round(Math.max(mh, mw * F));
    map = { x: Math.round((w - mw) / 2), y: Math.round((h - mh) / 2), w: mw, h: mh };
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

  function dot(c, p, style) {
    c.fillStyle = style;
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
    const st = styleFor(c, s);
    c.strokeStyle = st;
    if (i === 0) { dot(c, p[0], st); return; }
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
  // A brick sound every so often along a stroke (only where paint actually lands).
  let brickDist = 0, lastBrick = 0, lastBrickPt = null;
  function maybeBrick(e, first) {
    const q = { x: e.clientX, y: e.clientY };
    if (!first && lastBrickPt) brickDist += Math.hypot(q.x - lastBrickPt.x, q.y - lastBrickPt.y);
    lastBrickPt = q;
    const now = performance.now();
    const spacing = Math.max(46, S.brushSize * 2.6);
    if (!first && (brickDist < spacing || now - lastBrick < 85)) return;
    if (stroke && stroke.clip) { const w = toWorld(e); if (!isInsideMap(w.x, w.y)) return; }
    brickDist = 0; lastBrick = now;
    Sound.brick(first ? 1 : 0.8 + Math.random() * 0.25);
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
    const col = S.colors[S.selected] || { hex: '#000', free: false };
    activeId = e.pointerId;
    try { board.setPointerCapture(e.pointerId); } catch (_) {}
    stroke = { type: 'stroke', color: col.hex, clip: !col.free, pts: [] };
    Sound.unlock();
    brickDist = 0; lastBrick = 0;
    addPoint(e);
    maybeBrick(e, true);
    requestRender();
    e.preventDefault();
  });

  board.addEventListener('pointermove', e => {
    if (e.pointerType === 'pen') lastPenTime = performance.now();
    if (e.pointerId !== activeId || !stroke) return;
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (list && list.length) for (const ce of list) addPoint(ce);
    else addPoint(e);
    maybeBrick(e, false);
    requestRender();
  });

  function endStroke(e) {
    if (e.pointerId !== activeId || !stroke) return;
    const s = stroke, n = s.pts.length;
    if (n > 1) { pctx.strokeStyle = styleFor(pctx, s); line(pctx, mid(s.pts[n - 2], s.pts[n - 1]), s.pts[n - 1], s.pts[n - 1].w); }
    stroke = null; activeId = null;
    commit(s);
    requestRender();
    if (Tour.active) Tour.event('stroke');
  }
  board.addEventListener('pointerup', endStroke);
  let triedFs = false;
  window.addEventListener('pointerup', () => {
    if (triedFs) return; triedFs = true;
    const el = document.documentElement, standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
    if (!standalone && !document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  });
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
    const g = 8;                       // map fills the screen; only the palette side is kept clear
    let t = g, b = g, l = g, rt = g;
    const pos = S.palettePos;
    if (H < 600 && pos !== 'top') t = 64;     // short landscape screens: keep the map clear of undo/redo
    if (pos === 'bottom') b = H - r.top + g;
    if (pos === 'top') t = r.bottom + g;
    if (pos === 'left') l = r.right + g;
    if (pos === 'right') rt = W - r.left + g;
    return { x: l, y: t, w: Math.max(50, W - l - rt), h: Math.max(50, H - t - b) };
  }

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const W = innerWidth, H = innerHeight;
    board.width = Math.round(W * dpr);
    board.height = Math.round(H * dpr);
    const a = boardArea();
    if (!world.w) setWorld(a.w / a.h);
    const s = Math.min(a.w / map.w, a.h / map.h);      // map as big as the screen allows
    const mx = a.x + (a.w - map.w * s) / 2, my = a.y + (a.h - map.h * s) / 2;
    view = { x: mx - map.x * s, y: my - map.y * s, w: world.w * s, h: world.h * s, s };

    // Rasterise background at exact screen resolution (keeps SVG lines crisp).
    const k = S.mapScale || 1;                         // raster at the scaled size so it stays crisp
    bgLayer.width = Math.max(1, Math.round(map.w * s * k * dpr));
    bgLayer.height = Math.max(1, Math.round(map.h * s * k * dpr));
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
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, innerWidth, innerHeight);

    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    const bx = v.x + map.x * v.s, by = v.y + map.y * v.s, bw = map.w * v.s, bh = map.h * v.s;
    const k = S.mapScale || 1, rot = (S.mapRotate || 0) * Math.PI / 180;
    const drawBg = () => {
      if (!bgImage) return;
      ctx.save();
      ctx.globalAlpha = S.bgOpacity;
      ctx.translate(bx + bw / 2, by + bh / 2); ctx.rotate(rot);
      ctx.drawImage(bgLayer, -bw * k / 2, -bh * k / 2, bw * k, bh * k);
      ctx.restore();
    };
    if (!S.outlinesTop) drawBg();
    ctx.drawImage(paint, v.x, v.y, v.w, v.h);
    if (S.outlinesTop) { ctx.globalCompositeOperation = 'multiply'; drawBg(); ctx.globalCompositeOperation = 'source-over'; }
    ctx.restore();
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 60); });
  window.addEventListener('orientationchange', () => setTimeout(layout, 250));

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
    buildInside(); placeMask(); rebuild();
    layout();
  }

  // ---------- Palette ----------
  const TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

  function renderPalette() {
    document.body.dataset.palette = S.palettePos;
    paletteEl.innerHTML = '';
    S.colors.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'swatch-item';
      b.style.setProperty('--c', c.hex);
      b.setAttribute('aria-label', c.name || c.hex);
      b.setAttribute('aria-pressed', String(i === S.selected));
      b.innerHTML = '<span class="swatch"></span><span class="swatch-name"></span>';
      b.lastChild.textContent = c.name || c.hex;
      if ((c.name || '').split(' ').some(w => w.length > 9)) b.lastChild.classList.add('long');
      b.addEventListener('click', () => selectColor(i));
      paletteEl.appendChild(b);
    });
    const sep = document.createElement('span'); sep.className = 'sep';
    paletteEl.appendChild(sep);
    const clr = document.createElement('button');
    clr.id = 'clearBtn'; clr.className = 'swatch-item clear-item';
    clr.setAttribute('aria-label', 'Clear canvas');
    clr.innerHTML = '<span class="swatch tool">' + TRASH + '</span><span class="swatch-name">Clear</span>';
    clr.addEventListener('click', clearCanvas);
    paletteEl.appendChild(clr);
    renderTitleBricks();
  }

  function selectColor(i) {
    S.selected = i;
    [...paletteEl.querySelectorAll('.swatch-item:not(.clear-item)')].forEach((el, j) => el.setAttribute('aria-pressed', String(j === i)));
    saveSettings();
    const c = S.colors[i];
    flash(c.name || c.hex, c.hex);
    Sound.unlock(); Sound.pick();
    if (Tour.active) Tour.event('color');
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
  function closeSettings() { sheet.hidden = true; scrim.hidden = true; armIdle(); }
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
  const showMapTf = () => {
    $('rotOut').textContent = Math.round(S.mapRotate) + '°';
    $('scaleOut').textContent = Math.round(S.mapScale * 100) + '%';
  };
  let tfTimer = 0;
  const mapMoved = () => { clearTimeout(tfTimer); tfTimer = setTimeout(() => { placeMask(); rebuild(); layout(); }, 150); };
  $('mapRotate').addEventListener('input', e => { S.mapRotate = +e.target.value; showMapTf(); saveSettings(); requestRender(); mapMoved(); });
  $('mapScale').addEventListener('input', e => { S.mapScale = +e.target.value / 100; showMapTf(); saveSettings(); requestRender(); mapMoved(); });
  $('resetMapTf').addEventListener('click', () => {
    S.mapRotate = 0; S.mapScale = 1; saveSettings();
    $('mapRotate').value = 0; $('mapScale').value = 100; showMapTf(); mapMoved();
  });
  $('outlinesTop').addEventListener('change', e => { S.outlinesTop = e.target.checked; saveSettings(); requestRender(); });
  $('brushSize').addEventListener('input', e => { S.brushSize = +e.target.value; $('sizeOut').textContent = S.brushSize; saveSettings(); });
  $('pressure').addEventListener('change', e => { S.pressure = e.target.checked; saveSettings(); });
  $('penOnly').addEventListener('change', e => { S.penOnly = e.target.checked; saveSettings(); });
  $('soundOn').addEventListener('change', e => { S.sound = e.target.checked; saveSettings(); if (S.sound) { Sound.unlock(); Sound.brick(1); } });
  $('soundVol').addEventListener('input', e => { S.soundVol = +e.target.value; saveSettings(); Sound.volume(); });
  $('soundVol').addEventListener('change', () => { Sound.unlock(); Sound.brick(1); });
  $('toTitle').addEventListener('click', () => { closeSettings(); showTitle(); });
  const showIdle = () => { $('idleOut').textContent = S.idleSecs > 0 ? S.idleSecs + ' s' : 'off'; };
  $('idleSecs').addEventListener('input', e => { S.idleSecs = +e.target.value; showIdle(); saveSettings(); armIdle(); });

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
      const free = document.createElement('label'); free.className = 'free-toggle';
      free.title = 'Let this colour paint outside the map';
      const fc = document.createElement('input'); fc.type = 'checkbox'; fc.checked = !!c.free;
      fc.addEventListener('change', () => { c.free = fc.checked; saveSettings(); });
      free.append(fc, document.createTextNode('Outside'));
      row.append(pick, name, free, del);
      colorList.appendChild(row);
    });
    $('addColor').disabled = S.colors.length >= 16;
  }
  $('addColor').addEventListener('click', () => {
    if (S.colors.length >= 16) return;
    const h = Math.floor(Math.random() * 360);
    S.colors.push({ name: 'Colour ' + (S.colors.length + 1), hex: hslToHex(h, 70, 50), free: false });
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
  function getCount() { try { return parseInt(localStorage.getItem(COUNT_KEY) || '0', 10) || 0; } catch (_) { return 0; } }
  function setCount(n) { try { localStorage.setItem(COUNT_KEY, String(n)); } catch (_) {} }
  const pad = (n, l = 2) => String(n).padStart(l, '0');

  function savePainting() {
    if (stroke) return;
    const out = document.createElement('canvas');
    // saved image = the area the (rotated / scaled) map covers
    const { rot, cw, ch, ew, eh, cx, cy } = mapTf();
    const x0 = Math.max(0, Math.round(cx - ew / 2)), y0 = Math.max(0, Math.round(cy - eh / 2));
    const x1 = Math.min(world.w, Math.round(cx + ew / 2)), y1 = Math.min(world.h, Math.round(cy + eh / 2));
    out.width = x1 - x0; out.height = y1 - y0;
    const o = out.getContext('2d');
    o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height);
    const bg = () => {
      if (!bgImage) return;
      o.save(); o.globalAlpha = S.bgOpacity;
      o.translate(cx - x0, cy - y0); o.rotate(rot);
      o.drawImage(bgImage, -cw / 2, -ch / 2, cw, ch);
      o.restore();
    };
    if (!S.outlinesTop) bg();
    o.drawImage(paint, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    if (S.outlinesTop) { o.globalCompositeOperation = 'multiply'; bg(); o.globalCompositeOperation = 'source-over'; }
    out.toBlob(blob => {
      if (!blob) return;
      const n = getCount() + 1; setCount(n);
      const t = new Date();
      const stamp = t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()) + '-' + pad(t.getHours()) + pad(t.getMinutes()) + pad(t.getSeconds());
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'PaintYourPanaji_' + pad(n, 4) + '_' + stamp + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      flash('Saved! #' + n, '#2e9b4f');
      Sound.saved();
      $('saveCount').textContent = n;
      const btn = $('saveBtn'); btn.classList.remove('done'); void btn.offsetWidth; btn.classList.add('done');
      if (Tour.active) Tour.event('save');
    }, 'image/png');
  }
  $('saveImage').addEventListener('click', savePainting);
  $('saveBtn').addEventListener('click', savePainting);
  $('resetCount').addEventListener('click', () => { setCount(0); $('saveCount').textContent = 0; });
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
    $('mapRotate').value = S.mapRotate;
    $('mapScale').value = Math.round(S.mapScale * 100);
    showMapTf();
    $('outlinesTop').checked = S.outlinesTop;
    $('brushSize').value = S.brushSize;
    $('sizeOut').textContent = S.brushSize;
    $('pressure').checked = S.pressure;
    $('penOnly').checked = S.penOnly;
    $('soundOn').checked = S.sound;
    $('soundVol').value = S.soundVol;
    $('saveCount').textContent = getCount();
    $('idleSecs').value = S.idleSecs;
    showIdle();
    showBgRows();
    renderColorEditor();
  }

  // ---------- Sound: synthesized heavy bricks (no audio files) ----------
  const Sound = (() => {
    let ac = null, out = null, noise = null;
    const rnd = (a, b) => a + Math.random() * (b - a);

    function init() {
      if (ac) return true;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ac = new AC();
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.002; comp.release.value = 0.15;
      out = ac.createGain();
      out.connect(comp); comp.connect(ac.destination);
      volume();
      // 2 s of brown-ish noise: rougher and heavier than white noise
      noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const d = noise.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.06 * w) / 1.06;
        d[i] = w * 0.55 + last * 3.2;
      }
      return true;
    }
    function unlock() { if (init() && ac.state === 'suspended') ac.resume(); }
    function volume() { if (out) out.gain.value = 0.9 * (S.soundVol ?? 0.8); }

    function env(g, t, peak, attack, decay) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    }
    function burst(t, type, freq, q, peak, decay, rate = 1) {
      const src = ac.createBufferSource(); src.buffer = noise; src.playbackRate.value = rate;
      const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ac.createGain(); env(g, t, peak, 0.002, decay);
      src.connect(f); f.connect(g); g.connect(out);
      src.start(t, Math.random() * 1.6); src.stop(t + decay + 0.05);
    }
    function thump(t, f0, peak, decay) {
      const o = ac.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f0 * 2.2, t);
      o.frequency.exponentialRampToValueAtTime(f0, t + 0.035);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + decay);
      const g = ac.createGain(); env(g, t, peak, 0.003, decay);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + decay + 0.05);
    }

    // One brick landing: a low body thump, a gritty stony clack, and sometimes a smaller settle knock.
    function brick(strength = 1) {
      if (!S.sound || !ac || ac.state !== 'running') return;
      const t = ac.currentTime + 0.004, v = strength * rnd(0.8, 1.05);
      thump(t, rnd(52, 88), 0.95 * v, rnd(0.18, 0.3));                       // weight
      burst(t, 'lowpass', rnd(380, 700), 0.7, 0.55 * v, rnd(0.09, 0.16), rnd(0.6, 0.9));   // dull body
      burst(t, 'bandpass', rnd(900, 1900), rnd(0.9, 1.8), 0.45 * v, rnd(0.04, 0.08), rnd(0.9, 1.3)); // clack
      burst(t, 'highpass', rnd(2600, 4200), 0.7, 0.12 * v, rnd(0.02, 0.045)); // grit
      if (Math.random() < 0.55) {                                             // settles into place
        const t2 = t + rnd(0.06, 0.15), v2 = v * rnd(0.25, 0.45);
        thump(t2, rnd(70, 110), 0.5 * v2, rnd(0.08, 0.14));
        burst(t2, 'bandpass', rnd(1200, 2600), 1.4, 0.4 * v2, rnd(0.03, 0.06));
      }
      if (Math.random() < 0.25) burst(t + rnd(0.02, 0.2), 'highpass', rnd(3000, 5000), 1, 0.07 * v, 0.03); // pebble
    }
    function pick() {          // light tap when choosing a colour
      if (!S.sound || !ac || ac.state !== 'running') return;
      const t = ac.currentTime + 0.003;
      burst(t, 'bandpass', rnd(1800, 2400), 2.5, 0.22, 0.05);
      thump(t, rnd(140, 170), 0.18, 0.08);
    }
    function saved() {         // a little stack of three bricks
      if (!S.sound || !ac || ac.state !== 'running') return;
      [0, 0.13, 0.26].forEach((d, i) => setTimeout(() => brick(0.75 + i * 0.12), d * 1000));
    }
    return { unlock, brick, pick, saved, volume };
  })();

  // ---------- Title screen ----------
  const titleEl = $('title');
  function renderTitleBricks() {
    const el = $('titleBricks'); if (!el) return;
    el.innerHTML = '';
    S.colors.slice(0, 12).forEach((c, i) => {
      const b = document.createElement('span');
      b.style.background = c.hex;
      b.style.animationDelay = (0.25 + i * 0.07) + 's';
      el.appendChild(b);
    });
  }
  function goFullscreen() {
    const el = document.documentElement;
    const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
    if (!standalone && !document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  let titleTimer = 0;
  function hideTitle() {
    clearTimeout(titleTimer);
    document.body.classList.remove('title-on');
    if (titleEl.classList.contains('idle')) {            // fade the overlay away, painting untouched
      titleEl.classList.remove('show');
      titleTimer = setTimeout(() => { titleEl.hidden = true; titleEl.classList.remove('idle'); }, 450);
    } else {
      titleEl.hidden = true;
      setTimeout(layout, 60);
    }
    armIdle();
  }
  function showTitle() {
    Tour.stop();
    clearTimeout(titleTimer);
    titleEl.classList.remove('idle', 'show');
    titleEl.hidden = false;
    document.body.classList.add('title-on');
  }

  // ---------- Idle: fade Begin / How to play back in over the painting ----------
  let idleTimer = 0;
  function armIdle() {
    clearTimeout(idleTimer);
    if (S.idleSecs > 0) idleTimer = setTimeout(goIdle, S.idleSecs * 1000);
  }
  function goIdle() {
    if (!titleEl.hidden || stroke || Tour.active || !sheet.hidden) return armIdle();
    clearTimeout(titleTimer);
    titleEl.classList.add('idle');
    titleEl.classList.remove('show');
    titleEl.hidden = false;
    void titleEl.offsetWidth;                            // let the fade-in run
    titleEl.classList.add('show');
    document.body.classList.add('title-on');
  }
  ['pointerdown', 'pointermove', 'keydown', 'wheel'].forEach(ev =>
    window.addEventListener(ev, () => { if (titleEl.hidden) armIdle(); }, { passive: true, capture: true }));
  // tapping empty space on the idle overlay goes back to the painting
  titleEl.addEventListener('click', e => { if (titleEl.classList.contains('idle') && !e.target.closest('button')) hideTitle(); });
  $('beginBtn').addEventListener('click', () => { Sound.unlock(); goFullscreen(); hideTitle(); setTimeout(() => Sound.brick(1), 60); });
  $('howBtn').addEventListener('click', () => { Sound.unlock(); goFullscreen(); hideTitle(); setTimeout(() => Tour.start(), 450); });

  // Map's bounding box on screen (for the tour spotlight)
  function mapScreenRect() {
    const t = mapTf(), v = view;
    const x = v.x + (t.cx - t.ew / 2) * v.s, y = v.y + (t.cy - t.eh / 2) * v.s;
    const r = { x, y, w: t.ew * v.s, h: t.eh * v.s };
    const x0 = Math.max(6, r.x), y0 = Math.max(6, r.y);
    const x1 = Math.min(innerWidth - 6, r.x + r.w), y1 = Math.min(innerHeight - 6, r.y + r.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---------- Guided tour ----------
  const Tour = (() => {
    const root = $('tour'), spot = $('tourSpot'), card = $('tourCard');
    const steps = [
      { target: () => paletteEl.getBoundingClientRect(), title: 'Pick a colour',
        text: 'Tap any colour. Its name flashes up on the screen.', hint: 'Try it now: tap a colour.', wait: 'color' },
      { target: () => mapScreenRect(), title: 'Paint inside Panaji',
        text: 'Draw with your finger or a pen. The paint stays inside the outline of the city.', hint: 'Try it now: draw a line on the map.', wait: 'stroke', pad: 4 },
      { target: () => $('history').getBoundingClientRect(), title: 'Oops? Undo it',
        text: 'Undo takes back your last stroke. Redo puts it back.' },
      { target: () => $('clearBtn').getBoundingClientRect(), title: 'Start again',
        text: 'Clear wipes the whole painting so you can begin fresh.' },
      { target: () => $('saveBtn').getBoundingClientRect(), title: 'Save your Panaji',
        text: 'When you’re happy with it, tap Save! Your painting is kept on this tablet.' },
    ];
    let i = 0, active = false, waitTimer = 0;

    function place() {
      if (!active) return;
      const st = steps[i], b = st.target(), p = st.pad ?? 10;
      const r = { x: b.x ?? b.left, y: b.y ?? b.top, w: b.w ?? b.width, h: b.h ?? b.height };
      Object.assign(spot.style, { left: (r.x - p) + 'px', top: (r.y - p) + 'px', width: (r.w + 2 * p) + 'px', height: (r.h + 2 * p) + 'px' });
      $('tourStep').textContent = (i + 1) + ' of ' + steps.length;
      $('tourTitle').textContent = st.title;
      $('tourText').textContent = st.text;
      $('tourHint').textContent = st.hint || '';
      $('tourNext').textContent = i === steps.length - 1 ? 'Start painting' : 'Next';
      // card: below the target if there is room, else above, else top of screen
      const cw = Math.min(360, innerWidth - 24);
      card.style.width = cw + 'px';
      const ch = card.offsetHeight || 200, gap = 18;
      let top;
      if (r.y + r.h + p + gap + ch < innerHeight - 8) top = r.y + r.h + p + gap;
      else if (r.y - p - gap - ch > 8) top = r.y - p - gap - ch;
      else top = 16;
      let left = r.x + r.w / 2 - cw / 2;
      left = Math.max(12, Math.min(innerWidth - cw - 12, left));
      card.style.top = top + 'px'; card.style.left = left + 'px';
    }
    function go(n) {
      clearTimeout(waitTimer);
      if (n >= steps.length) return stop();
      i = Math.max(0, n);
      card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop');
      place();
    }
    function start() { active = true; root.hidden = false; document.body.classList.add('touring'); go(0); }
    function stop() {
      active = false; root.hidden = true; clearTimeout(waitTimer);
      document.body.classList.remove('touring');
    }
    function event(name) {
      if (!active || steps[i].wait !== name) return;
      $('tourHint').textContent = 'Nice!';
      clearTimeout(waitTimer);
      waitTimer = setTimeout(() => go(i + 1), name === 'color' ? 1100 : 700);
    }
    $('tourNext').addEventListener('click', () => go(i + 1));
    $('tourSkip').addEventListener('click', stop);
    window.addEventListener('resize', () => setTimeout(place, 120));
    return { start, stop, event, get active() { return active; } };
  })();

  // ---------- Boot ----------
  renderPalette();
  syncSettingsUI();
  updateHistoryButtons();
  layout();
  applyBackground();

  // Debug/test hook
  window.PaintY = { undo, redo, clearCanvas, savePainting, isInsideMap, mapScreenRect,
    state: () => ({ ops: ops.length, redo: redoStack.length, world, view, maskValid, count: getCount() }) };
})();
