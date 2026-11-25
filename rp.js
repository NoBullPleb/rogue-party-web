/*
 * Rogue Party, browser version: the page side of the Android shim (see web/src/main/java). Loads every image asset,
 * then starts the TeaVM-compiled game (main). Drawing, text measuring, sound, storage and page events live here.
 */
(function () {
  'use strict';
  var RP = window.RP = {};
  RP.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  RP.mem = {};

  /**
   * Density for the game's layouts (dp to CSS px): large windows scale the phone layout up (a 400 dp tall landscape
   * screen); a window shorter than a small phone (360 dp, e.g. a phone browser with its address bar) scales it down a
   * little instead of cramping it.
   */
  function computeScale() {
    var w = window.innerWidth, h = window.innerHeight, land = w >= h;
    var up = Math.min(w / (land ? 860 : 400), h / (land ? 400 : 860));
    if (up >= 1) return Math.min(3, up);
    return Math.max(0.8, Math.min(1, w / (land ? 640 : 360), h / (land ? 360 : 640)));
  }
  RP.uiScale = computeScale();

  // ------------------------------------------------------------ errors
  RP.fatal = function (msg) {
    console.error('[RoguePartyError] ' + msg);
    var box = document.getElementById('fatal');
    if (!box) {
      box = document.createElement('div');
      box.id = 'fatal';
      box.addEventListener('click', function () { box.style.display = 'none'; });
      document.body.appendChild(box);
    }
    box.style.display = 'block';
    box.textContent = 'Something went wrong (tap to hide):\n' + msg;
  };
  window.addEventListener('error', function (e) { RP.fatal(String(e.message || e)); });

  // ------------------------------------------------------------ storage
  RP.keys = function (prefix) {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) out.push(k);
      }
    } catch (e) {
      for (var m in RP.mem) if (m.indexOf(prefix) === 0) out.push(m);
    }
    return out;
  };

  // ------------------------------------------------------------ DOM helpers
  RP.observe = function (el, cb) {
    if (typeof ResizeObserver === 'undefined') {
      var last = '';
      var poll = function () {
        var r = el.getBoundingClientRect(), k = r.width + 'x' + r.height;
        if (k !== last) { last = k; cb(r.width, r.height); }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
      return;
    }
    new ResizeObserver(function () {
      var r = el.getBoundingClientRect();
      cb(r.width, r.height);
    }).observe(el);
  };

  RP.options = function (sel, items) {
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    for (var i = 0; i < items.length; i++) {
      var o = document.createElement('option');
      o.textContent = items[i];
      o.value = String(i);
      sel.appendChild(o);
    }
  };

  RP.toast = function (s, ms) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = s;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('on'); });
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 400); }, ms);
  };

  // ------------------------------------------------------------ colours, gradients, filters
  function css(c) {
    return 'rgba(' + ((c >>> 16) & 255) + ',' + ((c >>> 8) & 255) + ',' + (c & 255) + ',' + (((c >>> 24) & 255) / 255) + ')';
  }
  RP.css = css;
  var scratch = document.createElement('canvas').getContext('2d');

  RP.linear = function (x0, y0, x1, y1, colors, pos) {
    var g = scratch.createLinearGradient(x0, y0, x1, y1);
    for (var i = 0; i < colors.length; i++) g.addColorStop(Math.max(0, Math.min(1, pos[i])), css(colors[i]));
    return g;
  };

  RP.radial = function (x, y, r, colors, pos) {
    var g = scratch.createRadialGradient(x, y, 0, x, y, r);
    for (var i = 0; i < colors.length; i++) g.addColorStop(Math.max(0, Math.min(1, pos[i])), css(colors[i]));
    return g;
  };

  RP.colorMatrix = function (id, values) {
    var svg = document.getElementById('rpfilters');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'rpfilters';
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.position = 'absolute';
      document.body.appendChild(svg);
    }
    var f = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    f.id = id;
    f.setAttribute('color-interpolation-filters', 'sRGB');
    var m = document.createElementNS('http://www.w3.org/2000/svg', 'feColorMatrix');
    m.setAttribute('type', 'matrix');
    m.setAttribute('values', values);
    f.appendChild(m);
    svg.appendChild(f);
  };

  // ------------------------------------------------------------ bitmaps
  RP.canvas = function (w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
  };

  RP.getPixels = function (c, x, y, w, h) {
    var d = c.getContext('2d').getImageData(x, y, w, h).data, out = new Array(w * h);
    for (var i = 0, j = 0; i < out.length; i++, j += 4) out[i] = ((d[j + 3] << 24) | (d[j] << 16) | (d[j + 1] << 8) | d[j + 2]) | 0;
    return out;
  };

  RP.putPixels = function (c, px, w, h) {
    var g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
    for (var i = 0, j = 0; i < w * h; i++, j += 4) {
      var v = px[i];
      d[j] = (v >>> 16) & 255; d[j + 1] = (v >>> 8) & 255; d[j + 2] = v & 255; d[j + 3] = (v >>> 24) & 255;
    }
    g.putImageData(img, 0, 0);
  };

  RP.scaled = function (src, w, h, smooth) {
    var c = RP.canvas(w, h), g = c.getContext('2d');
    g.imageSmoothingEnabled = !!smooth;
    g.drawImage(src, 0, 0, w, h);
    return c;
  };

  RP.copy = function (src) {
    var c = RP.canvas(src.width, src.height);
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  };

  // ------------------------------------------------------------ drawing
  var measureCache = new Map();
  RP.measure = function (font, s) {
    var k = font + '\u0001' + s, v = measureCache.get(k);
    if (v !== undefined) return v;
    scratch.font = font;
    v = scratch.measureText(s).width;
    if (measureCache.size > 4000) measureCache.clear();
    measureCache.set(k, v);
    return v;
  };

  RP.drawColor = function (g, color, w, h) {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = css(color);
    g.fillRect(0, 0, w, h);
    g.restore();
  };

  function style(g, p, stroke) {
    var col = p._css || (p._css = css(p.color));
    var a = ((p.color >>> 24) & 255) / 255;
    if (p.shader) { g.globalAlpha = a; if (stroke) g.strokeStyle = p.shader; else g.fillStyle = p.shader; }
    else { g.globalAlpha = 1; if (stroke) g.strokeStyle = col; else g.fillStyle = col; }
    if (stroke) {
      g.lineWidth = p.width > 0 ? p.width : 1;
      g.lineCap = p.cap;
      g.lineJoin = p.join;
    }
    g.filter = p.filter || 'none';
  }

  function paintPath(g, p, rule) {
    if (p.style === 0 || p.style === 2) { style(g, p, false); g.fill(rule || 'nonzero'); }
    if (p.style === 1 || p.style === 2) { style(g, p, true); g.stroke(); }
    g.globalAlpha = 1;
    g.filter = 'none';
  }

  RP.rect = function (g, p, l, t, r, b) {
    g.beginPath();
    g.rect(l, t, r - l, b - t);
    paintPath(g, p);
  };

  function roundPath(g, l, t, r, b, rx, ry) {
    var w = r - l, h = b - t;
    rx = Math.max(0, Math.min(rx, w / 2)); ry = Math.max(0, Math.min(ry, h / 2));
    if (rx <= 0 || ry <= 0) { g.rect(l, t, w, h); return; }
    g.moveTo(l + rx, t);
    g.lineTo(r - rx, t);
    g.ellipse(r - rx, t + ry, rx, ry, 0, -Math.PI / 2, 0);
    g.lineTo(r, b - ry);
    g.ellipse(r - rx, b - ry, rx, ry, 0, 0, Math.PI / 2);
    g.lineTo(l + rx, b);
    g.ellipse(l + rx, b - ry, rx, ry, 0, Math.PI / 2, Math.PI);
    g.lineTo(l, t + ry);
    g.ellipse(l + rx, t + ry, rx, ry, 0, Math.PI, Math.PI * 1.5);
    g.closePath();
  }

  RP.roundRect = function (g, p, l, t, r, b, rx, ry) {
    if (r <= l || b <= t) return;
    g.beginPath();
    roundPath(g, l, t, r, b, rx, ry);
    paintPath(g, p);
  };

  RP.oval = function (g, p, l, t, r, b) {
    if (r <= l || b <= t) return;
    g.beginPath();
    g.ellipse((l + r) / 2, (t + b) / 2, (r - l) / 2, (b - t) / 2, 0, 0, Math.PI * 2);
    paintPath(g, p);
  };

  RP.arc = function (g, p, l, t, r, b, start, sweep, center) {
    if (r <= l || b <= t || sweep === 0) return;
    var cx = (l + r) / 2, cy = (t + b) / 2, a0 = start * Math.PI / 180, a1 = (start + sweep) * Math.PI / 180;
    g.beginPath();
    if (center) g.moveTo(cx, cy);
    if (Math.abs(sweep) >= 360) g.ellipse(cx, cy, (r - l) / 2, (b - t) / 2, 0, 0, Math.PI * 2);
    else g.ellipse(cx, cy, (r - l) / 2, (b - t) / 2, 0, a0, a1, sweep < 0);
    if (center) g.closePath();
    paintPath(g, p);
  };

  RP.lines = function (g, p, pts) {
    g.beginPath();
    for (var i = 0; i + 3 < pts.length; i += 4) { g.moveTo(pts[i], pts[i + 1]); g.lineTo(pts[i + 2], pts[i + 3]); }
    style(g, p, true);
    g.stroke();
    g.globalAlpha = 1;
    g.filter = 'none';
  };

  RP.path = function (g, p, c) {
    var rule = c[0] === 1 ? 'evenodd' : 'nonzero';
    g.beginPath();
    var i = 1, n = c.length;
    while (i < n) {
      var k = c[i++];
      switch (k) {
        case 0: g.moveTo(c[i], c[i + 1]); i += 2; break;
        case 1: g.lineTo(c[i], c[i + 1]); i += 2; break;
        case 2: g.quadraticCurveTo(c[i], c[i + 1], c[i + 2], c[i + 3]); i += 4; break;
        case 3: g.bezierCurveTo(c[i], c[i + 1], c[i + 2], c[i + 3], c[i + 4], c[i + 5]); i += 6; break;
        case 4: g.closePath(); break;
        case 5: g.rect(c[i], c[i + 1], c[i + 2] - c[i], c[i + 3] - c[i + 1]); i += 4; break;
        case 6: g.moveTo(c[i + 2], (c[i + 1] + c[i + 3]) / 2);
          g.ellipse((c[i] + c[i + 2]) / 2, (c[i + 1] + c[i + 3]) / 2, Math.abs(c[i + 2] - c[i]) / 2, Math.abs(c[i + 3] - c[i + 1]) / 2, 0, 0, Math.PI * 2);
          i += 4; break;
        case 7: roundPath(g, c[i], c[i + 1], c[i + 2], c[i + 3], c[i + 4], c[i + 5]); i += 6; break;
        case 8: case 9: {
          var cx = (c[i] + c[i + 2]) / 2, cy = (c[i + 1] + c[i + 3]) / 2, rx = Math.abs(c[i + 2] - c[i]) / 2, ry = Math.abs(c[i + 3] - c[i + 1]) / 2;
          var a0 = c[i + 4] * Math.PI / 180, a1 = (c[i + 4] + c[i + 5]) * Math.PI / 180;
          if (k === 8) g.moveTo(cx + rx * Math.cos(a0), cy + ry * Math.sin(a0));
          g.ellipse(cx, cy, rx, ry, 0, a0, a1, c[i + 5] < 0);
          i += 6; break;
        }
        default: i = n;
      }
    }
    paintPath(g, p, rule);
  };

  RP.text = function (g, p, s, x, y) {
    g.font = p.font;
    g.textAlign = p.align;
    g.textBaseline = 'alphabetic';
    if (p.style === 0 || p.style === 2) { style(g, p, false); g.fillText(s, x, y); }
    if (p.style === 1 || p.style === 2) { style(g, p, true); g.strokeText(s, x, y); }
    g.globalAlpha = 1;
    g.filter = 'none';
  };

  RP.image = function (g, p, img, sl, st, sr, sb, dl, dt, dr, db) {
    var sw = sr - sl, sh = sb - st, dw = dr - dl, dh = db - dt;
    if (sw <= 0 || sh <= 0 || dw === 0 || dh === 0 || !img || img.width === 0) return;
    g.imageSmoothingEnabled = p ? !!p.smooth : false;
    g.imageSmoothingQuality = 'high';
    g.globalAlpha = p ? ((p.color >>> 24) & 255) / 255 : 1;
    g.filter = p && p.filter ? p.filter : 'none';
    g.drawImage(img, sl, st, sw, sh, dl, dt, dw, dh);
    g.globalAlpha = 1;
    g.filter = 'none';
  };

  // ------------------------------------------------------------ sound (Web Audio)
  var audio = RP.audio = { ctx: null, defs: {}, buffers: {}, src: null, want: null };
  function unlock() {
    if (!audio.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { audio.ctx = new AC(); } catch (e) { return; }
    }
    if (audio.ctx.state === 'suspended') audio.ctx.resume().then(startWanted);
    else startWanted();
  }
  function startWanted() { if (audio.want && !audio.src) audio.playMusic(audio.want[0], audio.want[1], audio.want[2]); }
  ['pointerdown', 'keydown', 'touchend'].forEach(function (t) { window.addEventListener(t, unlock, true); });

  audio.define = function (name, pcm, rate) {
    var f = new Float32Array(pcm.length);
    for (var i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    audio.defs[name] = { data: f, rate: rate };
    delete audio.buffers[name];
  };
  audio.has = function (name) { return !!audio.defs[name]; };
  function buffer(name) {
    var b = audio.buffers[name];
    if (b) return b;
    var d = audio.defs[name];
    if (!d || !audio.ctx) return null;
    b = audio.ctx.createBuffer(1, d.data.length, d.rate);
    b.getChannelData(0).set(d.data);
    audio.buffers[name] = b;
    return b;
  }
  audio.play = function (name, vol) {
    if (!audio.ctx || audio.ctx.state !== 'running') return;
    var b = buffer(name);
    if (!b) return;
    var s = audio.ctx.createBufferSource(), gn = audio.ctx.createGain();
    s.buffer = b; gn.gain.value = vol;
    s.connect(gn); gn.connect(audio.ctx.destination);
    s.start();
  };
  audio.playMusic = function (name, loopStart, vol) {
    audio.stopMusic();
    audio.want = [name, loopStart, vol];
    if (!audio.ctx || audio.ctx.state !== 'running') return;
    var b = buffer(name);
    if (!b) return;
    var s = audio.ctx.createBufferSource(), gn = audio.ctx.createGain();
    s.buffer = b; s.loop = true; s.loopStart = loopStart; s.loopEnd = b.duration;
    gn.gain.value = vol;
    s.connect(gn); gn.connect(audio.ctx.destination);
    s.start();
    audio.src = s;
  };
  audio.stopMusic = function () {
    if (audio.src) { try { audio.src.stop(); } catch (e) {} audio.src = null; }
    audio.want = null;
  };

  // ------------------------------------------------------------ phones: full screen like the app (once per visit)
  var askedFull = false;
  window.addEventListener('pointerdown', function (e) {
    if (askedFull || e.pointerType !== 'touch') return;
    askedFull = true;
    var d = document.documentElement;
    try {
      if (document.fullscreenElement || !document.fullscreenEnabled || !d.requestFullscreen) return;
      if (window.matchMedia && !window.matchMedia('(display-mode: browser)').matches) return;   // installed: already full
      var p = d.requestFullscreen({ navigationUI: 'hide' });
      if (p && p.catch) p.catch(function () {});
    } catch (err) {}
  }, true);
  // On touch screens the browser fires a click after the finger lifts, at the same spot. When that tap opened a dialog
  // (drawn on a canvas, which acts on the finger lifting), the click lands on the dialog: it closed it at once, or
  // pressed whatever button lay under the finger. A click only counts on what the press started on.
  var downOn = null;
  window.addEventListener('pointerdown', function (e) { downOn = e.target; }, true);
  window.addEventListener('click', function (e) {
    var d = downOn, t = e.target;
    downOn = null;
    if (e.detail === 0 || !d || !t) return;                             // keyboard clicks, or nothing to compare
    if (d.isConnected && (d === t || d.contains(t) || t.contains(d))) return;
    e.stopPropagation(); e.preventDefault();
  }, true);
  window.addEventListener('contextmenu', function (e) { if (e.target && e.target.tagName === 'CANVAS') e.preventDefault(); });

  // ------------------------------------------------------------ Add to Home Screen (the main menu's button)
  var install = RP.install = { prompt: null };
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); install.prompt = e; });
  window.addEventListener('appinstalled', function () { install.prompt = null; });
  function standalone() {
    try {
      if (navigator.standalone) return true;                            // iOS, opened from the home screen
      return window.matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)').matches
          && !document.fullscreenElement;                               // (not merely full screen in the browser)
    } catch (e) { return false; }
  }
  function ios() {
    var ua = navigator.userAgent || '';
    return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function phone() {
    try { if (window.matchMedia('(pointer: coarse)').matches) return true; } catch (e) {}
    return /Android|iPhone|iPad|iPod|Mobile/.test(navigator.userAgent || '');
  }
  install.canOffer = function () { return !standalone() && (phone() || !!install.prompt); };
  install.run = function () {
    if (install.prompt) {
      var p = install.prompt;
      install.prompt = null;
      try { p.prompt(); } catch (e) { return 'Open your browser\'s menu and choose "Add to Home screen" or "Install app".'; }
      return '';
    }
    if (ios()) {
      var safari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
      return (safari ? 'Tap' : 'Open this page in Safari, then tap') + ' the Share button (the square with an arrow, at the bottom or top of the screen), ' +
          'then "Add to Home Screen", then Add. Rogue Party then opens full screen from its icon, with your saves.';
    }
    return 'Open your browser\'s menu (\u22EE or \u2630) and choose "Add to Home screen" or "Install app". ' +
        'Rogue Party then opens full screen from its icon, with your saves.';
  };

  // ------------------------------------------------------------ page events
  RP.hooks = function (back, resize, hide, show) {
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); back(); }
    });
    try {
      history.replaceState({ rp: 0 }, '');
      history.pushState({ rp: 1 }, '');
      window.addEventListener('popstate', function () {
        history.pushState({ rp: 1 }, '');
        back();
      });
    } catch (e) {}
    var timer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        RP.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
        RP.uiScale = computeScale();
        resize();
      }, 200);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) hide(); else show();
    });
  };

  // ------------------------------------------------------------ assets
  var assets = {};
  RP.asset = function (path) { return assets[path] || null; };
  RP.hasAsset = function (path) { return !!assets[path]; };

  function loadAll(list, done) {
    var bar = document.getElementById('bar'), n = 0, i = 0, total = list.length, active = 0;
    function next() {
      while (active < 12 && i < total) {
        (function (path) {
          active++;
          var img = new Image();
          img.onload = function () {
            var c = RP.canvas(img.naturalWidth, img.naturalHeight);
            c.getContext('2d').drawImage(img, 0, 0);
            assets[path] = c;
            fin();
          };
          img.onerror = function () { console.warn('missing asset ' + path); fin(); };
          img.src = 'assets/' + path;
        })(list[i++]);
      }
    }
    function fin() {
      active--; n++;
      if (bar) bar.style.width = Math.round(100 * n / total) + '%';
      if (n === total) done(); else next();
    }
    if (total === 0) done(); else next();
  }

  // ------------------------------------------------------------ rewarded ads (Hero Point, Don't give up)
  // Google's H5 Games Ads (the Ad Placement API in the AdSense tag). The AdSense publisher id goes in index.html
  // (<meta name="rp-ad-client">); with none set, a stand-in "ad" plays instead, so the flow can be tried out.
  function meta(n) { var m = document.querySelector('meta[name="' + n + '"]'); return m ? (m.getAttribute('content') || '').trim() : ''; }
  var ads = RP.ads = { client: meta('rp-ad-client'), test: meta('rp-ad-test') === 'on', fallback: meta('rp-ad-fallback') === 'reward', loaded: false };
  ads.init = function () {
    if (!ads.client || ads.loaded) return;
    ads.loaded = true;
    window.adsbygoogle = window.adsbygoogle || [];
    window.adBreak = window.adConfig = function (o) { window.adsbygoogle.push(o); };
    var s = document.createElement('script');
    s.async = true; s.crossOrigin = 'anonymous';
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(ads.client);
    if (ads.test) s.setAttribute('data-adbreak-test', 'on');           // Google's test ads, until the game goes live
    document.head.appendChild(s);
    window.adConfig({ preloadAdBreaks: 'on', sound: 'on' });
  };
  function hush(on) {
    try { if (audio.ctx) { if (on) audio.ctx.suspend(); else audio.ctx.resume(); } } catch (e) {}
  }
  /** Plays a rewarded ad; cb gets 'viewed' (give the reward), 'dismissed' or 'none' (no ad available). */
  ads.reward = function (placement, cb) {
    var settled = false;
    function finish(r) {
      if (settled) return; settled = true; hush(false);
      if (r === 'none' && ads.fallback) r = 'viewed';                   // no ad to show: the reward anyway (rp-ad-fallback)
      setTimeout(function () { cb(r); }, 0);
    }
    if (!ads.client) { standIn(finish); return; }
    ads.init();
    var offered = false;
    var timer = setTimeout(function () { if (!offered) finish('none'); }, 6000);
    try {
      window.adBreak({
        type: 'reward',
        name: placement.replace(/[^A-Za-z0-9_-]/g, '_'),
        beforeAd: function () { hush(true); },
        afterAd: function () { hush(false); },
        beforeReward: function (showAdFn) { offered = true; clearTimeout(timer); showAdFn(); },
        adDismissed: function () { finish('dismissed'); },
        adViewed: function () { finish('viewed'); },
        adBreakDone: function () { clearTimeout(timer); finish(offered ? 'dismissed' : 'none'); }
      });
    } catch (e) { clearTimeout(timer); finish('none'); }
  };
  /** No AdSense id yet: a stand-in ad with a short countdown, then Collect (the reward) or Close (no reward). */
  function standIn(finish) {
    hush(true);
    var o = document.createElement('div');
    o.className = 'rp-ad';
    o.innerHTML = '<div class="rp-ad-box"><div class="rp-ad-tag">Ad</div><div class="rp-ad-title">Stand-in ad</div>'
        + '<div class="rp-ad-note">No AdSense account is set up yet, so this stands in for the rewarded video ad Google will play here.</div>'
        + '<div class="rp-ad-count"></div><div class="rp-ad-row"><button class="rp-ad-close">Close</button><button class="rp-ad-get" disabled>Collect reward</button></div></div>';
    document.body.appendChild(o);
    var left = 3, count = o.querySelector('.rp-ad-count'), get = o.querySelector('.rp-ad-get');
    function tick() {
      count.textContent = left > 0 ? 'Reward in ' + left + '\u2026' : 'Reward ready';
      if (left <= 0) { get.disabled = false; return; }
      left--; setTimeout(tick, 1000);
    }
    tick();
    function close(r) { o.remove(); finish(r); }
    o.querySelector('.rp-ad-close').addEventListener('click', function () { close('dismissed'); });
    get.addEventListener('click', function () { if (!get.disabled) close('viewed'); });
  }

  RP.boot = function () {
    // the service worker keeps a copy of the game, so the home screen icon also starts it offline
    try {
      if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost'))
        navigator.serviceWorker.register('sw.js').catch(function () {});
    } catch (e) {}
    try { ads.init(); } catch (e) {}                                    // loads the ads early, so one is ready when it's wanted
    fetch('assets/list.json?v=0cad19f').then(function (r) { return r.json(); }).then(function (list) {
      loadAll(list, function () {
        var l = document.getElementById('loading');
        if (l) l.remove();
        try { main([]); } catch (e) { RP.fatal(String(e && e.stack || e)); }
      });
    }).catch(function (e) { RP.fatal('Could not load the game files: ' + e); });
  };
})();
