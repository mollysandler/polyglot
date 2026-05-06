/**
 * @jest-environment node
 *
 * Tests for canvas sizing, positioning, and resize behavior across different
 * video layouts — YouTube, ESPN, TikTok, small embeds, fullscreen, etc.
 *
 * These tests verify that the canvas overlay correctly matches the video's
 * display area regardless of the site's DOM structure or video dimensions.
 */
const {
  createChromeMock,
  createMockVideo,
  createMockElement,
  createMockDocument,
  loadScript,
} = require("./helpers");

// ---------------------------------------------------------------------------
// Factory: load content-script.js with configurable video/parent geometry
// ---------------------------------------------------------------------------

function loadContentScript(opts = {}) {
  const chrome = createChromeMock();
  const video =
    opts.video !== undefined
      ? opts.video
      : createMockVideo(opts.videoOpts || {});
  const videos = opts.noVideo ? [] : [video];

  function MutationObserver(cb) {
    this.observe = jest.fn();
    this.disconnect = jest.fn();
  }

  const resizeObservers = [];
  function ResizeObserver(cb) {
    this.observe = jest.fn();
    this.disconnect = jest.fn();
    this._cb = cb;
    resizeObservers.push(this);
  }

  const createdElements = [];
  const doc = createMockDocument({
    videos,
    onCreateElement(tag) {
      const el = createMockElement(tag);
      createdElements.push({ tag, el });
      return el;
    },
  });

  const ctx = loadScript("content-script.js", {
    chrome,
    document: doc,
    window: {},
    MutationObserver,
    ResizeObserver,
    getComputedStyle: jest.fn((el) => ({
      position: el?.style?.position || "static",
    })),
    DOMException: class DOMException extends Error {},
    performance: { now: () => 0 },
  });

  return {
    ctx,
    chrome,
    video,
    doc,
    createdElements,
    resizeObservers,
    sendMsg(msg) {
      const resp = jest.fn();
      chrome._simulateMessage(msg, {}, resp);
      return resp;
    },
    getCanvas() {
      const entry = createdElements.find(
        (e) => e.tag === "canvas" && e.el.id === "__live-translator-canvas"
      );
      return entry ? entry.el : null;
    },
    triggerResize() {
      for (const obs of resizeObservers) {
        if (obs._cb) obs._cb();
      }
    },
    triggerRvfc(frameIdx) {
      if (video && video._rvfcCallbacks && video._rvfcCallbacks.length > 0) {
        const cb = video._rvfcCallbacks.shift();
        cb(performance.now(), {
          mediaTime: video.currentTime + (frameIdx || 0) * 0.033,
        });
      }
    },
  };
}

/** Parse a CSS property value from a cssText string. */
function parseCss(cssText, prop) {
  const regex = new RegExp(`${prop}:\\s*([^;]+)`);
  const match = cssText.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Create a mock video with custom geometry for the video and its parent.
 * This allows testing cases where the parent is larger than the video,
 * the video is offset within the parent, etc.
 */
function createSizedVideo({
  displayWidth = 960,
  displayHeight = 540,
  videoTop = 0,
  videoLeft = 0,
  parentWidth = null,
  parentHeight = null,
  parentTop = 0,
  parentLeft = 0,
  parentPosition = "relative",
  videoWidth = 1920,
  videoHeight = 1080,
  paused = false,
  noRVFC = false,
  mediaKeys = null,
} = {}) {
  const pW = parentWidth !== null ? parentWidth : displayWidth;
  const pH = parentHeight !== null ? parentHeight : displayHeight;

  const parent = {
    style: { position: parentPosition, cssText: "" },
    appendChild: jest.fn(),
    removeChild: jest.fn(),
    children: [],
    getBoundingClientRect: jest.fn(() => ({
      width: pW,
      height: pH,
      top: parentTop,
      left: parentLeft,
    })),
  };

  return createMockVideo({
    displayWidth,
    displayHeight,
    videoWidth,
    videoHeight,
    paused,
    noRVFC,
    mediaKeys,
    parent,
    // Override getBoundingClientRect to use custom top/left
    _overrideBCR: { top: videoTop, left: videoLeft },
  });
}

// The default createMockVideo hardcodes top:0,left:0 in getBoundingClientRect.
// For tests needing custom offsets, we override it after creation.
function withVideoOffset(video, { top, left }) {
  video.getBoundingClientRect = jest.fn(() => ({
    width: video.getBoundingClientRect._origWidth || 960,
    height: video.getBoundingClientRect._origHeight || 540,
    top,
    left,
  }));
}

// ===================================================================
// Canvas dimensions at creation — various video sizes
// ===================================================================

describe("canvas sizing — initial dimensions", () => {
  test("YouTube standard (960x540) — canvas matches video display size", () => {
    const env = loadContentScript({
      videoOpts: { displayWidth: 960, displayHeight: 540 },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(960);
    expect(canvas.height).toBe(540);
    expect(parseCss(canvas.style.cssText, "width")).toBe("960px");
    expect(parseCss(canvas.style.cssText, "height")).toBe("540px");
  });

  test("YouTube fullscreen (1920x1080) — canvas matches full HD", () => {
    const env = loadContentScript({
      videoOpts: { displayWidth: 1920, displayHeight: 1080 },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
  });

  test("TikTok vertical (360x640) — canvas handles portrait aspect ratio", () => {
    const env = loadContentScript({
      videoOpts: {
        displayWidth: 360,
        displayHeight: 640,
        videoWidth: 1080,
        videoHeight: 1920,
      },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(360);
    expect(canvas.height).toBe(640);
    expect(parseCss(canvas.style.cssText, "width")).toBe("360px");
    expect(parseCss(canvas.style.cssText, "height")).toBe("640px");
  });

  test("ESPN HD embed (1280x720) — canvas matches large embed", () => {
    const env = loadContentScript({
      videoOpts: { displayWidth: 1280, displayHeight: 720 },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
  });

  test("small embedded player (320x180) — canvas handles tiny videos", () => {
    const env = loadContentScript({
      videoOpts: { displayWidth: 320, displayHeight: 180 },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(180);
  });

  test("square video (480x480) — canvas handles 1:1 aspect ratio", () => {
    const env = loadContentScript({
      videoOpts: {
        displayWidth: 480,
        displayHeight: 480,
        videoWidth: 480,
        videoHeight: 480,
      },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(480);
    expect(canvas.height).toBe(480);
  });

  test("ultrawide video (2560x1080) — clamped to 1920 at creation", () => {
    const env = loadContentScript({
      videoOpts: { displayWidth: 2560, displayHeight: 1080 },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
  });
});

// ===================================================================
// Zero / missing dimensions (video not yet rendered)
// ===================================================================

describe("canvas sizing — zero dimensions", () => {
  // Note: createMockVideo uses `opts.displayWidth || 960` which treats 0 as
  // falsy. To test true zero dimensions we create custom video mocks.

  function makeZeroVideo({ width, height }) {
    const parent = {
      style: { position: "relative", cssText: "" },
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      children: [],
      getBoundingClientRect: jest.fn(() => ({
        width: width,
        height: height,
        top: 0,
        left: 0,
      })),
    };
    const video = createMockVideo({ displayWidth: 1, displayHeight: 1, parent });
    video.getBoundingClientRect = jest.fn(() => ({
      width,
      height,
      top: 0,
      left: 0,
    }));
    return video;
  }

  test("zero-width video creates a 0-width canvas (no guard)", () => {
    // getBoundingClientRect can return 0 when the video is display:none,
    // not yet laid out, or inside a collapsed container (common on ESPN/TikTok).
    const video = makeZeroVideo({ width: 0, height: 540 });
    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas).not.toBeNull();
    // Documents current behavior: no guard against 0 dimensions at creation
    expect(canvas.width).toBe(0);
  });

  test("zero-height video creates a 0-height canvas (no guard)", () => {
    const video = makeZeroVideo({ width: 960, height: 0 });
    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas).not.toBeNull();
    expect(canvas.height).toBe(0);
  });

  test("completely zero-dimension video (0x0) — canvas exists but invisible", () => {
    const video = makeZeroVideo({ width: 0, height: 0 });
    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  test("zero-dimension video recovers when resized to real dimensions", () => {
    // Simulates a video that starts hidden (0x0) and becomes visible later.
    // The ResizeObserver should recover the canvas to the new size.
    const video = makeZeroVideo({ width: 0, height: 0 });
    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas.width).toBe(0);

    // Video becomes visible (e.g. lazy load completes on ESPN/TikTok)
    video.getBoundingClientRect = jest.fn(() => ({
      width: 640,
      height: 360,
      top: 0,
      left: 0,
    }));
    env.triggerResize();
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
  });

  test("zero-dimension video recovers via frame callback", () => {
    // Even without a ResizeObserver event, the frame callback tries
    // to recover a 0x0 canvas by calling resizeCanvas().
    const video = makeZeroVideo({ width: 0, height: 0 });
    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas.width).toBe(0);

    // Video gets real dimensions before next frame callback
    video.getBoundingClientRect = jest.fn(() => ({
      width: 800,
      height: 450,
      top: 0,
      left: 0,
    }));
    // Trigger a frame — onVideoFrame should call resizeCanvas() to recover
    env.triggerRvfc(0);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(450);
  });
});

// ===================================================================
// Canvas positioning relative to parent
// ===================================================================

describe("canvas sizing — positioning", () => {
  test("video aligned with parent — canvas at (0, 0)", () => {
    // Video and parent have same top/left (common on YouTube)
    const env = loadContentScript({
      videoOpts: { displayWidth: 960, displayHeight: 540 },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(parseCss(canvas.style.cssText, "top")).toBe("0px");
    expect(parseCss(canvas.style.cssText, "left")).toBe("0px");
  });

  test("video offset within larger parent — canvas positioned correctly", () => {
    // ESPN pattern: video centered in a larger container
    const parent = {
      style: { position: "relative", cssText: "" },
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      children: [],
      getBoundingClientRect: jest.fn(() => ({
        width: 1200,
        height: 800,
        top: 50,
        left: 100,
      })),
    };

    const video = createMockVideo({
      displayWidth: 960,
      displayHeight: 540,
      parent,
    });
    // Override video BCR to simulate centering inside the parent
    video.getBoundingClientRect = jest.fn(() => ({
      width: 960,
      height: 540,
      top: 180, // 50 + (800-540)/2 = 180
      left: 220, // 100 + (1200-960)/2 = 220
    }));

    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas).not.toBeNull();
    // Canvas should be offset from parent, not from viewport
    expect(parseCss(canvas.style.cssText, "top")).toBe("130px"); // 180 - 50
    expect(parseCss(canvas.style.cssText, "left")).toBe("120px"); // 220 - 100
    // Canvas dimensions should match video, not parent
    expect(canvas.width).toBe(960);
    expect(canvas.height).toBe(540);
  });

  test("video at top-left of scrolled parent — canvas still at correct offset", () => {
    const parent = {
      style: { position: "relative", cssText: "" },
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      children: [],
      getBoundingClientRect: jest.fn(() => ({
        width: 960,
        height: 540,
        top: -200, // scrolled up
        left: 50,
      })),
    };

    const video = createMockVideo({
      displayWidth: 960,
      displayHeight: 540,
      parent,
    });
    video.getBoundingClientRect = jest.fn(() => ({
      width: 960,
      height: 540,
      top: -200,
      left: 50,
    }));

    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(parseCss(canvas.style.cssText, "top")).toBe("0px");
    expect(parseCss(canvas.style.cssText, "left")).toBe("0px");
  });

  test("canvas has position: absolute and z-index for overlay", () => {
    const env = loadContentScript({
      videoOpts: { displayWidth: 640, displayHeight: 360 },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(parseCss(canvas.style.cssText, "position")).toBe("absolute");
    expect(parseCss(canvas.style.cssText, "z-index")).toBe("999998");
    expect(parseCss(canvas.style.cssText, "pointer-events")).toBe("none");
  });
});

// ===================================================================
// Parent position handling
// ===================================================================

describe("canvas sizing — parent position", () => {
  test("static parent gets position: relative set", () => {
    const parent = {
      style: { position: "static", cssText: "" },
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      children: [],
      getBoundingClientRect: jest.fn(() => ({
        width: 960,
        height: 540,
        top: 0,
        left: 0,
      })),
    };

    const video = createMockVideo({
      displayWidth: 960,
      displayHeight: 540,
      parent,
    });

    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });
    expect(parent.style.position).toBe("relative");
  });

  test("relative parent not modified", () => {
    const parent = {
      style: { position: "relative", cssText: "" },
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      children: [],
      getBoundingClientRect: jest.fn(() => ({
        width: 960,
        height: 540,
        top: 0,
        left: 0,
      })),
    };

    const video = createMockVideo({
      displayWidth: 960,
      displayHeight: 540,
      parent,
    });

    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });
    expect(parent.style.position).toBe("relative");
  });
});

// ===================================================================
// Resize behavior (ResizeObserver)
// ===================================================================

describe("canvas sizing — resize", () => {
  test("resize updates canvas to new video dimensions", () => {
    const env = loadContentScript({
      videoOpts: { displayWidth: 960, displayHeight: 540 },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas.width).toBe(960);

    // Simulate video resize (e.g., entering theater mode)
    env.video.getBoundingClientRect = jest.fn(() => ({
      width: 1280,
      height: 720,
      top: 0,
      left: 0,
    }));
    env.triggerResize();
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    expect(canvas.style.width).toBe("1280px");
    expect(canvas.style.height).toBe("720px");
  });

  test("resize to zero is rejected (guard in resizeCanvas)", () => {
    const env = loadContentScript({
      videoOpts: { displayWidth: 960, displayHeight: 540 },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();
    expect(canvas.width).toBe(960);

    // Simulate video becoming hidden (display:none)
    env.video.getBoundingClientRect = jest.fn(() => ({
      width: 0,
      height: 0,
      top: 0,
      left: 0,
    }));
    env.triggerResize();
    // Canvas should retain previous dimensions
    expect(canvas.width).toBe(960);
    expect(canvas.height).toBe(540);
  });

  test("resize clamps width to 1920", () => {
    const env = loadContentScript({
      videoOpts: { displayWidth: 960, displayHeight: 540 },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();

    // Simulate fullscreen on a 4K display
    env.video.getBoundingClientRect = jest.fn(() => ({
      width: 3840,
      height: 2160,
      top: 0,
      left: 0,
    }));
    env.triggerResize();
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
  });

  test("resize clamps height to 1080", () => {
    const env = loadContentScript({
      videoOpts: { displayWidth: 960, displayHeight: 540 },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();

    // Ultrawide scenario: width fine, height over 1080
    env.video.getBoundingClientRect = jest.fn(() => ({
      width: 1600,
      height: 1200,
      top: 0,
      left: 0,
    }));
    env.triggerResize();
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1080);
  });

  test("resize skipped when dimensions unchanged", () => {
    const env = loadContentScript({
      videoOpts: { displayWidth: 960, displayHeight: 540 },
    });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();

    // Store original cssText — should not change on no-op resize
    const originalWidth = canvas.width;
    env.triggerResize();
    expect(canvas.width).toBe(originalWidth);
  });

  test("resize updates position when video moves within parent", () => {
    const parent = {
      style: { position: "relative", cssText: "" },
      appendChild: jest.fn(function (child) {
        this.children.push(child);
        // Mirror real DOM: set parentElement on the child
        child.parentElement = this;
      }),
      removeChild: jest.fn(),
      children: [],
      getBoundingClientRect: jest.fn(() => ({
        width: 1200,
        height: 800,
        top: 0,
        left: 0,
      })),
    };

    const video = createMockVideo({
      displayWidth: 960,
      displayHeight: 540,
      parent,
    });
    video.getBoundingClientRect = jest.fn(() => ({
      width: 960,
      height: 540,
      top: 0,
      left: 0,
    }));

    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });

    // Simulate video moving to center of parent (and changing size slightly)
    video.getBoundingClientRect = jest.fn(() => ({
      width: 961, // must differ to pass the early-return check
      height: 541,
      top: 130,
      left: 120,
    }));
    env.triggerResize();
    const canvas = env.getCanvas();
    expect(canvas.style.top).toBe("130px");
    expect(canvas.style.left).toBe("120px");
  });
});

// ===================================================================
// Frame capture with different intrinsic dimensions
// ===================================================================

describe("canvas sizing — frame capture aspect ratios", () => {
  test("16:9 landscape (1920x1080) — frame capture uses correct aspect", () => {
    const env = loadContentScript({
      videoOpts: {
        displayWidth: 960,
        displayHeight: 540,
        videoWidth: 1920,
        videoHeight: 1080,
      },
    });
    env.sendMsg({ type: "START_SYNC" });

    // Trigger a frame callback — should not throw
    expect(() => env.triggerRvfc(0)).not.toThrow();
  });

  test("9:16 portrait (1080x1920) — TikTok-like vertical video", () => {
    const env = loadContentScript({
      videoOpts: {
        displayWidth: 360,
        displayHeight: 640,
        videoWidth: 1080,
        videoHeight: 1920,
      },
    });
    env.sendMsg({ type: "START_SYNC" });
    expect(() => env.triggerRvfc(0)).not.toThrow();
  });

  test("1:1 square (1080x1080) — Instagram-style video", () => {
    const env = loadContentScript({
      videoOpts: {
        displayWidth: 480,
        displayHeight: 480,
        videoWidth: 1080,
        videoHeight: 1080,
      },
    });
    env.sendMsg({ type: "START_SYNC" });
    expect(() => env.triggerRvfc(0)).not.toThrow();
  });

  test("zero intrinsic dimensions (videoWidth=0) — frame callback exits early", () => {
    // When video metadata hasn't loaded, videoWidth/videoHeight are 0.
    // onVideoFrame should bail out without crashing.
    const env = loadContentScript({
      videoOpts: {
        displayWidth: 960,
        displayHeight: 540,
        videoWidth: 0,
        videoHeight: 0,
      },
    });
    env.sendMsg({ type: "START_SYNC" });
    // Should not throw despite 0/0 = NaN aspect ratio
    expect(() => env.triggerRvfc(0)).not.toThrow();
    // Should re-register for next frame (requestVideoFrameCallback called again)
    expect(env.video.requestVideoFrameCallback.mock.calls.length).toBeGreaterThan(1);
  });

  test("very wide intrinsic (2560x1080 ultrawide) — capture scales down", () => {
    const env = loadContentScript({
      videoOpts: {
        displayWidth: 1280,
        displayHeight: 540,
        videoWidth: 2560,
        videoHeight: 1080,
      },
    });
    env.sendMsg({ type: "START_SYNC" });
    expect(() => env.triggerRvfc(0)).not.toThrow();
  });

  test("very tall intrinsic (720x1280 phone recording)", () => {
    const env = loadContentScript({
      videoOpts: {
        displayWidth: 405,
        displayHeight: 720,
        videoWidth: 720,
        videoHeight: 1280,
      },
    });
    env.sendMsg({ type: "START_SYNC" });
    expect(() => env.triggerRvfc(0)).not.toThrow();
  });
});

// ===================================================================
// Real-world site patterns
// ===================================================================

describe("canvas sizing — site-specific patterns", () => {
  test("ESPN: video inside a player wrapper larger than video", () => {
    // ESPN pattern: <div class="player-wrapper" style="position:relative">
    //                <video> (smaller than wrapper due to padding/controls)
    const parent = {
      style: { position: "relative", cssText: "" },
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      children: [],
      getBoundingClientRect: jest.fn(() => ({
        width: 1000,
        height: 600,
        top: 100,
        left: 50,
      })),
    };

    const video = createMockVideo({
      displayWidth: 960,
      displayHeight: 540,
      videoWidth: 1920,
      videoHeight: 1080,
      parent,
    });
    video.getBoundingClientRect = jest.fn(() => ({
      width: 960,
      height: 540,
      top: 130, // offset within wrapper
      left: 70,
    }));

    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();

    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(960);
    expect(canvas.height).toBe(540);
    expect(parseCss(canvas.style.cssText, "top")).toBe("30px"); // 130 - 100
    expect(parseCss(canvas.style.cssText, "left")).toBe("20px"); // 70 - 50
  });

  test("TikTok: vertical video in scrolling feed", () => {
    const parent = {
      style: { position: "relative", cssText: "" },
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      children: [],
      getBoundingClientRect: jest.fn(() => ({
        width: 400,
        height: 710,
        top: 20,
        left: 400,
      })),
    };

    const video = createMockVideo({
      displayWidth: 400,
      displayHeight: 710,
      videoWidth: 1080,
      videoHeight: 1920,
      parent,
    });
    video.getBoundingClientRect = jest.fn(() => ({
      width: 400,
      height: 710,
      top: 20,
      left: 400,
    }));

    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();

    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(710);
    expect(parseCss(canvas.style.cssText, "top")).toBe("0px");
    expect(parseCss(canvas.style.cssText, "left")).toBe("0px");

    // Frame capture should work with portrait aspect ratio
    expect(() => env.triggerRvfc(0)).not.toThrow();
  });

  test("Twitter/X: small inline video player", () => {
    const parent = {
      style: { position: "static", cssText: "" }, // Twitter uses static by default
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      children: [],
      getBoundingClientRect: jest.fn(() => ({
        width: 504,
        height: 284,
        top: 800,
        left: 200,
      })),
    };

    const video = createMockVideo({
      displayWidth: 504,
      displayHeight: 284,
      videoWidth: 1280,
      videoHeight: 720,
      parent,
    });
    video.getBoundingClientRect = jest.fn(() => ({
      width: 504,
      height: 284,
      top: 800,
      left: 200,
    }));

    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });

    // Parent should be changed from static to relative
    expect(parent.style.position).toBe("relative");

    const canvas = env.getCanvas();
    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(504);
    expect(canvas.height).toBe(284);
  });

  test("Netflix-style: video fills viewport, parent is body-level", () => {
    const parent = {
      style: { position: "relative", cssText: "" },
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      children: [],
      getBoundingClientRect: jest.fn(() => ({
        width: 1920,
        height: 1080,
        top: 0,
        left: 0,
      })),
    };

    const video = createMockVideo({
      displayWidth: 1920,
      displayHeight: 1080,
      videoWidth: 3840,
      videoHeight: 2160,
      parent,
    });
    video.getBoundingClientRect = jest.fn(() => ({
      width: 1920,
      height: 1080,
      top: 0,
      left: 0,
    }));

    const env = loadContentScript({ video });
    env.sendMsg({ type: "START_SYNC" });
    const canvas = env.getCanvas();

    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
  });
});

// ===================================================================
// Cleanup restores state for all video sizes
// ===================================================================

describe("canvas sizing — cleanup", () => {
  test("cleanup after portrait video restores visibility", () => {
    const env = loadContentScript({
      videoOpts: {
        displayWidth: 360,
        displayHeight: 640,
        videoWidth: 1080,
        videoHeight: 1920,
      },
    });
    env.sendMsg({ type: "START_SYNC" });
    expect(env.video.classList.contains("__lt-hidden")).toBe(true);
    env.sendMsg({ type: "VIDEO_CLEANUP" });
    expect(env.video.classList.contains("__lt-hidden")).toBe(false);
  });

  test("cleanup after zero-dimension video does not throw", () => {
    const env = loadContentScript({
      videoOpts: { displayWidth: 0, displayHeight: 0 },
    });
    env.sendMsg({ type: "START_SYNC" });
    expect(() => env.sendMsg({ type: "VIDEO_CLEANUP" })).not.toThrow();
  });
});
