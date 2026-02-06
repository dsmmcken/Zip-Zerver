/**
 * WebGL Animated Border Text
 * Self-contained module - no dependencies on main application
 */
(function() {
  'use strict';

  const TEXT = 'DRAG ZIP FILE HERE ';
  const BORDER_SIZE = 30;
  const CORNER_RADIUS = 8;
  const FONT_SIZE = 14;
  const LETTER_SPACING = -1; // Tighter letters (negative = closer together)
  const ANIMATION_SPEED = 80; // pixels per second

  // Create and insert canvas
  const canvas = document.createElement('canvas');
  canvas.id = 'border-canvas';
  document.body.insertBefore(canvas, document.body.firstChild);

  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
  if (!gl) {
    console.warn('WebGL not supported, border animation disabled');
    return;
  }

  // Shader sources
  const vertexShaderSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;

    uniform vec2 u_resolution;

    varying vec2 v_texCoord;

    void main() {
      vec2 clipSpace = (a_position / u_resolution) * 2.0 - 1.0;
      gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
      v_texCoord = a_texCoord;
    }
  `;

  const fragmentShaderSource = `
    precision mediump float;

    uniform sampler2D u_texture;
    varying vec2 v_texCoord;

    void main() {
      vec4 color = texture2D(u_texture, v_texCoord);
      gl_FragColor = vec4(1.0, 1.0, 1.0, color.a);
    }
  `;

  // Compile shader
  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  // Create program
  function createProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    return program;
  }

  // Initialize shaders and program
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  const program = createProgram(gl, vertexShader, fragmentShader);

  // Get locations
  const positionLocation = gl.getAttribLocation(program, 'a_position');
  const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');
  const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
  const textureLocation = gl.getUniformLocation(program, 'u_texture');

  // Create buffers
  const positionBuffer = gl.createBuffer();
  const texCoordBuffer = gl.createBuffer();

  // Character texture atlas
  let charData = {};
  let atlasTexture = null;
  let atlasWidth = 0;
  let atlasHeight = 0;

  // Create character atlas
  function createCharacterAtlas() {
    const uniqueChars = [...new Set(TEXT)];
    const offscreenCanvas = document.createElement('canvas');
    const ctx = offscreenCanvas.getContext('2d');

    ctx.font = `600 ${FONT_SIZE}px 'Spline Sans Mono', monospace`;

    // Measure all characters
    let totalWidth = 0;
    const charMetrics = {};
    for (const char of uniqueChars) {
      const metrics = ctx.measureText(char);
      charMetrics[char] = {
        width: Math.ceil(metrics.width) + 4,
        height: FONT_SIZE + 8
      };
      totalWidth += charMetrics[char].width;
    }

    // Create atlas
    atlasWidth = Math.pow(2, Math.ceil(Math.log2(totalWidth)));
    atlasHeight = Math.pow(2, Math.ceil(Math.log2(FONT_SIZE + 8)));

    offscreenCanvas.width = atlasWidth;
    offscreenCanvas.height = atlasHeight;

    ctx.font = `600 ${FONT_SIZE}px 'Spline Sans Mono', monospace`;
    ctx.fillStyle = 'white';
    ctx.textBaseline = 'middle';

    let x = 0;
    for (const char of uniqueChars) {
      const m = charMetrics[char];
      ctx.fillText(char, x + 2, atlasHeight / 2);
      charData[char] = {
        x: x,
        width: m.width,
        u0: x / atlasWidth,
        u1: (x + m.width) / atlasWidth,
        v0: 0,
        v1: 1
      };
      x += m.width;
    }

    // Create WebGL texture
    atlasTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offscreenCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  // Path calculation
  let pathSegments = [];
  let totalPathLength = 0;
  let dpr = 1;

  function calculatePath() {
    const w = canvas.width;
    const h = canvas.height;
    const b = (BORDER_SIZE * dpr) / 2;
    const r = CORNER_RADIUS * dpr;

    pathSegments = [];

    const borderScaled = BORDER_SIZE * dpr;

    // Top edge (left to right)
    pathSegments.push({
      type: 'line',
      x1: b + r, y1: b,
      x2: w - b - r, y2: b,
      length: w - borderScaled - 2 * r,
      angle: 0
    });

    // Top-right corner
    pathSegments.push({
      type: 'arc',
      cx: w - b - r, cy: b + r,
      radius: r,
      startAngle: -Math.PI / 2,
      endAngle: 0,
      length: r * Math.PI / 2
    });

    // Right edge (top to bottom)
    pathSegments.push({
      type: 'line',
      x1: w - b, y1: b + r,
      x2: w - b, y2: h - b - r,
      length: h - borderScaled - 2 * r,
      angle: Math.PI / 2
    });

    // Bottom-right corner
    pathSegments.push({
      type: 'arc',
      cx: w - b - r, cy: h - b - r,
      radius: r,
      startAngle: 0,
      endAngle: Math.PI / 2,
      length: r * Math.PI / 2
    });

    // Bottom edge (right to left)
    pathSegments.push({
      type: 'line',
      x1: w - b - r, y1: h - b,
      x2: b + r, y2: h - b,
      length: w - borderScaled - 2 * r,
      angle: Math.PI
    });

    // Bottom-left corner
    pathSegments.push({
      type: 'arc',
      cx: b + r, cy: h - b - r,
      radius: r,
      startAngle: Math.PI / 2,
      endAngle: Math.PI,
      length: r * Math.PI / 2
    });

    // Left edge (bottom to top)
    pathSegments.push({
      type: 'line',
      x1: b, y1: h - b - r,
      x2: b, y2: b + r,
      length: h - borderScaled - 2 * r,
      angle: -Math.PI / 2
    });

    // Top-left corner
    pathSegments.push({
      type: 'arc',
      cx: b + r, cy: b + r,
      radius: r,
      startAngle: Math.PI,
      endAngle: Math.PI * 1.5,
      length: r * Math.PI / 2
    });

    totalPathLength = pathSegments.reduce((sum, seg) => sum + seg.length, 0);
  }

  // Get position and angle at distance along path
  function getPointOnPath(distance) {
    distance = ((distance % totalPathLength) + totalPathLength) % totalPathLength;

    let accumulated = 0;
    for (const seg of pathSegments) {
      if (accumulated + seg.length >= distance) {
        const t = (distance - accumulated) / seg.length;

        if (seg.type === 'line') {
          return {
            x: seg.x1 + (seg.x2 - seg.x1) * t,
            y: seg.y1 + (seg.y2 - seg.y1) * t,
            angle: seg.angle
          };
        } else {
          // Arc
          const angle = seg.startAngle + (seg.endAngle - seg.startAngle) * t;
          return {
            x: seg.cx + Math.cos(angle) * seg.radius,
            y: seg.cy + Math.sin(angle) * seg.radius,
            angle: angle + Math.PI / 2
          };
        }
      }
      accumulated += seg.length;
    }

    return { x: 0, y: 0, angle: 0 };
  }

  // Build geometry for all characters
  function buildGeometry(offset) {
    const positions = [];
    const texCoords = [];

    // Scale character dimensions by DPR
    const scale = dpr;

    // Calculate base text width with letter spacing
    const letterSpacingScaled = LETTER_SPACING * scale;
    let baseTextWidth = 0;
    for (const char of TEXT) {
      baseTextWidth += (charData[char]?.width || 10) * scale + letterSpacingScaled;
    }

    // Calculate exact number of repetitions that fit
    const repetitions = Math.floor(totalPathLength / baseTextWidth);
    if (repetitions < 1) return { positions, texCoords };

    // All extra space goes between repetitions (not distributed per character)
    const totalExtraSpace = totalPathLength - (baseTextWidth * repetitions);
    const gapBetweenRepetitions = totalExtraSpace / repetitions;

    const halfHeight = ((FONT_SIZE + 8) / 2) * scale;

    // Render exactly the right number of repetitions
    for (let rep = 0; rep < repetitions; rep++) {
      const repStartOffset = rep * (baseTextWidth + gapBetweenRepetitions);

      let charOffsetInRep = 0;
      for (const char of TEXT) {
        const cd = charData[char];
        if (!cd) continue;

        const charWidth = cd.width * scale;
        const charCenter = offset + repStartOffset + charOffsetInRep + charWidth / 2;
        const point = getPointOnPath(charCenter);

        // Calculate rotated quad corners
        const cos = Math.cos(point.angle);
        const sin = Math.sin(point.angle);
        const hw = charWidth / 2;
        const hh = halfHeight;

        // Four corners relative to center, then rotated
        const corners = [
          { dx: -hw, dy: -hh }, // top-left
          { dx: hw, dy: -hh },  // top-right
          { dx: -hw, dy: hh },  // bottom-left
          { dx: hw, dy: hh }    // bottom-right
        ].map(c => ({
          x: point.x + c.dx * cos - c.dy * sin,
          y: point.y + c.dx * sin + c.dy * cos
        }));

        // Two triangles
        positions.push(
          corners[0].x, corners[0].y,
          corners[1].x, corners[1].y,
          corners[2].x, corners[2].y,
          corners[1].x, corners[1].y,
          corners[3].x, corners[3].y,
          corners[2].x, corners[2].y
        );

        texCoords.push(
          cd.u0, cd.v0,
          cd.u1, cd.v0,
          cd.u0, cd.v1,
          cd.u1, cd.v0,
          cd.u1, cd.v1,
          cd.u0, cd.v1
        );

        charOffsetInRep += charWidth + letterSpacingScaled;
      }
    }

    return { positions, texCoords };
  }

  // Draw border background
  function drawBorderBackground() {
    const ctx = canvas.getContext('2d');
    // We'll draw the black border using WebGL instead
  }

  // Resize handler
  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';

    gl.viewport(0, 0, canvas.width, canvas.height);
    calculatePath();
  }

  // Animation state
  let offset = 0;
  let lastTime = 0;
  let isPaused = false;

  function render(time) {
    if (isPaused) return;

    const deltaTime = lastTime ? (time - lastTime) / 1000 : 0;
    lastTime = time;

    offset -= ANIMATION_SPEED * dpr * deltaTime;
    if (offset < 0) offset += totalPathLength;
    if (offset > totalPathLength) offset -= totalPathLength;

    // Clear with transparency
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Draw black border (as a frame)
    // We'll do this by drawing a full-screen black quad with a transparent center
    // For simplicity, we'll draw 4 black rectangles for the border

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Draw border rectangles (using a simple approach)
    const w = canvas.width;
    const h = canvas.height;
    const b = BORDER_SIZE * (window.devicePixelRatio || 1);

    // We need a separate draw for the black border
    // For now, let's use CSS for the black background and just draw the text

    // Build and draw character geometry
    const { positions, texCoords } = buildGeometry(offset);

    if (positions.length === 0) {
      requestAnimationFrame(render);
      return;
    }

    gl.useProgram(program);

    // Set resolution uniform
    gl.uniform2f(resolutionLocation, canvas.width, canvas.height);

    // Bind texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.uniform1i(textureLocation, 0);

    // Upload position data
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    // Upload texcoord data
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(texCoords), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(texCoordLocation);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

    // Draw
    gl.drawArrays(gl.TRIANGLES, 0, positions.length / 2);

    requestAnimationFrame(render);
  }

  // Initialize when fonts are loaded
  function init() {
    resize();
    createCharacterAtlas();
    requestAnimationFrame(render);
  }

  // Wait for Spline Sans Mono font to load
  if (document.fonts && document.fonts.load) {
    document.fonts.load("600 14px 'Spline Sans Mono'").then(init).catch(() => {
      // Fallback if font fails to load
      setTimeout(init, 500);
    });
  } else {
    // Fallback: wait a bit for fonts
    setTimeout(init, 500);
  }

  // Handle resize
  window.addEventListener('resize', resize);

  // Pause/resume based on report frame visibility
  function pause() {
    if (isPaused) return;
    isPaused = true;
    canvas.style.display = 'none';
  }

  function resume() {
    if (!isPaused) return;
    isPaused = false;
    canvas.style.display = '';
    lastTime = 0;
    requestAnimationFrame(render);
  }

  // Watch for report frame state changes
  const observer = new MutationObserver(() => {
    const reportFrame = document.querySelector('.report-frame');
    if (reportFrame && reportFrame.classList.contains('active')) {
      pause();
    } else if (isPaused) {
      resume();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });
})();
