/**
 * WebGL Drag-Over Animation
 * Self-contained module - no dependencies on main application
 * Shows animated "DROP FILE HERE" text at 45° when dragging files
 */
(function() {
  'use strict';

  const TEXT = 'DROP ';
  const FONT_SIZE = 14;
  const ROW_HEIGHT = 24;
  const ANIMATION_SPEED = 20; // pixels per second
  const ROTATION = -Math.PI / 4; // -45 degrees
  const LERP_FACTOR = 0.08; // smoothing factor for pan (0-1, lower = smoother)
  const PAN_SCALE = 0.5; // how much cursor movement affects pan
  const BG_COLOR = { r: 0.03, g: 0.07, b: 0.72 }; // color(display-p3 0.03 0.07 0.72)

  // Create and insert canvas (hidden by default)
  const canvas = document.createElement('canvas');
  canvas.id = 'drag-overlay-canvas';
  document.body.appendChild(canvas);

  const gl = canvas.getContext('webgl', { alpha: false });
  if (!gl) {
    console.warn('WebGL not supported, drag overlay disabled');
    return;
  }

  // Shader sources
  const vertexShaderSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;

    uniform vec2 u_resolution;
    uniform float u_rotation;
    uniform vec2 u_pan;

    varying vec2 v_texCoord;

    void main() {
      // Apply pan offset, then rotate around center of screen
      vec2 center = u_resolution * 0.5;
      vec2 pos = a_position + u_pan - center;

      float c = cos(u_rotation);
      float s = sin(u_rotation);
      vec2 rotated = vec2(pos.x * c - pos.y * s, pos.x * s + pos.y * c);
      rotated += center;

      vec2 clipSpace = (rotated / u_resolution) * 2.0 - 1.0;
      gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
      v_texCoord = a_texCoord;
    }
  `;

  const fragmentShaderSource = `
    precision mediump float;
    uniform sampler2D u_texture;
    varying vec2 v_texCoord;

    void main() {
      vec4 texColor = texture2D(u_texture, v_texCoord);
      gl_FragColor = vec4(1.0, 1.0, 1.0, texColor.a);
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
  const rotationLocation = gl.getUniformLocation(program, 'u_rotation');
  const panLocation = gl.getUniformLocation(program, 'u_pan');
  const textureLocation = gl.getUniformLocation(program, 'u_texture');

  // Create buffers
  const positionBuffer = gl.createBuffer();
  const texCoordBuffer = gl.createBuffer();

  // Character texture atlas
  let charData = {};
  let atlasTexture = null;
  let atlasWidth = 0;
  let atlasHeight = 0;

  // State
  let isVisible = false;
  let isDisabled = false;
  let dragEnterCount = 0;
  let dpr = 1;
  let animationId = null;
  let lastTime = 0;
  let rowOffsets = [];

  // Pan state (follows cursor with lerp)
  let currentPanX = 0;
  let currentPanY = 0;
  let targetPanX = 0;
  let targetPanY = 0;
  let mouseX = 0;
  let mouseY = 0;

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

  // Calculate text width
  function getTextWidth() {
    let width = 0;
    for (const char of TEXT) {
      width += (charData[char]?.width || 10) * dpr;
    }
    return width;
  }

  // Build geometry for all rows
  function buildGeometry() {
    const positions = [];
    const texCoords = [];

    const w = canvas.width;
    const h = canvas.height;
    // Add extra margin for pan offset (max pan is half screen * PAN_SCALE)
    const panMargin = Math.max(w, h) * PAN_SCALE;
    const diagonal = Math.sqrt(w * w + h * h) + panMargin * 2;
    const rowHeightScaled = ROW_HEIGHT * dpr;
    const numRows = Math.ceil(diagonal / rowHeightScaled) + 4;
    const textWidth = getTextWidth();
    const halfHeight = ((FONT_SIZE + 8) / 2) * dpr;

    // Center point
    const centerX = w / 2;
    const centerY = h / 2;

    // Initialize row offsets if needed
    while (rowOffsets.length < numRows) {
      rowOffsets.push(0);
    }

    for (let row = 0; row < numRows; row++) {
      // Row Y position (centered around screen center)
      const rowY = centerY + (row - numRows / 2) * rowHeightScaled;

      const offset = rowOffsets[row];

      // Calculate how many repetitions needed
      const repsNeeded = Math.ceil(diagonal / textWidth) + 4;

      // Start X position (offset to the left of center)
      // Offset odd rows by 50% for brick pattern
      const rowOffset = row % 2 === 0 ? 0 : textWidth / 2;
      let startX = centerX - diagonal / 2 - textWidth + (offset % textWidth) + rowOffset;

      for (let rep = 0; rep < repsNeeded; rep++) {
        let charX = startX + rep * textWidth;

        for (const char of TEXT) {
          const cd = charData[char];
          if (!cd) continue;

          const charWidth = cd.width * dpr;
          const x = charX;
          const y = rowY;

          // Quad corners (not rotated - rotation happens in shader)
          const x0 = x;
          const x1 = x + charWidth;
          const y0 = y - halfHeight;
          const y1 = y + halfHeight;

          // Two triangles
          positions.push(
            x0, y0,
            x1, y0,
            x0, y1,
            x1, y0,
            x1, y1,
            x0, y1
          );

          texCoords.push(
            cd.u0, cd.v0,
            cd.u1, cd.v0,
            cd.u0, cd.v1,
            cd.u1, cd.v0,
            cd.u1, cd.v1,
            cd.u0, cd.v1
          );

          charX += charWidth;
        }
      }
    }

    return { positions, texCoords };
  }

  // Resize handler
  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  // Animation loop
  function render(time) {
    if (!isVisible) {
      animationId = null;
      return;
    }

    const deltaTime = lastTime ? (time - lastTime) / 1000 : 0;
    lastTime = time;

    // Lerp pan towards target
    currentPanX += (targetPanX - currentPanX) * LERP_FACTOR;
    currentPanY += (targetPanY - currentPanY) * LERP_FACTOR;

    // Update row offsets (alternating directions) - disabled for testing
    // const speed = ANIMATION_SPEED * dpr * deltaTime;
    // for (let i = 0; i < rowOffsets.length; i++) {
    //   if (i % 2 === 0) {
    //     rowOffsets[i] += speed;
    //   } else {
    //     rowOffsets[i] -= speed;
    //   }
    // }

    // Clear with blue
    gl.clearColor(BG_COLOR.r, BG_COLOR.g, BG_COLOR.b, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Build geometry
    const { positions, texCoords } = buildGeometry();

    if (positions.length === 0) {
      animationId = requestAnimationFrame(render);
      return;
    }

    gl.useProgram(program);

    // Set uniforms
    gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
    gl.uniform1f(rotationLocation, ROTATION);
    gl.uniform2f(panLocation, currentPanX * dpr, currentPanY * dpr);

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

    animationId = requestAnimationFrame(render);
  }

  // Calculate pan offset from cursor position
  function getPanFromCursor() {
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    return {
      x: (mouseX - centerX) * PAN_SCALE,
      y: (mouseY - centerY) * PAN_SCALE
    };
  }

  // Show overlay
  function show() {
    if (isVisible) return;
    isVisible = true;
    canvas.classList.add('active');
    lastTime = 0;
    // Start at cursor position immediately (no slide-in)
    const initialPan = getPanFromCursor();
    currentPanX = initialPan.x;
    currentPanY = initialPan.y;
    targetPanX = initialPan.x;
    targetPanY = initialPan.y;
    animationId = requestAnimationFrame(render);
  }

  // Hide overlay
  function hide() {
    isVisible = false;
    canvas.classList.remove('active');
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
  }

  // Drag event handlers
  function handleDragEnter(e) {
    e.preventDefault();
    if (isDisabled) return;
    dragEnterCount++;
    if (dragEnterCount === 1) {
      // Capture cursor position before showing
      mouseX = e.clientX;
      mouseY = e.clientY;
      show();
    }
  }

  function handleDragLeave(e) {
    e.preventDefault();
    dragEnterCount--;
    if (dragEnterCount === 0) {
      hide();
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    // Track mouse position for panning
    mouseX = e.clientX;
    mouseY = e.clientY;
    const pan = getPanFromCursor();
    targetPanX = pan.x;
    targetPanY = pan.y;
  }

  function handleDrop(e) {
    dragEnterCount = 0;
    hide();
    // Don't prevent default - let the main app handle the drop
  }

  // Initialize
  function init() {
    resize();
    createCharacterAtlas();

    // Add event listeners
    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);
    window.addEventListener('resize', resize);
  }

  // Pause/resume based on report frame visibility
  function disable() {
    if (isDisabled) return;
    isDisabled = true;
    hide();
  }

  function enable() {
    if (!isDisabled) return;
    isDisabled = false;
  }

  // Watch for report frame state changes
  const observer = new MutationObserver(() => {
    const reportFrame = document.querySelector('.report-frame');
    if (reportFrame && reportFrame.classList.contains('active')) {
      disable();
    } else if (isDisabled) {
      enable();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });

  // Wait for font to load
  if (document.fonts && document.fonts.load) {
    document.fonts.load("600 14px 'Spline Sans Mono'").then(init).catch(() => {
      setTimeout(init, 500);
    });
  } else {
    setTimeout(init, 500);
  }
})();
