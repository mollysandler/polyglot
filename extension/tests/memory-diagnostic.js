// Memory diagnostic — paste into YouTube DevTools console.
// Tests whether creating many off-DOM canvases causes drawImage to fail.
// Compares: 20 canvases (like the working diagnostic) vs 150 canvases (like our pipeline).
(function() {
  const video = document.querySelector('video');
  if (!video || video.videoWidth === 0) { console.log('No playing video found'); return; }

  const W = 1280, H = 720; // same as our pipeline capture resolution

  function testDrawImage(label) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.drawImage(video, 0, 0, W, H);
    try {
      const px = ctx.getImageData(W/2, H/2, 1, 1).data;
      const ok = px[3] > 0;
      console.log(`  ${label}: ${ok ? 'PASS ✅' : 'FAIL ❌'} rgba(${px[0]},${px[1]},${px[2]},${px[3]})`);
      return ok;
    } catch(e) {
      console.log(`  ${label}: TAINTED ✅ (pixels drawn, cross-origin)`);
      return true;
    }
  }

  console.log(`\n=== MEMORY DIAGNOSTIC ===`);
  console.log(`Video: ${video.videoWidth}x${video.videoHeight}, Canvas size: ${W}x${H}`);
  console.log(`Each canvas: ~${(W * H * 4 / 1024 / 1024).toFixed(1)}MB GPU memory\n`);

  // Test 1: Baseline (no extra canvases)
  console.log(`--- Test 1: Baseline (0 extra canvases) ---`);
  testDrawImage('drawImage');

  // Test 2: After creating 20 canvases (like diagnostic)
  console.log(`\n--- Test 2: After 20 canvases (~${(20 * W * H * 4 / 1024 / 1024).toFixed(0)}MB) ---`);
  const batch20 = [];
  for (let i = 0; i < 20; i++) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').drawImage(video, 0, 0, W, H);
    batch20.push(c);
  }
  testDrawImage('drawImage after 20');

  // Test 3: After creating 80 canvases (cumulative 100)
  console.log(`\n--- Test 3: After 100 canvases (~${(100 * W * H * 4 / 1024 / 1024).toFixed(0)}MB) ---`);
  const batch80 = [];
  for (let i = 0; i < 80; i++) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').drawImage(video, 0, 0, W, H);
    batch80.push(c);
  }
  testDrawImage('drawImage after 100');

  // Test 4: After creating 50 more (cumulative 150 — same as our buffer)
  console.log(`\n--- Test 4: After 150 canvases (~${(150 * W * H * 4 / 1024 / 1024).toFixed(0)}MB) ---`);
  const batch50 = [];
  for (let i = 0; i < 50; i++) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').drawImage(video, 0, 0, W, H);
    batch50.push(c);
  }
  testDrawImage('drawImage after 150');

  // Test 5: After creating 50 more (cumulative 200 — beyond our buffer)
  console.log(`\n--- Test 5: After 200 canvases (~${(200 * W * H * 4 / 1024 / 1024).toFixed(0)}MB) ---`);
  const batch50b = [];
  for (let i = 0; i < 50; i++) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').drawImage(video, 0, 0, W, H);
    batch50b.push(c);
  }
  testDrawImage('drawImage after 200');

  // Test 6: Release all canvases, test again
  console.log(`\n--- Test 6: After releasing all canvases (GC pending) ---`);
  batch20.length = 0;
  batch80.length = 0;
  batch50.length = 0;
  batch50b.length = 0;
  testDrawImage('drawImage after release');

  // Test 7: Same test but at 360p (our proposed fix resolution)
  console.log(`\n--- Test 7: 150 canvases at 360p (640x360, ~${(150 * 640 * 360 * 4 / 1024 / 1024).toFixed(0)}MB) ---`);
  const small = [];
  for (let i = 0; i < 150; i++) {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    c.getContext('2d').drawImage(video, 0, 0, 640, 360);
    small.push(c);
  }
  testDrawImage('drawImage with 150 small canvases alive');
  small.length = 0;

  console.log(`\n=== DONE ===\n`);
})();
