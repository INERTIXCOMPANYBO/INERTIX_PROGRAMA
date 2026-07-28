/**
 * LiquidTextEffect v2 — Displacement líquido de títulos en WebGL a resolución nativa.
 *
 * POR QUÉ SE COLGABA LA VERSIÓN ANTERIOR (no era "falta de gráficos"):
 *   1. Generaba un PNG por cuadro y por título con canvas.toBlob() → 6 títulos x 60 FPS
 *      = 360 codificaciones PNG por segundo + 360 Blob URLs creadas y revocadas.
 *   2. Cambiaba el href de un <feImage> cada cuadro: el navegador vuelve a decodificar
 *      la imagen y re-rasteriza TODO el filtro SVG sobre un texto enorme. Ese es el cuelgue.
 *   3. El requestAnimationFrame nunca se suspendía: 6 bucles vivos para siempre.
 *
 * POR QUÉ SE VEÍA PIXELADO (el "no es full HD"):
 *   El mapa de desplazamiento tenía como máximo 130x65 celdas estiradas sobre un título de
 *   ~1000 px → bloques de ~8 px. Además la ola se resolvía en enteros (Int16 + >>1), lo que
 *   escalona la onda.
 *
 * CÓMO FUNCIONA AHORA:
 *   - El texto se rasteriza UNA vez a devicePixelRatio (full HD / retina) usando la posición
 *     exacta que el navegador ya calculó (Range.getClientRects), así respeta saltos de línea,
 *     <em> naranja, kerning y letter-spacing negativo.
 *   - La ola se resuelve en Float32 sobre una malla fina (celda ~4.5 px) y se sube a la GPU
 *     como textura de 4 bytes por celda: cero PNG, cero Blob, cero filtros SVG.
 *   - Un shader hace el desplazamiento con interpolación bilineal + brillo especular y una
 *     aberración cromática mínima: el líquido queda continuo, no en bloques.
 *   - Un solo requestAnimationFrame global para todos los títulos, que se APAGA de verdad
 *     cuando el agua vuelve al reposo (0% CPU) y despierta al pasar el puntero.
 *   - Sin dependencias externas (three.js ya no hace falta). Compatible con GitHub Pages.
 *   - El texto real sigue en el DOM (SEO y lectores de pantalla intactos).
 */

(function () {
  'use strict';

  var CONFIG = {
    maxDPR: 2,            // 2 = nítido en pantallas retina sin disparar el costo
    padding: 28,          // px CSS de aire alrededor para que la ola no se recorte
    cellSize: 4.5,        // px CSS por celda de simulación (menor = más suave)
    maxCells: 45000,      // techo de la malla (protege equipos modestos)
    damping: 0.958,       // amortiguación de la ola
    fixedStep: 1 / 60,    // paso fijo: mismo comportamiento a 60 y a 120 Hz
    maxSubSteps: 3,
    maxDisplacement: 12,  // px CSS de desplazamiento máximo
    dispGain: 0.09,       // unidades de ola → px de desplazamiento
    specular: 0.20,       // brillo tipo cristal mojado
    aberration: 0.045,    // refracción cromática (sutil)
    restAmp: 0.12,        // px de desplazamiento por debajo de los cuales se duerme (invisible)
    impactForceMin: 70,
    impactForceMax: 300
  };

  var VERT_SRC = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main(){',
    '  vUv = vec2(aPos.x, 1.0 - aPos.y);',
    '  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG_SRC = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform sampler2D uText;',
    'uniform sampler2D uWave;',
    'uniform vec2 uTexel;',   // 1 / tamaño del lienzo en px CSS
    'uniform float uAmp;',    // amplitud del desplazamiento en px CSS
    'uniform float uSpec;',
    'uniform float uAber;',
    'varying vec2 vUv;',
    'void main(){',
    '  vec3 w = texture2D(uWave, vUv).rgb;',
    '  vec2 g = w.rg * 2.0 - 1.0;',
    '  vec2 d = g * uAmp * uTexel;',
    '  vec4 c = texture2D(uText, vUv + d);',
    '  if (uAber > 0.0) {',
    '    c.r = texture2D(uText, vUv + d * (1.0 + uAber)).r;',
    '    c.b = texture2D(uText, vUv + d * (1.0 - uAber)).b;',
    '  }',
    // luz desde arriba a la izquierda sobre la pendiente de la ola
    '  float spec = max(0.0, g.x * 0.6 - g.y * 0.8);',
    '  c.rgb = min(c.rgb + spec * spec * uSpec * c.a, vec3(c.a));',
    '  gl_FragColor = c;',
    '}'
  ].join('\n');

  // ——————————————————————————————————————————————
  // Bucle global: un solo rAF para todos los títulos
  // ——————————————————————————————————————————————
  var running = new Set();
  var rafId = 0;
  var lastTime = 0;

  function frame(now) {
    rafId = 0;
    var dt = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : CONFIG.fixedStep;
    lastTime = now;

    running.forEach(function (inst) {
      if (!inst.step(dt)) running.delete(inst);
    });

    if (running.size) rafId = requestAnimationFrame(frame);
    else lastTime = 0;
  }

  function wake(inst) {
    if (running.has(inst)) return;
    running.add(inst);
    if (!rafId) {
      lastTime = 0;
      rafId = requestAnimationFrame(frame);
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
      lastTime = 0;
    } else if (!document.hidden && running.size && !rafId) {
      rafId = requestAnimationFrame(frame);
    }
  });

  // ——————————————————————————————————————————————
  // Estilos de apoyo (una sola vez)
  // ——————————————————————————————————————————————
  function injectStyles() {
    if (document.getElementById('liquid-text-style')) return;
    var st = document.createElement('style');
    st.id = 'liquid-text-style';
    // color transparente en lugar de visibility:hidden: el título sigue recibiendo
    // el puntero, sigue siendo seleccionable y sigue existiendo para el lector de pantalla.
    st.textContent =
      '.liquid-text-off, .liquid-text-off *{color:transparent!important;text-shadow:none!important;}' +
      '.liquid-text-canvas{position:absolute;pointer-events:none;visibility:visible;}';
    document.head.appendChild(st);
  }

  // ——————————————————————————————————————————————
  // Rasterizado del texto usando la maquetación real del navegador
  // ——————————————————————————————————————————————
  var letterSpacingOK = (function () {
    try {
      var c = document.createElement('canvas').getContext('2d');
      if (!('letterSpacing' in c)) return false;
      c.letterSpacing = '-4px';
      return c.letterSpacing === '-4px';
    } catch (e) {
      return false;
    }
  })();

  function fontOf(cs) {
    return cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
  }

  /**
   * Devuelve la distancia entre el borde superior del rectángulo del texto y su línea base.
   * Se calibra con un <span> vacío de altura 0 alineado a la línea base (técnica exacta);
   * si ese span cae en otra línea (texto que envuelve), se usa la métrica de la fuente.
   */
  function baselineOffset(node, ctx, font, probeRect) {
    var marker = document.createElement('span');
    marker.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden;vertical-align:baseline;';
    var offset = null;
    try {
      node.parentNode.insertBefore(marker, node);
      var mTop = marker.getBoundingClientRect().top;
      if (mTop >= probeRect.top - 1 && mTop <= probeRect.bottom + 1) offset = mTop - probeRect.top;
    } catch (e) {
      offset = null;
    }
    if (marker.parentNode) marker.parentNode.removeChild(marker);

    if (offset === null) {
      ctx.font = font;
      var m = ctx.measureText('Hxg');
      if (m.fontBoundingBoxAscent) offset = m.fontBoundingBoxAscent;
      else offset = probeRect.height * 0.8;
    }
    return offset;
  }

  function collectRuns(el, ctx) {
    var base = el.getBoundingClientRect();
    var runs = [];
    var bounds = { top: Infinity, bottom: -Infinity };
    var nodes = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return n.nodeValue && /\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var n;
    while ((n = walker.nextNode())) nodes.push(n);

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var cs = window.getComputedStyle(node.parentElement);
      var font = fontOf(cs);
      var color = cs.color;
      var spacing = parseFloat(cs.letterSpacing) || 0;
      var range = document.createRange();
      var first = null;
      var words = [];

      // Localiza cada palabra y su rectángulo real (ya con kerning y letter-spacing aplicados)
      var re = /\S+/g;
      var m;
      while ((m = re.exec(node.nodeValue))) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        var rects = range.getClientRects();
        if (!rects.length) continue;
        if (!first) first = rects[0];

        if (rects.length === 1 && letterSpacingOK) {
          words.push({ text: m[0], rect: rects[0] });
        } else {
          // Palabra partida entre líneas, o navegador sin letterSpacing en canvas:
          // se posiciona carácter por carácter con las coordenadas del propio navegador.
          for (var k = 0; k < m[0].length; k++) {
            range.setStart(node, m.index + k);
            range.setEnd(node, m.index + k + 1);
            var cr = range.getClientRects();
            if (cr.length) words.push({ text: m[0].charAt(k), rect: cr[0], single: true });
          }
        }
      }
      if (!words.length) continue;

      var ascent = baselineOffset(node, ctx, font, first);

      for (var w = 0; w < words.length; w++) {
        var wr = words[w].rect;
        var top = wr.top - base.top;
        if (top < bounds.top) bounds.top = top;
        if (top + wr.height > bounds.bottom) bounds.bottom = top + wr.height;
        runs.push({
          text: words[w].text,
          font: font,
          color: color,
          spacing: words[w].single ? 0 : spacing,
          x: wr.left - base.left,
          y: top + ascent
        });
      }
    }
    return { runs: runs, bounds: bounds };
  }

  // ——————————————————————————————————————————————
  // Un título líquido
  // ——————————————————————————————————————————————
  function LiquidTitle(el) {
    this.el = el;
    this.ready = false;
    this.dead = false;
    this.pointerOver = false;
    this.prevX = 0;
    this.prevY = 0;
    this.hasPrev = false;
    this.accum = 0;
    this.amp = 0;
    this.textCanvas = document.createElement('canvas');
    this.textCtx = this.textCanvas.getContext('2d');
    this.bindEvents();
  }

  LiquidTitle.prototype.bindEvents = function () {
    var self = this;

    function onMove(clientX, clientY) {
      if (!self.ready) { self.init(); if (!self.ready) return; }
      var r = self.el.getBoundingClientRect();
      var x = clientX - r.left + CONFIG.padding;
      var y = clientY - r.top + CONFIG.padding;

      if (self.hasPrev) {
        var dx = x - self.prevX;
        var dy = y - self.prevY;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var force = Math.min(CONFIG.impactForceMax, Math.max(CONFIG.impactForceMin, dist * 14));
        // Interpolar a lo largo del trazo: sin huecos aunque el puntero vaya rápido
        var steps = Math.max(1, Math.min(14, Math.ceil(dist / (self.cellW * 1.2))));
        var each = Math.max(18, force / steps);
        for (var s = 1; s <= steps; s++) {
          var t = s / steps;
          self.applyForce(self.prevX + dx * t, self.prevY + dy * t, each);
        }
      } else {
        self.applyForce(x, y, CONFIG.impactForceMin);
      }

      self.prevX = x;
      self.prevY = y;
      self.hasPrev = true;
      self.pointerOver = true;
      wake(self);
    }

    this.el.addEventListener('pointerenter', function (e) {
      var r = self.el.getBoundingClientRect();
      self.prevX = e.clientX - r.left + CONFIG.padding;
      self.prevY = e.clientY - r.top + CONFIG.padding;
      self.hasPrev = true;
      self.pointerOver = true;
      if (!self.ready) self.init();
    });

    this.el.addEventListener('pointermove', function (e) {
      onMove(e.clientX, e.clientY);
    }, { passive: true });

    // pointerleave cubre también el final del toque en móvil
    this.el.addEventListener('pointerleave', function () {
      self.pointerOver = false;
      self.hasPrev = false;
    });

    this.el.addEventListener('pointercancel', function () {
      self.pointerOver = false;
      self.hasPrev = false;
    });
  };

  // —— Geometría, malla y lienzos ——
  LiquidTitle.prototype.measure = function () {
    var pad = CONFIG.padding;
    this.cssW = this.el.offsetWidth + pad * 2;
    this.cssH = this.el.offsetHeight + pad * 2;
    if (this.cssW < 8 || this.cssH < 8) return false;

    var dpr = Math.min(CONFIG.maxDPR, window.devicePixelRatio || 1);
    if (this.gl) {
      var maxTex = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
      var need = Math.max(this.cssW, this.cssH) * dpr;
      if (need > maxTex) dpr = Math.max(1, dpr * (maxTex / need));
    }
    this.dpr = dpr;
    this.pxW = Math.round(this.cssW * dpr);
    this.pxH = Math.round(this.cssH * dpr);

    // Malla de simulación: fina, pero acotada por maxCells
    var cell = CONFIG.cellSize;
    var cols = Math.ceil(this.cssW / cell) + 1;
    var rows = Math.ceil(this.cssH / cell) + 1;
    if (cols * rows > CONFIG.maxCells) {
      var f = Math.sqrt((cols * rows) / CONFIG.maxCells);
      cols = Math.max(24, Math.floor(cols / f));
      rows = Math.max(16, Math.floor(rows / f));
    }
    this.cols = cols;
    this.rows = rows;
    this.cellW = this.cssW / cols;
    this.cellH = this.cssH / rows;
    this.size = cols * rows;

    this.hCur = new Float32Array(this.size);
    this.hPrev = new Float32Array(this.size);
    this.gradX = new Float32Array(this.size);
    this.gradY = new Float32Array(this.size);
    this.wavePixels = new Uint8Array(this.size * 4);

    // Radio del impacto proporcional al tamaño tipográfico
    var fs = parseFloat(window.getComputedStyle(this.el).fontSize) || 40;
    this.impactRadius = Math.max(10, Math.min(46, fs * 0.22));
    return true;
  };

  LiquidTitle.prototype.raster = function () {
    var wasOff = this.el.classList.contains('liquid-text-off');
    if (wasOff) this.el.classList.remove('liquid-text-off'); // medir con los colores reales

    var data = collectRuns(this.el, this.textCtx);
    var runs = data.runs;

    if (wasOff) this.el.classList.add('liquid-text-off');
    if (!runs.length) return false;
    this.bounds = data.bounds;

    var pad = CONFIG.padding;
    this.textCanvas.width = this.pxW;
    this.textCanvas.height = this.pxH;
    var ctx = this.textCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      ctx.font = r.font;
      if (letterSpacingOK) ctx.letterSpacing = r.spacing ? r.spacing + 'px' : '0px';
      ctx.fillStyle = r.color;
      ctx.fillText(r.text, r.x + pad, r.y + pad);
    }
    return true;
  };

  /**
   * Red de seguridad: comprueba en una miniatura de 64x32 que el texto pintado existe y cae
   * donde el navegador lo tiene maquetado. Si algo saliera mal (fuente rara, métricas raras),
   * es preferible quedarse sin efecto que dejar un título en blanco.
   */
  LiquidTitle.prototype.sanityCheck = function () {
    if (!this.bounds || this.bounds.top === Infinity) return false;
    var W = 64, H = 32;
    var probe = document.createElement('canvas');
    probe.width = W;
    probe.height = H;
    var px = probe.getContext('2d');
    px.drawImage(this.textCanvas, 0, 0, W, H);
    var d;
    try {
      d = px.getImageData(0, 0, W, H).data;
    } catch (e) {
      return true; // sin acceso a los píxeles: no se puede juzgar, se deja pasar
    }

    var top = -1, bottom = -1;
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        if (d[(r * W + c) * 4 + 3] > 8) { if (top < 0) top = r; bottom = r; break; }
      }
    }
    if (top < 0) return false;                       // lienzo vacío

    var scale = this.cssH / H;
    var tol = scale + 8;
    var expTop = this.bounds.top + CONFIG.padding;
    var expBottom = this.bounds.bottom + CONFIG.padding;
    return (top * scale) >= expTop - tol && ((bottom + 1) * scale) <= expBottom + tol;
  };

  // —— WebGL ——
  LiquidTitle.prototype.initGL = function () {
    var canvas = document.createElement('canvas');
    canvas.className = 'liquid-text-canvas';
    canvas.setAttribute('aria-hidden', 'true');

    var gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power'
    }) || canvas.getContext('experimental-webgl');
    if (!gl) return false;

    this.canvas = canvas;
    this.gl = gl;

    var vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VERT_SRC);
    gl.compileShader(vs);
    var fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, FRAG_SRC);
    gl.compileShader(fs);
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);
    this.prog = prog;

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.uTexel = gl.getUniformLocation(prog, 'uTexel');
    this.uAmpLoc = gl.getUniformLocation(prog, 'uAmp');
    this.uSpecLoc = gl.getUniformLocation(prog, 'uSpec');
    this.uAberLoc = gl.getUniformLocation(prog, 'uAber');

    this.texText = this.makeTexture(gl);
    this.texWave = this.makeTexture(gl);
    gl.uniform1i(gl.getUniformLocation(prog, 'uText'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uWave'), 1);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);

    var self = this;
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      self.ready = false;
      self.el.classList.remove('liquid-text-off');
      running.delete(self);
    });
    canvas.addEventListener('webglcontextrestored', function () {
      // Se reconstruye todo sobre un lienzo nuevo; el anterior queda inservible
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      self.canvas = null;
      self.gl = null;
      self.ready = false;
      self.init();
    });
    return true;
  };

  LiquidTitle.prototype.makeTexture = function (gl) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  };

  LiquidTitle.prototype.uploadText = function () {
    var gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texText);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.textCanvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // El lienzo de texto ya vive en la GPU: liberar los megas del lado CPU
    this.textCanvas.width = this.textCanvas.height = 1;

    // 128 = pendiente cero: la textura de ola arranca en reposo (nunca en basura)
    this.wavePixels.fill(128);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texWave);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.cols, this.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.wavePixels);
    this.amp = 0;
  };

  LiquidTitle.prototype.init = function () {
    if (this.ready || this.dead) return;
    try {
      if (!this.gl && !this.initGL()) { this.dead = true; return; }
      if (!this.measure()) return;
      if (!this.raster()) return;
      if (!this.sanityCheck()) {
        this.dead = true;
        this.el.classList.remove('liquid-text-off');
        if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        return;
      }

      this.canvas.style.left = -CONFIG.padding + 'px';
      this.canvas.style.top = -CONFIG.padding + 'px';
      this.canvas.style.width = this.cssW + 'px';
      this.canvas.style.height = this.cssH + 'px';
      this.canvas.width = this.pxW;
      this.canvas.height = this.pxH;

      if (window.getComputedStyle(this.el).position === 'static') this.el.style.position = 'relative';
      if (this.canvas.parentNode !== this.el) this.el.appendChild(this.canvas);

      this.gl.viewport(0, 0, this.pxW, this.pxH);
      this.gl.uniform2f(this.uTexel, 1 / this.cssW, 1 / this.cssH);
      this.uploadText();

      this.ready = true;
      this.amp = 0;
      this.render();                          // primer cuadro sin distorsión
      this.el.classList.add('liquid-text-off'); // recién ahora se apaga el texto del DOM
    } catch (e) {
      this.dead = true;
      this.el.classList.remove('liquid-text-off');
      if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    }
  };

  LiquidTitle.prototype.refresh = function () {
    if (!this.ready || this.dead) return;
    var w = this.el.offsetWidth + CONFIG.padding * 2;
    var h = this.el.offsetHeight + CONFIG.padding * 2;
    if (Math.abs(w - this.cssW) < 1 && Math.abs(h - this.cssH) < 1) return;
    this.ready = false;
    running.delete(this);
    this.init();
  };

  // —— Física ——
  LiquidTitle.prototype.applyForce = function (x, y, strength) {
    if (!this.ready) return;
    var cx = x / this.cellW;
    var cy = y / this.cellH;
    var rx = this.impactRadius / this.cellW;
    var ry = this.impactRadius / this.cellH;
    var c0 = Math.max(1, Math.floor(cx - rx));
    var c1 = Math.min(this.cols - 2, Math.ceil(cx + rx));
    var r0 = Math.max(1, Math.floor(cy - ry));
    var r1 = Math.min(this.rows - 2, Math.ceil(cy + ry));
    var h = this.hCur;

    for (var r = r0; r <= r1; r++) {
      var dy = (r + 0.5 - cy) / ry;
      for (var c = c0; c <= c1; c++) {
        var dx = (c + 0.5 - cx) / rx;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d >= 1) continue;
        // caída suave (coseno elevado): gota redonda, sin bordes duros
        var f = Math.cos(d * Math.PI * 0.5);
        h[r * this.cols + c] += strength * f * f;
      }
    }
  };

  LiquidTitle.prototype.solve = function () {
    var cols = this.cols, rows = this.rows;
    var cur = this.hCur, prev = this.hPrev;
    var damp = CONFIG.damping;

    for (var r = 1; r < rows - 1; r++) {
      var idx = r * cols + 1;
      for (var c = 1; c < cols - 1; c++, idx++) {
        var v = (cur[idx - 1] + cur[idx + 1] + cur[idx - cols] + cur[idx + cols]) * 0.5 - prev[idx];
        v *= damp;
        prev[idx] = v;
      }
    }
    this.hCur = prev;
    this.hPrev = cur;
  };

  LiquidTitle.prototype.buildWaveTexture = function () {
    var cols = this.cols, rows = this.rows;
    var h = this.hCur, gx = this.gradX, gy = this.gradY;
    var gMax = 1e-4, hMax = 1e-4;
    var i, a;

    for (var r = 1; r < rows - 1; r++) {
      var idx = r * cols + 1;
      for (var c = 1; c < cols - 1; c++, idx++) {
        var dx = (h[idx + 1] - h[idx - 1]) * 0.5;
        var dy = (h[idx + cols] - h[idx - cols]) * 0.5;
        gx[idx] = dx;
        gy[idx] = dy;
        a = dx < 0 ? -dx : dx; if (a > gMax) gMax = a;
        a = dy < 0 ? -dy : dy; if (a > gMax) gMax = a;
        a = h[idx] < 0 ? -h[idx] : h[idx]; if (a > hMax) hMax = a;
      }
    }

    // Normalizar al máximo del cuadro: se aprovechan los 8 bits completos siempre,
    // así no aparecen escalones cuando la ola se va apagando.
    var px = this.wavePixels;
    var kg = 127 / gMax, kh = 127 / hMax;
    var n = this.size;
    for (i = 0; i < n; i++) {
      var p = i * 4;
      px[p] = 128 + (gx[i] * kg);
      px[p + 1] = 128 + (gy[i] * kg);
      px[p + 2] = 128 + (h[i] * kh);
      px[p + 3] = 255;
    }

    this.amp = Math.min(CONFIG.maxDisplacement, gMax * CONFIG.dispGain);

    var gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texWave);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, px);
  };

  LiquidTitle.prototype.render = function () {
    var gl = this.gl;
    var k = this.amp / CONFIG.maxDisplacement;
    gl.uniform1f(this.uAmpLoc, this.amp);
    gl.uniform1f(this.uSpecLoc, CONFIG.specular * k);
    gl.uniform1f(this.uAberLoc, CONFIG.aberration * k);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  /** Un cuadro. Devuelve false cuando el agua volvió al reposo y hay que dormir. */
  LiquidTitle.prototype.step = function (dt) {
    if (!this.ready || this.dead) return false;

    // Paso fijo: la misma física a 60 Hz y a 120 Hz
    this.accum = Math.min(0.25, this.accum + dt);
    var steps = Math.min(CONFIG.maxSubSteps, Math.floor(this.accum / CONFIG.fixedStep));
    if (steps < 1) return true;
    this.accum -= steps * CONFIG.fixedStep;

    for (var s = 0; s < steps; s++) this.solve();
    this.buildWaveTexture();

    // Criterio de reposo en píxeles reales: por debajo de restAmp el efecto ya no se ve.
    // Puede dormirse incluso con el puntero encima; el siguiente movimiento lo despierta.
    if (this.amp < CONFIG.restAmp) {
      this.hCur.fill(0);
      this.hPrev.fill(0);
      this.amp = 0;
      this.render();               // cuadro limpio: el título queda nítido, sin distorsión
      return false;                // ← aquí se apaga de verdad el rAF
    }

    this.render();
    return true;
  };

  // ——————————————————————————————————————————————
  // Arranque
  // ——————————————————————————————————————————————
  function boot() {
    var titles = document.querySelectorAll('.liquid-title');
    if (!titles.length) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    injectStyles();

    var instances = [];
    for (var i = 0; i < titles.length; i++) {
      var inst = new LiquidTitle(titles[i]);
      titles[i].__liquid = inst;
      instances.push(inst);
    }

    var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 120); };

    // Inicialización perezosa y escalonada: al entrar en pantalla y en tiempo muerto.
    // Así la carga de la página no paga nada y no hay tirón inicial.
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          io.unobserve(entry.target);
          var target = entry.target;
          idle(function () { target.__liquid.init(); });
        });
      }, { rootMargin: '200px' });
      instances.forEach(function (item) { io.observe(item.el); });
    } else {
      instances.forEach(function (inst) { idle(function () { inst.init(); }); });
    }

    // Recalcular sólo cuando el tamaño cambia de verdad (con freno)
    var t = 0;
    function scheduleRefresh() {
      clearTimeout(t);
      t = setTimeout(function () {
        instances.forEach(function (inst) { inst.refresh(); });
      }, 180);
    }
    window.addEventListener('resize', scheduleRefresh, { passive: true });
    window.addEventListener('orientationchange', scheduleRefresh, { passive: true });

    if (document.fonts && document.fonts.addEventListener) {
      document.fonts.addEventListener('loadingdone', function () {
        instances.forEach(function (inst) {
          if (inst.ready) { inst.raster(); inst.uploadText(); inst.render(); }
        });
      });
    }

    window.LiquidText = { instances: instances, refresh: scheduleRefresh };
  }

  function start() {
    // Rasterizar recién cuando Poppins esté cargada, si no se dibujaría la fuente de reserva
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(boot);
    else boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
