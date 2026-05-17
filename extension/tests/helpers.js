/**
 * Shared test helpers: mock factories and script-loading utilities.
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");

function flushPromises() {
  return new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Chrome API mock
// ---------------------------------------------------------------------------

function createChromeMock() {
  const messageListeners = [];
  const actionListeners = [];
  const tabRemovedListeners = [];
  const tabUpdatedListeners = [];
  const tabActivatedListeners = [];

  const mock = {
    runtime: {
      onMessage: {
        addListener: (fn) => messageListeners.push(fn),
        removeListener: (fn) => {
          const i = messageListeners.indexOf(fn);
          if (i >= 0) messageListeners.splice(i, 1);
        },
      },
      sendMessage: jest.fn(() => Promise.resolve()),
      getContexts: jest.fn(() => Promise.resolve([])),
    },
    storage: {
      local: {
        _data: {},
        get: jest.fn(function (keys, cb) {
          if (cb) { cb(this._data); return; }
          return Promise.resolve({ ...this._data });
        }),
        set: jest.fn(function (data) {
          Object.assign(this._data, data);
          return Promise.resolve();
        }),
        remove: jest.fn(function (keys) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) delete this._data[k];
          return Promise.resolve();
        }),
      },
    },
    tabs: {
      query: jest.fn(() => Promise.resolve([{ id: 42, url: "https://example.com" }])),
      update: jest.fn(() => Promise.resolve({})),
      sendMessage: jest.fn((_tabId, _msg, cb) => { if (cb) cb({}); }),
      onRemoved: { addListener: (fn) => tabRemovedListeners.push(fn) },
      onUpdated: { addListener: (fn) => tabUpdatedListeners.push(fn) },
      onActivated: { addListener: (fn) => tabActivatedListeners.push(fn) },
    },
    tabCapture: { getMediaStreamId: jest.fn(() => Promise.resolve("stream-id-123")) },
    scripting: { executeScript: jest.fn(() => Promise.resolve([])) },
    sidePanel: { open: jest.fn() },
    offscreen: { createDocument: jest.fn(() => Promise.resolve()) },
    action: { onClicked: { addListener: (fn) => actionListeners.push(fn) } },
    permissions: {
      request: jest.fn(() => Promise.resolve(true)),
      contains: jest.fn(() => Promise.resolve(true)),
      remove: jest.fn(() => Promise.resolve(true)),
    },

    _messageListeners: messageListeners,
    _actionListeners: actionListeners,
    _tabRemovedListeners: tabRemovedListeners,
    _tabUpdatedListeners: tabUpdatedListeners,
    _tabActivatedListeners: tabActivatedListeners,
    _simulateTabRemoved(tabId) {
      for (const fn of tabRemovedListeners) fn(tabId, {});
    },
    _simulateTabUpdated(tabId, changeInfo) {
      for (const fn of tabUpdatedListeners) fn(tabId, changeInfo || {}, { id: tabId });
    },
    _simulateTabActivated(tabId, windowId) {
      for (const fn of tabActivatedListeners) fn({ tabId, windowId: windowId || 1 });
    },
    _simulateMessage(msg, sender, sendResponse) {
      let isAsync = false;
      const resp = sendResponse || jest.fn();
      for (const fn of messageListeners) {
        if (fn(msg, sender || {}, resp) === true) isAsync = true;
      }
      return { isAsync, sendResponse: resp };
    },
  };
  return mock;
}

// ---------------------------------------------------------------------------
// WebSocket mock constructor
// ---------------------------------------------------------------------------

function createMockWSConstructor() {
  const instances = [];
  function WS(url) {
    this.url = url;
    this.readyState = 0;
    this.binaryType = "arraybuffer";
    this.send = jest.fn();
    this.close = jest.fn(function () { this.readyState = 3; }.bind(this));
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
    instances.push(this);
  }
  WS.CONNECTING = 0;
  WS.OPEN = 1;
  WS.CLOSING = 2;
  WS.CLOSED = 3;
  WS._instances = instances;
  WS._last = () => instances[instances.length - 1];
  return WS;
}

// ---------------------------------------------------------------------------
// AudioContext mock
// ---------------------------------------------------------------------------

function createMockAudioContext(opts = {}) {
  let time = opts.startTime || 0;
  const sources = [];
  const ctx = {
    get currentTime() { return time; },
    _setTime(t) { time = t; },
    _advanceTime(dt) { time += dt; },
    state: opts.state || "running",
    sampleRate: opts.sampleRate || 44100,
    resume: jest.fn(function () { ctx.state = "running"; return Promise.resolve(); }),
    close: jest.fn(() => Promise.resolve()),
    destination: {},
    createBufferSource() {
      const src = {
        buffer: null,
        playbackRate: { value: 1 },
        onended: null,
        connect: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
        disconnect: jest.fn(),
        _triggerEnded() { if (src.onended) src.onended(); },
      };
      sources.push(src);
      return src;
    },
    createMediaStreamSource: jest.fn(() => ({ connect: jest.fn(), disconnect: jest.fn() })),
    audioWorklet: { addModule: jest.fn(() => Promise.resolve()) },
    decodeAudioData: jest.fn(() => {
      const dur = opts.decodedDuration || 1.0;
      const sr = 44100;
      const len = Math.round(dur * sr);
      const data = new Float32Array(len);
      for (let i = 0; i < len; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
      return Promise.resolve({
        duration: dur, length: len, sampleRate: sr, numberOfChannels: 1,
        getChannelData: () => data,
      });
    }),
    _sources: sources,
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// AudioBuffer mock (works as constructor via `new`)
// ---------------------------------------------------------------------------

function createMockAudioBuffer(opts = {}) {
  const len = opts.length || 44100;
  const sr = opts.sampleRate || 44100;
  const nch = opts.numberOfChannels || 1;
  const channels = [];
  for (let i = 0; i < nch; i++) channels.push(new Float32Array(len));
  return { length: len, sampleRate: sr, numberOfChannels: nch, duration: len / sr, getChannelData: (ch) => channels[ch] };
}

// ---------------------------------------------------------------------------
// Video element mock
// ---------------------------------------------------------------------------

function createMockVideo(opts = {}) {
  const listeners = {};
  const rvfcCallbacks = [];
  let rvfcCounter = 0;

  const video = {
    paused: opts.paused !== undefined ? opts.paused : false,
    ended: false,
    currentTime: opts.currentTime || 0,
    videoWidth: opts.videoWidth || 1920,
    videoHeight: opts.videoHeight || 1080,
    playbackRate: 1.0,
    mediaKeys: opts.mediaKeys || null,
    style: { opacity: "", cssText: "", position: "" },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    parentElement: null,
    play: jest.fn(() => Promise.resolve()),
    pause: jest.fn(),
    addEventListener: jest.fn((ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); }),
    removeEventListener: jest.fn((ev, fn) => { if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn); }),
    getBoundingClientRect: jest.fn(() => ({ width: opts.displayWidth || 960, height: opts.displayHeight || 540, top: 0, left: 0 })),
    _listeners: listeners,
    _rvfcCallbacks: rvfcCallbacks,
    _triggerEvent(ev) { (listeners[ev] || []).forEach((fn) => fn()); },
  };

  if (!opts.noRVFC) {
    video.requestVideoFrameCallback = jest.fn((cb) => { rvfcCallbacks.push(cb); return ++rvfcCounter; });
    video.cancelVideoFrameCallback = jest.fn();
  }

  video.parentElement = opts.parent || {
    style: { position: opts.parentPosition || "relative", cssText: "" },
    appendChild: jest.fn(),
    removeChild: jest.fn(),
    children: [],
    getBoundingClientRect: jest.fn(() => ({ width: opts.displayWidth || 960, height: opts.displayHeight || 540, top: 0, left: 0 })),
  };

  return video;
}

// ---------------------------------------------------------------------------
// DOM element mock
// ---------------------------------------------------------------------------

function createMockElement(tag) {
  const children = [];
  const listeners = {};
  let cachedCtx = null;
  return {
    tagName: (tag || "div").toUpperCase(),
    id: "", className: "", textContent: "", innerHTML: "", value: "", disabled: false,
    style: { cssText: "", width: "", height: "", position: "", opacity: "" },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    children, childNodes: children,
    appendChild(child) { children.push(child); return child; },
    remove: jest.fn(),
    querySelector: jest.fn(function (sel) {
      if (sel.startsWith(".")) {
        const cls = sel.slice(1);
        return children.find((c) => c.className && c.className.includes(cls)) || null;
      }
      if (sel.startsWith("#")) {
        const id = sel.slice(1);
        return children.find((c) => c.id === id) || null;
      }
      return null;
    }),
    querySelectorAll: jest.fn(function (sel) {
      if (sel.startsWith(".")) {
        const cls = sel.slice(1);
        return children.filter((c) => c.className && c.className.includes(cls));
      }
      return [];
    }),
    addEventListener: jest.fn((ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); }),
    removeEventListener: jest.fn(),
    getBoundingClientRect: jest.fn(() => ({ width: 0, height: 0, top: 0, left: 0 })),
    getContext: jest.fn(function () {
      if (!cachedCtx) {
        cachedCtx = {
          drawImage: jest.fn(),
          getImageData: jest.fn(() => ({ data: new Uint8ClampedArray(64).fill(128) })),
          fillRect: jest.fn(),
          fillText: jest.fn(),
          fillStyle: "",
          font: "",
          textAlign: "",
          textBaseline: "",
        };
      }
      return cachedCtx;
    }),
    scrollTop: 0,
    get scrollHeight() { return 1000; },
    _listeners: listeners,
    _triggerClick() { (listeners.click || []).forEach((fn) => fn()); },
  };
}

// ---------------------------------------------------------------------------
// Document mock
// ---------------------------------------------------------------------------

function createMockDocument(config = {}) {
  const elements = config.elements || {};
  const evListeners = {};
  const videos = config.videos || [];

  return {
    getElementById(id) { return elements[id] || createMockElement("div"); },
    createElement(tag) { return config.onCreateElement ? config.onCreateElement(tag) : createMockElement(tag); },
    querySelectorAll(sel) { return sel === "video" ? videos : []; },
    querySelector(sel) { return config.onQuerySelector ? config.onQuerySelector(sel) : null; },
    head: createMockElement("head"),
    body: createMockElement("body"),
    documentElement: createMockElement("html"),
    addEventListener(ev, fn) { (evListeners[ev] = evListeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) { if (evListeners[ev]) evListeners[ev] = evListeners[ev].filter((f) => f !== fn); },
    _eventListeners: evListeners,
  };
}

// ---------------------------------------------------------------------------
// Navigator mock
// ---------------------------------------------------------------------------

function createMockNavigator() {
  return {
    mediaDevices: {
      getUserMedia: jest.fn(() => Promise.resolve({ getTracks: () => [{ stop: jest.fn() }] })),
    },
  };
}

// ---------------------------------------------------------------------------
// Script loading (VM sandbox)
// ---------------------------------------------------------------------------

function loadScript(relativePath, globals = {}) {
  const fullPath = path.resolve(__dirname, "..", relativePath);
  const code = fs.readFileSync(fullPath, "utf-8");
  const sandbox = {
    console: globals.console || { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    setTimeout: globals.setTimeout || setTimeout,
    clearTimeout: globals.clearTimeout || clearTimeout,
    setInterval: globals.setInterval || setInterval,
    clearInterval: globals.clearInterval || clearInterval,
    ...globals,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { filename: relativePath });
  return context;
}

function loadOffscreenScript(globals = {}) {
  const fullPath = path.resolve(__dirname, "..", "offscreen", "offscreen.js");
  let code = fs.readFileSync(fullPath, "utf-8");

  code += `
var __test = {};
function __readState() {
  __test.ws = ws;
  __test.isPlaying = isPlaying;
  __test.decodedQueue = decodedQueue;
  __test.bufferedDurationSec = bufferedDurationSec;
  __test.totalAudioCapturedSec = totalAudioCapturedSec;
  __test.currentUtterance = currentUtterance;
  __test.syncMode = syncMode;
  __test.silenceFrames = silenceFrames;
  __test.highWaterEndSec = highWaterEndSec;
  __test.firstFrameSentTime = firstFrameSentTime;
  __test.firstUtteranceReceivedTime = firstUtteranceReceivedTime;
  __test.measuredLatencySec = measuredLatencySec;
  __test.latencySentToContent = latencySentToContent;
  __test.nextPlayTime = nextPlayTime;
  __test.lastOriginalEndSec = lastOriginalEndSec;
  __test.seenUtteranceKeys = seenUtteranceKeys;
  __test.capturedFrameCount = capturedFrameCount;
  __test.seekbackFrameMark = seekbackFrameMark;
  __test.inReplayZone = inReplayZone;
  __test.pendingCaptions = pendingCaptions;
  __test.scheduledAudioTimes = scheduledAudioTimes;
}
`;

  const sandbox = {
    console: globals.console || { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    setTimeout: globals.setTimeout || setTimeout,
    clearTimeout: globals.clearTimeout || clearTimeout,
    setInterval: globals.setInterval || setInterval,
    clearInterval: globals.clearInterval || clearInterval,
    ...globals,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { filename: "offscreen/offscreen.js" });
  return context;
}

module.exports = {
  flushPromises,
  createChromeMock,
  createMockWSConstructor,
  createMockAudioContext,
  createMockAudioBuffer,
  createMockVideo,
  createMockElement,
  createMockDocument,
  createMockNavigator,
  loadScript,
  loadOffscreenScript,
};
