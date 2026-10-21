/* Original Canvas background inspired by the public Glyph Ember visual brief.
   This is not the licensed React Bits Pro component or a port of its source. */
(function () {
  "use strict";
  var canvas = document.getElementById("emberBackground");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  if (!ctx) return;
  var motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var glyphs = " .`'\",:;^~-/\\()|<>+?il!L7ctfjrvxz1CYuJXkhdwO0QZmUaobqW8B$%#@";
  var field = document.createElement("canvas");
  var ink = field.getContext("2d");
  if (!ink) return;
  var width = 0;
  var height = 0;
  var columns = 0;
  var rows = 0;
  var cellWidth = 0;
  var cellHeight = 12;
  var palette = [];
  var sparks = [];
  var light = false;
  var frame = null;
  var lastPaint = -Infinity;
  var elapsed = 0;
  var previous = null;

  function updatePalette() {
    light = document.documentElement.dataset.theme === "light";
    var stops = light ? [[212, 95, 82], [190, 93, 67], [173, 72, 64], [139, 61, 51], [113, 46, 39]]
      : [[55, 29, 22], [105, 54, 36], [217, 133, 104], [250, 194, 150], [255, 250, 232]];
    palette = Array.from({ length: 64 }, function (_, index) {
      var position = index / 63 * (stops.length - 1);
      var from = stops[Math.min(stops.length - 2, Math.floor(position))];
      var to = stops[Math.min(stops.length - 1, Math.floor(position) + 1)];
      var fraction = position - Math.min(stops.length - 2, Math.floor(position));
      return "rgb(" + from.map(function (channel, i) {
        return Math.round(channel + (to[i] - channel) * fraction);
      }).join(",") + ")";
    });
  }

  function hash(x, y) {
    var value = Math.imul(x, 374761393) + Math.imul(y, 668265263);
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
  }

  function noise(x, y) {
    var ix = Math.floor(x);
    var iy = Math.floor(y);
    var fx = x - ix;
    var fy = y - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    var lower = hash(ix, iy) * (1 - fx) + hash(ix + 1, iy) * fx;
    var upper = hash(ix, iy + 1) * (1 - fx) + hash(ix + 1, iy + 1) * fx;
    return lower * (1 - fy) + upper * fy;
  }

  function turbulence(x, y) {
    return noise(x, y) * 0.58 + noise(x * 2.07 + 31, y * 2.07) * 0.28
      + noise(x * 4.13, y * 4.13 + 17) * 0.14;
  }

  function draw(time) {
    ctx.clearRect(0, 0, width, height);
    ink.clearRect(0, 0, width, height);
    var fontSize = Math.min(13, cellWidth * 1.65, cellHeight);
    ink.font = fontSize + "px ui-monospace, SFMono-Regular, Consolas, monospace";
    ink.textAlign = "center";
    ink.textBaseline = "middle";
    // Advect a continuous noise field upward; smaller octaves tear and curl tips.
    for (var row = 0; row < rows; row++) {
      var rise = (rows - 1 - row) / rows;
      var flowY = rise * 2.7 - time * 0.55;
      for (var col = 0; col < columns; col++) {
        var x = col / columns;
        var warp = noise(x * 4.5 + 9, flowY * 0.75) - 0.5;
        var billow = turbulence(x * 11 + warp * rise * 3, flowY);
        var heat = Math.max(0, Math.min(1, 1 - rise * 1.75 + (billow - 0.48) * 2.3 * Math.sqrt(rise)));
        if (heat < 0.035) continue;
        var flicker = hash(col + Math.floor(time * 5), row);
        var density = Math.max(0, Math.min(1, heat + (flicker - 0.5) * 0.08));
        ink.globalAlpha = (light ? 0.12 : 1) * Math.min(1, 0.2 + heat * 1.2);
        ink.fillStyle = palette[Math.round(Math.pow(heat, 1.45) * 63)];
        var character = Math.min(glyphs.length - 1, Math.floor(density * (glyphs.length - 1)));
        ink.fillText(glyphs[character], (col + 0.5) * cellWidth, (row + 0.5) * cellHeight);
      }
    }
    ink.globalAlpha = 1;
    // Bloom is a separate pass, leaving the original glyphs sharp and legible.
    if (!light) {
      ctx.filter = "blur(9px)";
      ctx.globalAlpha = 0.65;
      ctx.drawImage(field, 0, 0, width, height);
    }
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    ctx.drawImage(field, 0, 0, width, height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    sparks.forEach(function (spark) {
      var age = (time * spark.speed + spark.phase) % 1;
      var px = spark.x * width + Math.sin(age * 9 + spark.phase * 25) * width * 0.025 * age;
      var py = height * (1 - age * 0.92);
      ctx.font = spark.size + "px ui-monospace, monospace";
      ctx.globalAlpha = Math.sin(age * Math.PI) * (light ? 0.16 : 0.95);
      if (!light) {
        var radius = spark.size * 2.5;
        var halo = ctx.createRadialGradient(px, py, 0, px, py, radius);
        halo.addColorStop(0, "rgba(250,194,150,0.5)");
        halo.addColorStop(0.25, "rgba(217,133,104,0.16)");
        halo.addColorStop(1, "rgba(217,133,104,0)");
        ctx.fillStyle = halo;
        ctx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
      }
      ctx.fillStyle = light ? "#ad4840" : "#fff1df";
      ctx.fillText(spark.glyph, px, py);
    });
    ctx.globalAlpha = 1;
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    var ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    field.width = width;
    field.height = height;
    columns = Math.min(280, Math.ceil(width / 7));
    rows = Math.min(110, Math.ceil(height / 12));
    cellWidth = width / columns;
    cellHeight = height / rows;
    sparks = Array.from({ length: Math.min(64, Math.ceil(width / 25)) }, function (_, index) {
      return { x: hash(index, 21), phase: hash(index, 43), speed: 0.045 + hash(index, 11) * 0.035,
        size: 10 + hash(index, 7) * 5, glyph: index % 3 === 0 ? "*" : "+" };
    });
    draw(elapsed);
  }

  function stop() {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    previous = null;
    canvas.dataset.state = "paused";
  }

  function animate(now) {
    if (now - lastPaint >= 50) {
      if (previous !== null) elapsed += Math.min((now - previous) / 1000, 0.1);
      previous = now;
      lastPaint = now;
      draw(elapsed);
    }
    frame = window.requestAnimationFrame(animate);
  }

  function sync() {
    stop();
    if (document.hidden) return;
    if (motion.matches) {
      draw(0);
      canvas.dataset.state = "static";
      return;
    }
    lastPaint = -Infinity;
    canvas.dataset.state = "running";
    frame = window.requestAnimationFrame(animate);
  }

  updatePalette();
  resize();
  sync();
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", sync);
  document.addEventListener("meldwork:themechange", function () {
    updatePalette();
    draw(motion.matches ? 0 : elapsed);
  });
  if (motion.addEventListener) motion.addEventListener("change", sync);
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", sync);
})();
