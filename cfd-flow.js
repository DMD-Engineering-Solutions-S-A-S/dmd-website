/*
 * cfd-flow.js — "Fluido interactivo CFD" para el Hero de DMD Engineering Solutions.
 *
 * Qué hace: dibuja líneas de corriente (streamlines) sobre un <canvas> 2D usando el
 * campo de velocidades analítico del flujo potencial alrededor de un cilindro:
 *
 *     u = U∞ · (1 − a²(x² − y²) / r⁴)        v = −U∞ · 2a²·x·y / r⁴
 *
 * El cursor mueve el obstáculo (radio a); las partículas se advectan por el campo
 * (integración RK2) y dejan una estela que se desvanece. El color depende de |V|/U∞
 * (azul = remanso / baja velocidad → cian → verde = aceleración en los hombros).
 *
 * Sin dependencias, sin WebGL, sin red. ~4 KB. Ver notas de rendimiento al final.
 */
(function () {
  'use strict';

  var hero = document.getElementById('inicio');
  var canvas = document.getElementById('cfdCanvas');
  var ball = document.getElementById('cfdBall');
  if (!hero || !canvas || !canvas.getContext) return;

  var ctx = canvas.getContext('2d');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Parámetros físicos / visuales -------------------------------------------------
  var A = 42;            // radio del obstáculo (px)
  var U = 130;           // velocidad de corriente libre (px/s)
  var ROW_GAP = 26;      // separación entre líneas de corriente (px)
  var PER_ROW = 4;       // partículas por línea
  var FADE = 0.045;      // desvanecimiento de la estela por frame (menor = estela más larga)
  var LINE_ALPHA = 0.55;

  // Paleta del isotipo: azul → cian → verde
  var STOPS = [[37, 99, 235], [34, 211, 238], [52, 211, 153]];
  var BUCKETS = 16, colors = [];
  (function buildColors() {
    for (var i = 0; i < BUCKETS; i++) {
      var t = i / (BUCKETS - 1) * (STOPS.length - 1);
      var k = Math.min(Math.floor(t), STOPS.length - 2), f = t - k;
      var a = STOPS[k], b = STOPS[k + 1];
      colors.push('rgba(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' +
                            Math.round(a[1] + (b[1] - a[1]) * f) + ',' +
                            Math.round(a[2] + (b[2] - a[2]) * f) + ',' + LINE_ALPHA + ')');
    }
  })();

  // ---- Estado ------------------------------------------------------------------------
  var W = 0, H = 0, dpr = 1;
  var rows = [], parts = [];
  var pos = { x: 0, y: 0 }, target = { x: 0, y: 0 };
  var lastMove = -1e9;
  var visible = true, running = false, raf = 0, lastTs = 0;
  var vel = { u: 0, v: 0 };

  // Campo de velocidades (flujo potencial alrededor de un cilindro en pos)
  function field(x, y, o) {
    var dx = x - pos.x, dy = y - pos.y, r2 = dx * dx + dy * dy, a2 = A * A;
    if (r2 < a2 * 1.05) { o.u = 0; o.v = 0; return false; }   // dentro del obstáculo
    var k = a2 / (r2 * r2);
    o.u = U * (1 - k * (dx * dx - dy * dy));
    o.v = -U * 2 * k * dx * dy;
    return true;
  }

  function spawn(p, anywhere) {
    p.x = anywhere ? Math.random() * W : -8 - Math.random() * 40;
    p.y = rows[(Math.random() * rows.length) | 0] + (Math.random() - 0.5) * 4;
    p.px = p.x; p.py = p.y;
  }

  function resize() {
    var w = hero.clientWidth, h = hero.clientHeight;
    if (!w || !h) return;
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = w; H = h;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    rows = [];
    for (var y = ROW_GAP / 2; y < H; y += ROW_GAP) rows.push(y);
    var n = rows.length * PER_ROW;
    if (W < 640) n = Math.round(n * 0.7);          // menos partículas en móvil
    parts = [];
    for (var i = 0; i < n; i++) { var p = {}; spawn(p, true); parts.push(p); }

    if (!lastMoveRecent()) { pos.x = target.x = W * 0.68; pos.y = target.y = H * 0.5; }
    if (reduceMotion) drawStatic();
  }

  function lastMoveRecent() { return performance.now() - lastMove < 2500; }

  function colorFor(speed) {
    var s = speed / U;                               // 0 … ~2
    var i = Math.max(0, Math.min(BUCKETS - 1, Math.round(s / 2 * (BUCKETS - 1))));
    return colors[i];
  }

  function placeBall() {
    if (ball) ball.style.transform = 'translate3d(' + (pos.x - A) + 'px,' + (pos.y - A) + 'px,0)';
  }

  // ---- Bucle de animación ------------------------------------------------------------
  function frame(ts) {
    raf = 0;
    if (!running) return;
    var dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016;
    lastTs = ts;

    // Obstáculo: sigue al cursor; en reposo deriva suavemente (Lissajous)
    if (!lastMoveRecent()) {
      target.x = W * (0.5 + 0.3 * Math.sin(ts * 0.00021));
      target.y = H * (0.5 + 0.22 * Math.sin(ts * 0.00033 + 1.2));
    }
    var ease = 1 - Math.exp(-dt * 6);
    pos.x += (target.x - pos.x) * ease;
    pos.y += (target.y - pos.y) * ease;
    placeBall();

    // Desvanecer estelas
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,' + FADE + ')';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';

    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      p.px = p.x; p.py = p.y;

      // RK2 (punto medio)
      if (!field(p.x, p.y, vel)) { spawn(p, false); continue; }
      var mx = p.x + vel.u * dt * 0.5, my = p.y + vel.v * dt * 0.5;
      var u1 = vel.u, v1 = vel.v;
      if (field(mx, my, vel)) { u1 = vel.u; v1 = vel.v; }
      p.x += u1 * dt; p.y += v1 * dt;

      if (p.x > W + 10 || p.y < -10 || p.y > H + 10) { spawn(p, false); continue; }

      ctx.strokeStyle = colorFor(Math.sqrt(u1 * u1 + v1 * v1));
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduceMotion || !visible || document.hidden) return;
    running = true; lastTs = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  // ---- Modo "movimiento reducido": un solo cuadro estático ---------------------------
  function drawStatic() {
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1.1;
    var o = { u: 0, v: 0 };
    for (var r = 0; r < rows.length; r++) {
      var x = 0, y = rows[r], px = x, py = y;
      for (var s = 0; s < 400 && x < W + 10; s++) {
        if (!field(x, y, o)) break;
        var sp = Math.sqrt(o.u * o.u + o.v * o.v) || 1;
        x += o.u / sp * 6; y += o.v / sp * 6;
        ctx.strokeStyle = colorFor(sp);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
        px = x; py = y;
      }
    }
    placeBall();
  }

  // ---- Eventos -----------------------------------------------------------------------
  hero.addEventListener('pointermove', function (e) {
    var r = hero.getBoundingClientRect();
    target.x = e.clientX - r.left;
    target.y = e.clientY - r.top;
    lastMove = performance.now();
    if (reduceMotion) { pos.x = target.x; pos.y = target.y; drawStatic(); }
  }, { passive: true });
  hero.addEventListener('pointerleave', function () { lastMove = -1e9; }, { passive: true });

  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(hero);
  else window.addEventListener('resize', resize);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      visible ? start() : stop();
    }, { threshold: 0 }).observe(hero);
  }
  document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });

  resize();
  start();

  /*
   * Rendimiento
   *  - Una sola capa <canvas> 2D, DPR limitado a 1.5, ~100-140 partículas (≈70 % en móvil).
   *  - Se pausa fuera de pantalla (IntersectionObserver) y con la pestaña oculta.
   *  - prefers-reduced-motion: un cuadro estático, sin bucle ni listeners de animación.
   *  - Sin librerías ni peticiones de red: el script vive en el mismo dominio (Vercel).
   */
})();
