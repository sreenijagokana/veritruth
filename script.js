(function () {
  'use strict';

  /* ------------------------------------------------------------------
     Media rules
     ------------------------------------------------------------------ */
  var MB = 1024 * 1024;
  var KINDS = {
    image: {
      max: 20 * MB, names: 'JPG, PNG, WebP',
      exts: ['jpg', 'jpeg', 'png', 'webp'],
      mimes: ['image/jpeg', 'image/png', 'image/webp']
    },
    video: {
      max: 100 * MB, names: 'MP4, MOV, WebM',
      exts: ['mp4', 'mov', 'webm'],
      mimes: ['video/mp4', 'video/quicktime', 'video/webm']
    }
  };
  var TYPE_LABELS = {
    jpg: 'JPEG image', jpeg: 'JPEG image', png: 'PNG image', webp: 'WebP image',
    mp4: 'MP4 video', mov: 'QuickTime video', webm: 'WebM video'
  };
  var STEPS = {
    image: ['Reading file metadata', 'Measuring noise and pixel detail', 'Scoring the evidence'],
    video: ['Reading container metadata', 'Sampling frames', 'Scoring the evidence']
  };

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name);
    return m ? m[1].toLowerCase() : '';
  }
  function detectKind(file) {
    var ext = extOf(file.name);
    var keys = Object.keys(KINDS);
    for (var i = 0; i < keys.length; i++) {
      var k = KINDS[keys[i]];
      if (k.mimes.indexOf(file.type) !== -1 || k.exts.indexOf(ext) !== -1) return keys[i];
    }
    return null;
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < MB) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * MB) return (n / MB).toFixed(1) + ' MB';
    return (n / (1024 * MB)).toFixed(2) + ' GB';
  }
  function formatDuration(s) {
    if (!isFinite(s)) return 'Unavailable';
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    var pad = function (v) { return v < 10 ? '0' + v : '' + v; };
    return h ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
  }
  function validate(file, allowed) {
    var kind = detectKind(file);
    if (!kind) {
      return { error: 'Unsupported file. Use ' + allowed.map(function (k) { return KINDS[k].names; }).join(' or ') + '.' };
    }
    if (allowed.indexOf(kind) === -1) {
      var other = kind.charAt(0).toUpperCase() + kind.slice(1);
      return { error: 'This page accepts ' + allowed[0] + 's only. Use ' + other + ' Verification for ' + kind + 's.' };
    }
    if (file.size === 0) return { error: 'The file is empty.' };
    if (file.size > KINDS[kind].max) {
      return { error: 'This file is ' + formatBytes(file.size) + '. The maximum for ' + kind + 's is ' + (KINDS[kind].max / MB) + ' MB.' };
    }
    return { kind: kind };
  }

  function loadMeta(kind, url) {
    return new Promise(function (resolve) {
      if (kind === 'image') {
        var im = new Image();
        im.onload = function () { resolve({ width: im.naturalWidth, height: im.naturalHeight }); };
        im.onerror = function () { resolve({}); };
        im.src = url;
      } else {
        var v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        v.onloadedmetadata = function () { resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration }); };
        v.onerror = function () { resolve({}); };
        v.src = url;
      }
      setTimeout(function () { resolve({}); }, 8000);
    });
  }

  function makeMedia(kind, url) {
    var el;
    if (kind === 'image') {
      el = new Image();
      el.alt = 'Uploaded image preview';
    } else {
      el = document.createElement('video');
      el.controls = true;
      el.preload = 'metadata';
      el.setAttribute('playsinline', '');
    }
    el.addEventListener('error', function () {
      var p = document.createElement('p');
      p.className = 'na';
      p.textContent = 'Preview is not available for this file in your browser. Verification still works.';
      if (el.parentNode) el.replaceWith(p);
    });
    el.src = url;
    return el;
  }

  async function sha256(file) {
    try {
      var buf = await file.arrayBuffer();
      var digest = await crypto.subtle.digest('SHA-256', buf);
      return Array.prototype.map.call(new Uint8Array(digest), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    } catch (e) {
      return null;
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ------------------------------------------------------------------
     Detection layer
     To use a trained model or an external service, set Detector.endpoint
     (for example '/api/verify'). The page then POSTs multipart form data:
       file  the uploaded image or video
       type  'image' or 'video'
     and expects JSON back:
       {
         "verdict": "authentic" | "ai",
         "confidence": 0-100,
         "summary": "short explanation",
         "signals": [ { "label": "...", "status": "pass" | "flag", "note": "..." } ]
       }
     With no endpoint, the built-in local analysis below is used.
     ------------------------------------------------------------------ */
  var Detector = {
    endpoint: null,

    analyze: async function (job) {
      var raw = this.endpoint ? await this.remote(job) : await Local.analyze(job);
      return normalize(raw);
    },

    remote: async function (job) {
      var body = new FormData();
      body.append('file', job.file);
      body.append('type', job.kind);
      job.onProgress(0.25);
      var res = await fetch(this.endpoint, { method: 'POST', body: body });
      if (!res.ok) throw new Error('The detection service returned an error (' + res.status + ').');
      job.onProgress(1);
      return res.json();
    }
  };

  function normalize(raw) {
    var c = Math.round(Number(raw && raw.confidence));
    return {
      verdict: raw && raw.verdict === 'ai' ? 'ai' : 'authentic',
      confidence: Math.max(0, Math.min(100, isNaN(c) ? 0 : c)),
      summary: String((raw && raw.summary) || ''),
      signals: raw && Array.isArray(raw.signals) ? raw.signals : []
    };
  }

  /* ------------------------------------------------------------------
     Local analysis
     Looks at the file itself: AI tool markers in metadata, camera data,
     image size and pixel noise. Each check adds or removes evidence and
     the total decides the verdict. This is a heuristic, not a trained
     classifier, so confidence stays moderate when evidence is thin.
     ------------------------------------------------------------------ */
  var IMAGE_MARKERS = [
    ['stable diffusion', 'Stable Diffusion'], ['stablediffusion', 'Stable Diffusion'], ['sdxl', 'SDXL'],
    ['automatic1111', 'AUTOMATIC1111'], ['comfyui', 'ComfyUI'], ['negative prompt', 'a text-to-image prompt'],
    ['cfg scale', 'text-to-image settings'], ['midjourney', 'Midjourney'], ['dall-e', 'DALL·E'], ['dall·e', 'DALL·E'],
    ['dalle', 'DALL·E'], ['openai', 'OpenAI'], ['chatgpt', 'ChatGPT'], ['gpt-4o', 'GPT-4o'],
    ['adobe firefly', 'Adobe Firefly'], ['firefly', 'Adobe Firefly'], ['novelai', 'NovelAI'],
    ['leonardo.ai', 'Leonardo.Ai'], ['ideogram', 'Ideogram'], ['imagen', 'Google Imagen'],
    ['made with google ai', 'Google AI'], ['synthid', 'SynthID'],
    ['trainedalgorithmicmedia', 'an AI source tag (IPTC)'], ['generative ai', 'generative AI'],
    ['bing image creator', 'Bing Image Creator']
  ];
  var VIDEO_MARKERS = [
    ['openai sora', 'OpenAI Sora'], ['runway', 'Runway'], ['kling', 'Kling'], ['hailuo', 'Hailuo'],
    ['pika labs', 'Pika'], ['luma ai', 'Luma'], ['google veo', 'Google Veo'], ['stable video', 'Stable Video'],
    ['synthesia', 'Synthesia'], ['heygen', 'HeyGen'], ['synthid', 'SynthID'],
    ['trainedalgorithmicmedia', 'an AI source tag (IPTC)'], ['made with google ai', 'Google AI'],
    ['openai', 'OpenAI'], ['generative ai', 'generative AI']
  ];
  var NAME_PATTERN = /(^|[^a-z0-9])(gemini_generated|chatgpt|dall[-_ ·]?e|midjourney|firefly|ideogram|leonardo|stable[-_ ]?diffusion|sdxl|imagefx|ai[-_ ]generated|generated[-_ ]image|flux|bing[-_ ]image|runway|sora|kling|veo|pika|hailuo|grok)([^a-z0-9]|$)/i;

  var GEN_IMAGE_SIZES = ['512x512', '768x768', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792',
    '1344x768', '768x1344', '1152x896', '896x1152', '1216x832', '832x1216', '2048x2048', '1408x768', '1536x1536',
    '1664x928', '928x1664', '1280x768', '768x1280', '1456x816', '1248x832', '832x1248', '1184x864', '864x1184'];
  var CAMERA_SIZES = ['4032x3024', '3024x4032', '4000x3000', '3000x4000', '6000x4000', '4000x6000', '5472x3648',
    '3648x5472', '4608x3456', '3456x4608', '4160x3120', '3120x4160', '5184x3456', '3456x5184', '6240x4160',
    '4160x6240', '8000x6000', '6000x8000', '4284x5712', '5712x4284', '3840x2160', '3264x2448', '2448x3264'];
  var GEN_VIDEO_SIZES = ['1280x720', '720x1280', '1920x1080', '1080x1920', '1024x576', '576x1024', '848x480',
    '480x848', '768x768', '1024x1024', '1360x768', '768x1360', '1280x704', '704x1280', '1456x816', '832x480', '480x832'];
  var CAMERA_MAKES = ['canon', 'nikon', 'sony', 'panasonic', 'samsung', 'fujifilm', 'olympus', 'leica', 'gopro', 'dji',
    'apple', 'huawei', 'xiaomi', 'oneplus', 'motorola', 'pentax', 'hasselblad', 'ricoh'];

  async function readHead(file, n) {
    var buf = await file.slice(0, n).arrayBuffer();
    var u8 = new Uint8Array(buf);
    return { u8: u8, text: new TextDecoder('latin1').decode(u8).toLowerCase() };
  }
  async function readText(file, start, end) {
    var buf = await file.slice(start, end).arrayBuffer();
    return new TextDecoder('latin1').decode(buf).toLowerCase();
  }

  function findMarker(text, list) {
    for (var i = 0; i < list.length; i++) {
      if (text.indexOf(list[i][0]) !== -1) return list[i][1];
    }
    return null;
  }

  // Minimal JPEG EXIF reader: returns { make, model, software, date } or null.
  function parseExif(u8) {
    try {
      if (u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
      var p = 2;
      while (p + 10 < u8.length && u8[p] === 0xFF) {
        var marker = u8[p + 1];
        var len = (u8[p + 2] << 8) | u8[p + 3];
        if (marker === 0xE1 && u8[p + 4] === 0x45 && u8[p + 5] === 0x78 && u8[p + 6] === 0x69 && u8[p + 7] === 0x66) {
          return readTiff(u8, p + 10);
        }
        if (marker === 0xDA) break;
        p += 2 + len;
      }
    } catch (e) { /* unreadable EXIF is treated as absent */ }
    return null;
  }
  function readTiff(u8, base) {
    var le = u8[base] === 0x49;
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var g16 = function (o) { return dv.getUint16(o, le); };
    var g32 = function (o) { return dv.getUint32(o, le); };
    var ascii = function (o, n) {
      var s = '';
      for (var i = 0; i < n && u8[o + i]; i++) s += String.fromCharCode(u8[o + i]);
      return s.trim();
    };
    var ifd = base + g32(base + 4);
    var count = g16(ifd);
    var out = {};
    for (var i = 0; i < count && i < 80; i++) {
      var e = ifd + 2 + i * 12;
      var tag = g16(e), type = g16(e + 2), n = g32(e + 4);
      if (type !== 2) continue;
      var off = n <= 4 ? e + 8 : base + g32(e + 8);
      var val = ascii(off, Math.min(n, 64));
      if (tag === 0x010F) out.make = val;
      else if (tag === 0x0110) out.model = val;
      else if (tag === 0x0131) out.software = val;
      else if (tag === 0x0132) out.date = val;
    }
    return out;
  }

  function toGray(data, n) {
    var g = new Float32Array(n * n);
    for (var i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    return g;
  }

  // Draws native-resolution crops (no scaling) and returns 8x8 block statistics.
  function cropBlocks(src, sw, sh, cs, cols, rows, blocks) {
    var c = document.createElement('canvas');
    c.width = c.height = cs;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    for (var r = 0; r < rows; r++) {
      for (var q = 0; q < cols; q++) {
        var sx = Math.max(0, Math.min(sw - cs, Math.round((q + 0.5) * sw / cols - cs / 2)));
        var sy = Math.max(0, Math.min(sh - cs, Math.round((r + 0.5) * sh / rows - cs / 2)));
        ctx.drawImage(src, sx, sy, cs, cs, 0, 0, cs, cs);
        var gray = toGray(ctx.getImageData(0, 0, cs, cs).data, cs);
        blockStats(gray, cs, blocks);
      }
    }
  }
  function blockStats(gray, n, out) {
    for (var y0 = 1; y0 + 9 <= n; y0 += 8) {
      for (var x0 = 1; x0 + 9 <= n; x0 += 8) {
        var s = 0, s2 = 0, act = 0;
        for (var y = y0; y < y0 + 8; y++) {
          for (var x = x0; x < x0 + 8; x++) {
            var i = y * n + x, g = gray[i];
            var r = g - 0.25 * (gray[i - n] + gray[i + n] + gray[i - 1] + gray[i + 1]);
            s += r; s2 += r * r;
            act += Math.abs(gray[i + 1] - g) + Math.abs(gray[i + n] - g);
          }
        }
        var m = s / 64;
        out.push({ sd: Math.sqrt(Math.max(0, s2 / 64 - m * m)), act: act / 64 });
      }
    }
  }
  // Noise level in the flattest 30% of blocks, in 8-bit gray levels.
  function measureNoise(blocks) {
    if (blocks.length < 20) return null;
    blocks.sort(function (a, b) { return a.act - b.act; });
    var k = Math.max(10, Math.floor(blocks.length * 0.3));
    var sds = blocks.slice(0, k).map(function (b) { return b.sd; }).sort(function (a, b) { return a - b; });
    return sds[Math.floor(sds.length / 2)] / 1.118;
  }

  function imageNoise(url) {
    return new Promise(function (resolve) {
      var im = new Image();
      im.onload = function () {
        try {
          var w = im.naturalWidth, h = im.naturalHeight, cs = Math.min(192, w, h);
          if (cs < 48) return resolve(null);
          var blocks = [];
          cropBlocks(im, w, h, cs, 3, 2, blocks);
          resolve(measureNoise(blocks));
        } catch (e) { resolve(null); }
      };
      im.onerror = function () { resolve(null); };
      im.src = url;
    });
  }

  function once(el, evt, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (ok) { if (!done) { done = true; el.removeEventListener(evt, onEvt); resolve(ok); } };
      var onEvt = function () { finish(true); };
      el.addEventListener(evt, onEvt);
      setTimeout(function () { finish(false); }, ms);
    });
  }
  async function videoNoise(url, duration) {
    var v = document.createElement('video');
    v.muted = true; v.preload = 'auto';
    v.setAttribute('playsinline', '');
    v.src = url;
    if (!(await once(v, 'loadeddata', 8000))) return null;
    var w = v.videoWidth, h = v.videoHeight, cs = Math.min(160, w, h);
    if (cs < 48) return null;
    var times = duration > 1.5 ? [0.2, 0.5, 0.8].map(function (f) { return f * duration; }) : [0];
    var blocks = [];
    for (var i = 0; i < times.length; i++) {
      if (times[i] > 0) {
        v.currentTime = times[i];
        await once(v, 'seeked', 4000);
      }
      try { cropBlocks(v, w, h, cs, 2, 2, blocks); } catch (e) { /* skip frame */ }
    }
    v.removeAttribute('src'); v.load();
    return measureNoise(blocks);
  }

  function part(label, flag, score, note) {
    return { label: label, flag: flag, score: score, note: note };
  }

  function finish(kind, parts, aiMarker) {
    var s = 0;
    parts.forEach(function (p) { s += p.score; });
    var ai = s > 0.5; // thin evidence stays on the authentic side with low confidence
    var conf = Math.round(52 + 44 * Math.tanh(Math.abs(s) / 3.2));
    if (aiMarker) { ai = true; conf = Math.max(conf, 94); }
    conf = Math.min(97, conf);

    var flagged = parts.filter(function (p) { return p.flag; });
    var summary;
    if (aiMarker) {
      summary = 'The file metadata names ' + aiMarker + ', which identifies it as AI generated.';
    } else if (ai) {
      summary = (flagged.length > 1 ? 'Several signals point to AI generation: ' : 'One signal points to AI generation: ') +
        flagged.map(function (p) { return p.label.toLowerCase(); }).join(', ') + '. No AI tool marker was found, so this is an estimate.';
    } else {
      var cam = parts.some(function (p) { return p.cam; });
      summary = 'No AI generation markers were found. ' + (cam
        ? 'Camera data in the file supports a real capture.'
        : (kind === 'video' ? 'Frame detail looks consistent with recorded footage.' : 'File details and pixel noise look consistent with a camera capture.'));
    }
    return {
      verdict: ai ? 'ai' : 'authentic',
      confidence: conf,
      summary: summary,
      signals: parts.map(function (p) { return { label: p.label, status: p.flag ? 'flag' : 'pass', note: p.note }; })
    };
  }

  async function analyzeImage(job) {
    var file = job.file;
    job.onProgress(0.1);
    var head = await readHead(file, 262144);
    var tail = file.size > 262144 ? await readText(file, Math.max(262144, file.size - 131072), file.size) : '';
    var text = head.text + tail;
    var meta = (await job.meta) || {};
    job.onProgress(0.4);

    var noise = await imageNoise(job.url);
    job.onProgress(0.85);

    var parts = [];
    var ext = extOf(file.name);
    var isJpeg = ext === 'jpg' || ext === 'jpeg' || (head.u8[0] === 0xFF && head.u8[1] === 0xD8);

    // 1. Provenance markers
    var marker = findMarker(text, IMAGE_MARKERS);
    var nameHit = NAME_PATTERN.test(file.name);
    var c2pa = text.indexOf('c2pa') !== -1 || text.indexOf('jumbf') !== -1;
    if (marker) {
      parts.push(part('Provenance markers', true, 6, 'File metadata names ' + marker + '.'));
    } else if (nameHit) {
      parts.push(part('Provenance markers', true, 2.2, 'The file name matches an AI tool export pattern.'));
    } else {
      parts.push(part('Provenance markers', false, 0, c2pa
        ? 'Content credentials (C2PA) are present and name no AI tool.'
        : 'No AI tool markers found in the metadata or file name.'));
    }

    // 2. Camera data
    var exif = isJpeg ? parseExif(head.u8) : null;
    var device = '';
    if (exif && (exif.make || exif.model)) {
      var mk = exif.make || '', md = exif.model || '';
      device = md.toLowerCase().indexOf(mk.toLowerCase()) === 0 ? md : (mk + ' ' + md).trim();
    }
    var cam = !!device;
    if (cam) {
      parts.push(Object.assign(part('Camera data', false, -3, 'Camera recorded in EXIF: ' + device + '.'), { cam: true }));
    } else if (isJpeg && exif) {
      parts.push(part('Camera data', false, 0, 'EXIF data is present but has no camera make or model.'));
    } else if (isJpeg) {
      parts.push(part('Camera data', true, 0.3, 'No camera make, model or capture details in the file.'));
    } else {
      parts.push(part('Camera data', true, 0.7, ext.toUpperCase() + ' file with no camera details. Camera photos are rarely saved in this format.'));
    }

    // 3. Image dimensions
    var w = meta.width, h = meta.height;
    if (w && h) {
      var key = w + 'x' + h;
      var dims = w + ' × ' + h;
      if (GEN_IMAGE_SIZES.indexOf(key) !== -1) {
        parts.push(part('Image dimensions', true, 1.5, dims + ' matches a common AI generator output size.'));
      } else if (CAMERA_SIZES.indexOf(key) !== -1) {
        parts.push(part('Image dimensions', false, -0.8, dims + ' matches a common camera format.'));
      } else if (w % 64 === 0 && h % 64 === 0 && Math.min(w, h) >= 512) {
        parts.push(part('Image dimensions', true, 1, dims + ' is a multiple of 64 on both sides, typical of generated images.'));
      } else if (w * h >= 8e6) {
        parts.push(part('Image dimensions', false, -0.5, dims + ' is a high-resolution size, typical of camera photos.'));
      } else {
        parts.push(part('Image dimensions', false, 0, dims + ' is not a typical generator size.'));
      }
    } else {
      parts.push(part('Image dimensions', false, 0, 'Dimensions could not be read.'));
    }

    // 4. Noise pattern
    if (noise === null) {
      parts.push(part('Noise pattern', false, 0, 'Not enough pixel data to measure noise.'));
    } else {
      var nv = noise.toFixed(2);
      // JPEG and WebP compression removes noise, so their thresholds are lower than PNG.
      var lossy = ext !== 'png';
      var smooth = lossy ? 0.4 : 0.7, low = lossy ? 0.8 : 1.2, normal = lossy ? 1.4 : 2;
      if (noise < smooth) parts.push(part('Noise pattern', true, 1, 'Flat areas are unusually smooth (noise ' + nv + '), typical of generated images.'));
      else if (noise < low) parts.push(part('Noise pattern', false, 0, 'Noise is low (' + nv + '). Common in both generated and heavily processed photos.'));
      else if (noise < normal) parts.push(part('Noise pattern', false, -0.3, 'Noise level is within a normal range (' + nv + ').'));
      else parts.push(part('Noise pattern', false, -0.9, 'Sensor-style noise is present in flat areas (' + nv + ').'));
    }

    return finish('image', parts, marker);
  }

  async function analyzeVideo(job) {
    var file = job.file;
    job.onProgress(0.1);
    var head = await readText(file, 0, 1048576);
    var tail = file.size > 1048576 ? await readText(file, Math.max(1048576, file.size - 1048576), file.size) : '';
    var text = head + tail;
    var meta = (await job.meta) || {};
    job.onProgress(0.35);

    var noise = await videoNoise(job.url, meta.duration || 0);
    job.onProgress(0.85);

    var parts = [];

    // 1. Provenance markers
    var marker = findMarker(text, VIDEO_MARKERS);
    var nameHit = NAME_PATTERN.test(file.name);
    if (marker) parts.push(part('Provenance markers', true, 6, 'Container metadata names ' + marker + '.'));
    else if (nameHit) parts.push(part('Provenance markers', true, 2.2, 'The file name matches an AI tool export pattern.'));
    else parts.push(part('Provenance markers', false, 0, 'No AI tool markers found in the metadata or file name.'));

    // 2. Camera data
    var devHit = text.indexOf('com.apple.quicktime.make') !== -1 || text.indexOf('com.apple.quicktime.model') !== -1 ||
      text.indexOf('com.android.version') !== -1 || text.indexOf('com.android.manufacturer') !== -1;
    var make = null;
    for (var i = 0; i < CAMERA_MAKES.length; i++) {
      if (text.indexOf(CAMERA_MAKES[i]) !== -1 && CAMERA_MAKES[i] !== 'apple') { make = CAMERA_MAKES[i]; break; }
    }
    if (devHit || make) {
      parts.push(Object.assign(part('Camera data', false, -2, 'Recording device details found in the file' + (make ? ' (' + make + ')' : '') + '.'), { cam: true }));
    } else {
      parts.push(part('Camera data', true, 0.6, 'No recording device details found in the file.'));
    }

    // 3. Clip profile
    var w = meta.width, h = meta.height, d = meta.duration;
    var key = w + 'x' + h;
    if (w && h && isFinite(d)) {
      var size = w + ' × ' + h + ', ' + formatDuration(d);
      if (d <= 10 && GEN_VIDEO_SIZES.indexOf(key) !== -1) {
        parts.push(part('Clip profile', true, 0.8, size + ' is a short clip at a common AI video size.'));
      } else if (d > 30) {
        parts.push(part('Clip profile', false, -0.8, size + ' is longer than most AI generated clips.'));
      } else {
        parts.push(part('Clip profile', false, 0, size + ' does not match a typical AI clip profile.'));
      }
    } else {
      parts.push(part('Clip profile', false, 0, 'Clip size and length could not be read.'));
    }

    // 4. Frame detail
    if (noise === null) {
      parts.push(part('Frame detail', false, 0, 'Not enough frame data to measure noise.'));
    } else {
      var nv = noise.toFixed(2);
      if (noise < 0.5) parts.push(part('Frame detail', true, 0.8, 'Flat areas in sampled frames are unusually smooth (noise ' + nv + ').'));
      else if (noise < 1.5) parts.push(part('Frame detail', false, 0, 'Frame noise is within a normal range (' + nv + ').'));
      else parts.push(part('Frame detail', false, -0.8, 'Sensor-style noise is present in sampled frames (' + nv + ').'));
    }

    return finish('video', parts, marker);
  }

  var Local = {
    analyze: async function (job) {
      var t0 = Date.now();
      var out = job.kind === 'image' ? await analyzeImage(job) : await analyzeVideo(job);
      var wait = 1400 - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
      job.onProgress(1);
      return out;
    }
  };

  /* ------------------------------------------------------------------
     Verifier component
     ------------------------------------------------------------------ */
  function mount(host, key, allowed) {
    host.appendChild(document.getElementById('verifier-tpl').content.cloneNode(true));
    var $ = function (role) { return host.querySelector('[data-role="' + role + '"]'); };
    var stage = function (name) { return host.querySelector('[data-stage="' + name + '"]'); };

    var el = {
      status: $('status'), drop: $('drop'), dropTitle: $('dropTitle'), input: $('input'),
      preview: $('preview'), media: $('media'), name: $('name'), remove: $('remove'),
      formats: $('formats'), error: $('error'), verify: $('verify'),
      busyTitle: $('busyTitle'), progress: $('progress'), progressWrap: $('progressWrap'), steps: $('steps'),
      rMedia: $('rMedia'), rName: $('rName'), info: $('info'), verdictPanel: $('verdictPanel'),
      verdict: $('verdict'), conf: $('conf'), meter: $('meter'), meterWrap: $('meterWrap'),
      summary: $('summary'), note: $('note'), signals: $('signals'), again: $('again')
    };

    // Copy that depends on which kinds this page accepts
    el.input.id = key + '-file';
    el.input.setAttribute('aria-label', 'Choose a file to verify');
    el.input.accept = allowed.reduce(function (acc, k) {
      return acc.concat(KINDS[k].mimes, KINDS[k].exts.map(function (e) { return '.' + e; }));
    }, []).join(',');
    if (allowed.length === 2) {
      el.dropTitle.textContent = 'Drop an image or video here';
      el.formats.textContent = 'Images: ' + KINDS.image.names + ', up to ' + (KINDS.image.max / MB) + ' MB. Videos: ' + KINDS.video.names + ', up to ' + (KINDS.video.max / MB) + ' MB.';
    } else {
      var k = KINDS[allowed[0]];
      el.dropTitle.textContent = 'Drop ' + (allowed[0] === 'image' ? 'an image' : 'a video') + ' here';
      el.formats.textContent = 'Supported formats: ' + k.names + '. Maximum file size: ' + (k.max / MB) + ' MB.';
    }
    el.drop.setAttribute('aria-label', el.dropTitle.textContent + ' or press Enter to browse files');

    var file = null, kind = null, url = null, metaPromise = null, runId = 0;

    function setStatus(text, tone) {
      el.status.textContent = text;
      if (tone) el.status.setAttribute('data-tone', tone); else el.status.removeAttribute('data-tone');
    }
    function showStage(name) {
      ['input', 'busy', 'result'].forEach(function (n) { stage(n).hidden = n !== name; });
    }
    function showError(msg) {
      el.error.textContent = msg || '';
      el.error.hidden = !msg;
    }
    function releaseUrl() {
      if (url) { URL.revokeObjectURL(url); url = null; }
    }

    function reset() {
      runId++;
      releaseUrl();
      file = null; kind = null; metaPromise = null;
      el.media.textContent = '';
      el.rMedia.textContent = '';
      el.preview.hidden = true;
      el.drop.hidden = false;
      el.verify.disabled = true;
      showError('');
      showStage('input');
      setStatus('No file selected');
    }

    function accept(f) {
      var v = validate(f, allowed);
      if (v.error) { showError(v.error); return; }
      showError('');
      releaseUrl();
      file = f; kind = v.kind;
      url = URL.createObjectURL(f);
      metaPromise = loadMeta(kind, url);
      el.media.textContent = '';
      el.media.appendChild(makeMedia(kind, url));
      el.name.textContent = f.name + '  ·  ' + formatBytes(f.size);
      el.name.title = f.name;
      el.drop.hidden = true;
      el.preview.hidden = false;
      el.verify.disabled = false;
      setStatus('Ready to verify', 'accent');
    }

    // Choosing and dropping files
    el.drop.addEventListener('click', function () { el.input.click(); });
    el.drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.input.click(); }
    });
    el.input.addEventListener('change', function () {
      if (el.input.files && el.input.files[0]) accept(el.input.files[0]);
      el.input.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (t) {
      el.drop.addEventListener(t, function (e) { e.preventDefault(); el.drop.setAttribute('data-drag', ''); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      el.drop.addEventListener(t, function (e) { e.preventDefault(); el.drop.removeAttribute('data-drag'); });
    });
    el.drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) accept(f);
    });
    el.remove.addEventListener('click', reset);
    el.again.addEventListener('click', reset);

    // Analysis
    function updateProgress(f) {
      el.progress.style.width = Math.round(f * 100) + '%';
      el.progressWrap.setAttribute('aria-valuenow', Math.round(f * 100));
      var n = STEPS[kind].length;
      var current = Math.min(n - 1, Math.floor(f * n));
      Array.prototype.forEach.call(el.steps.children, function (li, i) {
        var s = f >= 1 || i < current ? 'done' : i === current ? 'run' : 'wait';
        li.setAttribute('data-s', s);
        li.lastChild.textContent = s === 'done' ? 'Done' : s === 'run' ? 'Running' : 'Queued';
      });
    }

    async function run() {
      if (!file) return;
      var id = ++runId;
      var media = el.media.querySelector('video');
      if (media) media.pause();
      showError('');
      el.busyTitle.textContent = 'Analyzing ' + file.name;
      el.steps.textContent = '';
      STEPS[kind].forEach(function (label) {
        var li = document.createElement('li');
        var a = document.createElement('span'); a.textContent = label;
        var b = document.createElement('span'); b.textContent = 'Queued';
        li.appendChild(a); li.appendChild(b);
        el.steps.appendChild(li);
      });
      updateProgress(0);
      showStage('busy');
      setStatus('Analyzing', 'accent');

      try {
        var out = await Promise.all([
          metaPromise,
          sha256(file),
          Detector.analyze({
            file: file, kind: kind, url: url, meta: metaPromise,
            onProgress: function (f) { if (id === runId) updateProgress(f); }
          })
        ]);
        if (id !== runId) return;
        renderResult(out[2], out[0] || {}, out[1]);
      } catch (err) {
        if (id !== runId) return;
        showStage('input');
        setStatus('Ready to verify', 'accent');
        showError((err && err.message) || 'Analysis failed. Try again.');
      }
    }
    el.verify.addEventListener('click', run);

    function row(label, value, title) {
      var dt = document.createElement('dt'); dt.textContent = label;
      var dd = document.createElement('dd'); dd.textContent = value;
      if (title) dd.title = title;
      el.info.appendChild(dt); el.info.appendChild(dd);
    }

    function renderResult(res, meta, hash) {
      el.rMedia.textContent = '';
      el.rMedia.appendChild(makeMedia(kind, url));
      el.rName.textContent = file.name;
      el.rName.title = file.name;

      el.info.textContent = '';
      row('File name', file.name);
      row('Type', TYPE_LABELS[extOf(file.name)] || file.type || 'Unknown');
      row('Size', formatBytes(file.size));
      row('Resolution', meta.width && meta.height ? meta.width + ' × ' + meta.height + ' px' : 'Unavailable');
      if (kind === 'video') row('Duration', formatDuration(meta.duration));
      row('SHA-256', hash || 'Unavailable');
      row('Analyzed', new Date().toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }));

      var ai = res.verdict === 'ai';
      el.verdictPanel.setAttribute('data-verdict', res.verdict);
      el.verdict.textContent = ai ? 'Likely AI Generated' : 'Likely Authentic';
      el.conf.textContent = res.confidence + '%';
      el.meterWrap.setAttribute('aria-label', 'Confidence ' + res.confidence + ' percent');
      el.meter.style.width = '0';
      requestAnimationFrame(function () { requestAnimationFrame(function () { el.meter.style.width = res.confidence + '%'; }); });
      el.summary.textContent = res.summary;
      el.note.hidden = res.confidence >= 65;
      el.note.textContent = 'Confidence is low. Treat this result as inconclusive and check the original source.';

      el.signals.textContent = '';
      res.signals.forEach(function (s) {
        var li = document.createElement('li');
        var text = document.createElement('div');
        var t = document.createElement('p'); t.className = 'sig-t'; t.textContent = s.label;
        var n = document.createElement('p'); n.className = 'sig-n'; n.textContent = s.note || '';
        text.appendChild(t); text.appendChild(n);
        var pill = document.createElement('span');
        pill.className = 'pill';
        var flagged = s.status === 'flag';
        pill.setAttribute('data-tone', flagged ? 'warn' : 'ok');
        pill.textContent = flagged ? 'Flagged' : 'Normal';
        li.appendChild(text); li.appendChild(pill);
        el.signals.appendChild(li);
      });

      setStatus('Complete');
      showStage('result');
    }

    reset();
  }

  mount(document.querySelector('[data-mount="home"]'), 'home', ['image', 'video']);
  mount(document.querySelector('[data-mount="image"]'), 'image', ['image']);
  mount(document.querySelector('[data-mount="video"]'), 'video', ['video']);

  // A file dropped outside a drop area must not navigate away from the page
  ['dragover', 'drop'].forEach(function (t) {
    window.addEventListener(t, function (e) { e.preventDefault(); });
  });

  /* ------------------------------------------------------------------
     Navigation
     ------------------------------------------------------------------ */
  var VIEWS = ['home', 'image', 'video', 'about'];
  function show(view) {
    if (VIEWS.indexOf(view) === -1) view = 'home';
    document.querySelectorAll('[data-view]').forEach(function (s) { s.hidden = s.getAttribute('data-view') !== view; });
    document.querySelectorAll('.nav a').forEach(function (a) {
      if (a.getAttribute('data-nav') === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.querySelectorAll('video').forEach(function (v) { v.pause(); });
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('[data-nav]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var v = a.getAttribute('data-nav');
      show(v);
      try { history.replaceState(null, '', '#' + v); } catch (err) { /* hash update is optional */ }
    });
  });
  window.addEventListener('hashchange', function () { show(location.hash.slice(1)); });
  show(location.hash.slice(1));
})();
