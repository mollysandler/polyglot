// Pipeline diagnostic — paste this into YouTube's DevTools console.
// Replicates the exact content-script.js canvas pipeline step by step
// and reports which step produces blank pixels.
(function() {
  const video = document.querySelector('video');
  if (!video || video.videoWidth === 0) { console.log('No playing video found'); return; }

  const CAPTURE_H = Math.min(video.videoHeight, 720);
  const CAPTURE_W = Math.round((video.videoWidth / video.videoHeight) * CAPTURE_H);
  const MAX_FRAMES = 150;

  // Create display canvas (in DOM, like our code)
  const displayCanvas = document.createElement('canvas');
  const parent = video.parentElement;
  displayCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:999998;pointer-events:none;';
  const rect = video.getBoundingClientRect();
  displayCanvas.width = Math.round(rect.width);
  displayCanvas.height = Math.round(rect.height);
  parent.appendChild(displayCanvas);
  const displayCtx = displayCanvas.getContext('2d');

  // State (mirrors content-script.js)
  const frameBuffer = [];
  const canvasPool = [];
  let drawingActive = false;
  let frameCount = 0;

  function samplePixel(ctx, w, h) {
    try {
      const px = ctx.getImageData(Math.floor(w/2), Math.floor(h/2), 1, 1).data;
      return { r: px[0], g: px[1], b: px[2], a: px[3], ok: px[3] > 0 };
    } catch(e) {
      return { tainted: true, ok: true }; // tainted = pixels ARE there
    }
  }

  // Set up ResizeObserver (like our code)
  let resizeCount = 0;
  const resizeObs = new ResizeObserver(() => {
    resizeCount++;
    const r = video.getBoundingClientRect();
    const w = Math.round(Math.min(r.width, 1920));
    const h = Math.round(Math.min(r.height, 1080));
    if (w === 0 || h === 0) return;
    if (displayCanvas.width === w && displayCanvas.height === h) return;
    console.log(`[diag] ResizeObserver fired #${resizeCount}: ${displayCanvas.width}x${displayCanvas.height} → ${w}x${h} (CLEARS CANVAS)`);
    displayCanvas.width = w;
    displayCanvas.height = h;
  });
  resizeObs.observe(video);

  function onFrame(now, metadata) {
    frameCount++;
    if (frameCount > 60) {
      resizeObs.disconnect();
      console.log(`\n[diag] === DONE (60 frames) ===`);
      console.log(`[diag] ResizeObserver fired ${resizeCount} times during 60 frames`);
      console.log(`[diag] Display canvas final size: ${displayCanvas.width}x${displayCanvas.height}`);
      console.log(`[diag] Cleaning up...`);
      displayCanvas.remove();
      return;
    }

    // Activate drawing mode after 20 frames (simulates PLAYBACK_STARTED)
    if (frameCount === 20) {
      drawingActive = true;
      console.log(`\n[diag] === drawingActive = true (frame 20, buffer: ${frameBuffer.length}) ===\n`);
    }

    // ---- Step 1: Direct draw to display canvas ----
    displayCtx.drawImage(video, 0, 0, displayCanvas.width, displayCanvas.height);
    const step1 = samplePixel(displayCtx, displayCanvas.width, displayCanvas.height);

    // ---- Step 2: Capture to off-DOM canvas (pool) ----
    const frameCanvas = canvasPool.length > 0 ? canvasPool.pop() : document.createElement('canvas');
    const dimChanged = frameCanvas.width !== CAPTURE_W || frameCanvas.height !== CAPTURE_H;
    if (dimChanged) {
      frameCanvas.width = CAPTURE_W;
      frameCanvas.height = CAPTURE_H;
    }
    const frameCtx = frameCanvas._cachedCtx || (frameCanvas._cachedCtx = frameCanvas.getContext('2d'));
    frameCtx.drawImage(video, 0, 0, CAPTURE_W, CAPTURE_H);
    const step2 = samplePixel(frameCtx, CAPTURE_W, CAPTURE_H);

    frameBuffer.push({ canvas: frameCanvas, time: metadata.mediaTime });

    // ---- Step 3: Buffer draw (overwrites direct draw when active) ----
    let step3 = null;
    if (drawingActive && frameBuffer.length > 1) {
      const old = frameBuffer.shift();
      displayCtx.drawImage(old.canvas, 0, 0, displayCanvas.width, displayCanvas.height);
      step3 = samplePixel(displayCtx, displayCanvas.width, displayCanvas.height);
      canvasPool.push(old.canvas);
    } else if (!drawingActive) {
      // Buffer phase overlay (like drawBufferingOverlay)
      displayCtx.fillStyle = 'rgba(0,0,0,0.5)';
      displayCtx.fillRect(0, 0, displayCanvas.width, displayCanvas.height);
    }

    // ---- Step 4: Hard cap ----
    while (frameBuffer.length > MAX_FRAMES) {
      const d = frameBuffer.shift();
      canvasPool.push(d.canvas);
    }

    // ---- Log key frames ----
    if (frameCount <= 5 || frameCount === 10 || frameCount === 15 ||
        frameCount === 20 || frameCount === 21 || frameCount === 25 ||
        frameCount === 30 || frameCount === 40 || frameCount === 50 || frameCount === 60) {
      const mode = drawingActive ? 'DRAWING' : 'BUFFER';
      const s1 = step1.tainted ? 'TAINTED(ok)' : step1.ok ? `PASS(${step1.r},${step1.g},${step1.b},${step1.a})` : `FAIL(${step1.a})`;
      const s2 = step2.tainted ? 'TAINTED(ok)' : step2.ok ? `PASS(${step2.r},${step2.g},${step2.b},${step2.a})` : `FAIL(${step2.a})`;
      const s3 = step3 ? (step3.tainted ? 'TAINTED(ok)' : step3.ok ? `PASS(${step3.r},${step3.g},${step3.b},${step3.a})` : `FAIL(${step3.a})`) : 'n/a';
      console.log(
        `[diag] frame=${frameCount} [${mode}]  ` +
        `step1(direct)=${s1}  step2(offDOM)=${s2}  step3(bufDraw)=${s3}  ` +
        `pool=${canvasPool.length} buf=${frameBuffer.length} dimChanged=${dimChanged}`
      );
    }

    video.requestVideoFrameCallback(onFrame);
  }

  console.log(`[diag] Starting pipeline diagnostic on YouTube video`);
  console.log(`[diag] Video: ${video.videoWidth}x${video.videoHeight}, Display canvas: ${displayCanvas.width}x${displayCanvas.height}`);
  console.log(`[diag] Capture size: ${CAPTURE_W}x${CAPTURE_H}, Max buffer: ${MAX_FRAMES}`);
  console.log(`[diag] Running 60 frames... (drawingActive at frame 20)\n`);
  video.requestVideoFrameCallback(onFrame);
})();
