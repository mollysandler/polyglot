/**
 * @jest-environment node
 *
 * Tests for sidepanel.js — UI controller for language selection,
 * start/stop, caption display, and status management.
 *
 * Ideal behavior:
 *  - Responsive UI that never gets stuck in a broken state
 *  - Caption dedup without false positives on short common strings
 *  - Timeout handling that cleanly resets the UI
 *  - Correct status transitions for every message type
 */
const {
  flushPromises,
  createChromeMock,
  createMockElement,
  loadScript,
} = require("./helpers");

// ---------------------------------------------------------------------------
// Create all mock DOM elements the sidepanel.js expects by ID
// ---------------------------------------------------------------------------

function createSidepanelDOM() {
  const els = {};
  const ids = [
    "startStopBtn", "statusBadge", "captions", "emptyState",
    "silenceWarning", "warmingUp", "warmingText", "elapsedTimer",
    "sourceLang", "targetLang", "syncBadge",
    "errorBanner", "errorMessage", "retryBtn", "dismissBtn",
    "pauseResumeBtn", "newVideoBtn",
    "backendUrl", "saveBackendBtn", "resetBackendBtn", "backendStatus",
  ];
  for (const id of ids) {
    els[id] = createMockElement(id === "sourceLang" || id === "targetLang" ? "select" : "div");
    els[id].id = id;
  }
  els.sourceLang.value = "en";
  els.targetLang.value = "es";
  els.backendUrl.value = "";

  return els;
}

function loadSidepanel(opts = {}) {
  const chrome = createChromeMock();
  const els = createSidepanelDOM();

  if (opts.storedData) {
    chrome.storage.local._data = { ...opts.storedData };
  }

  const intervals = [];
  let iid = 1; 
  let dateNow = 1000;

  const doc = {
    getElementById: (id) => els[id] || createMockElement("div"),
    createElement: (tag) => createMockElement(tag),
    querySelectorAll: () => [],
  };

  const ctx = loadScript("sidepanel/sidepanel.js", {
    chrome,
    document: doc,
    window: {},
    URL,
    setInterval: (fn, ms) => { const id = iid++; intervals.push({ fn, ms, id }); return id; },
    clearInterval: (id) => { const i = intervals.findIndex((t) => t.id === id); if (i >= 0) intervals.splice(i, 1); },
    setTimeout: opts.setTimeout || setTimeout,
    clearTimeout: opts.clearTimeout || clearTimeout,
    Date: { now: () => dateNow },
  });

  return {
    ctx, chrome, els, intervals, doc,
    setDateNow(v) { dateNow = v; },
    sendMsg(msg) {
      const resp = jest.fn();
      chrome._simulateMessage(msg, {}, resp);
      return resp;
    },
    sentMessages() { return chrome.runtime.sendMessage.mock.calls.map((c) => c[0]); },
    tickInterval(ms) {
      const iv = intervals.find((i) => i.ms === ms);
      if (iv) iv.fn();
    },
    clickStart() {
      const listener = els.startStopBtn._listeners.click;
      if (listener && listener.length) listener[0]();
    },
    clickRetry() {
      const listener = els.retryBtn._listeners.click;
      if (listener && listener.length) listener[0]();
    },
    clickDismiss() {
      const listener = els.dismissBtn._listeners.click;
      if (listener && listener.length) listener[0]();
    },
    startPlayback() {
      chrome._simulateMessage({ type: "HIDE_OVERLAY" }, {});
    },
  };
}

// ===================================================================
// Initialization
// ===================================================================

describe("initialization", () => {
  test("loads saved source language from storage", () => {
    const env = loadSidepanel({ storedData: { sourceLang: "fr" } });
    expect(env.els.sourceLang.value).toBe("fr");
  });

  test("loads saved target language from storage", () => {
    const env = loadSidepanel({ storedData: { targetLang: "de" } });
    expect(env.els.targetLang.value).toBe("de");
  });

  test("loads and renders caption history", () => {
    const env = loadSidepanel({
      storedData: {
        captionHistory: [
          { speaker: "Speaker 1", translated: "Hello", original: "Hola" },
        ],
      },
    });
    expect(env.els.emptyState.classList._set.has("hidden")).toBe(true);
  });

  test("handles missing storage data gracefully (first run)", () => {
    const env = loadSidepanel();
    expect(env.els.sourceLang.value).toBe("en");
    expect(env.els.targetLang.value).toBe("es");
  });
});

// ===================================================================
// Language selection persistence
// ===================================================================

describe("language selection", () => {
  test("source language change saved to storage", () => {
    const env = loadSidepanel();
    env.els.sourceLang.value = "ja";
    const listener = env.els.sourceLang._listeners.change;
    if (listener && listener.length) listener[0]();
    expect(env.chrome.storage.local.set).toHaveBeenCalledWith({ sourceLang: "ja" });
  });

  test("target language change saved to storage", () => {
    const env = loadSidepanel();
    env.els.targetLang.value = "ko";
    const listener = env.els.targetLang._listeners.change;
    if (listener && listener.length) listener[0]();
    expect(env.chrome.storage.local.set).toHaveBeenCalledWith({ targetLang: "ko" });
  });
});

// ===================================================================
// Start / Stop flow
// ===================================================================

describe("start/stop", () => {
  test("start disables button", async () => {
    const env = loadSidepanel();
    env.clickStart();
    expect(env.els.startStopBtn.disabled).toBe(true);
  });

  test("start shows warming-up spinner", () => {
    const env = loadSidepanel();
    env.clickStart();
    expect(env.els.warmingUp.classList._set.has("hidden")).toBe(false);
  });

  test("start sets status to connecting", () => {
    const env = loadSidepanel();
    env.clickStart();
    expect(env.els.statusBadge.className).toContain("connecting");
  });

  test("start sends START_CAPTURE to service worker", () => {
    const env = loadSidepanel();
    env.clickStart();
    expect(env.sentMessages()).toContainEqual(
      expect.objectContaining({
        type: "START_CAPTURE",
        sourceLang: "en",
        targetLang: "es",
      })
    );
  });

  test("successful start changes button to Stop", async () => {
    const env = loadSidepanel();
    env.chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: true });
    env.clickStart();
    await flushPromises();
    expect(env.els.startStopBtn.textContent).toBe("Stop");
    expect(env.els.startStopBtn.disabled).toBe(false);
  });

  test("error response shows error banner and re-enables button", async () => {
    const env = loadSidepanel();
    env.chrome.runtime.sendMessage.mockResolvedValueOnce({ error: "No tab" });
    env.clickStart();
    await flushPromises();
    expect(env.els.errorBanner.classList._set.has("hidden")).toBe(false);
    expect(env.els.errorMessage.textContent).toBe("No tab");
    expect(env.els.startStopBtn.disabled).toBe(false);
  });

  test("exception during start shows generic error", async () => {
    const env = loadSidepanel();
    env.chrome.runtime.sendMessage.mockRejectedValueOnce(new Error("boom"));
    env.clickStart();
    await flushPromises();
    expect(env.els.errorBanner.classList._set.has("hidden")).toBe(false);
  });

  test("stop sends STOP_CAPTURE", async () => {
    const env = loadSidepanel();
    env.chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: true });
    env.clickStart();
    await flushPromises();
    env.chrome.runtime.sendMessage.mockClear();
    env.clickStart(); // toggle → stop
    expect(env.sentMessages()).toContainEqual(
      expect.objectContaining({ type: "STOP_CAPTURE" })
    );
  });

  test("stop resets button to Start Translating", async () => {
    const env = loadSidepanel();
    env.chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: true });
    env.clickStart();
    await flushPromises();
    env.clickStart(); 
    await flushPromises();
    expect(env.els.startStopBtn.textContent).toBe("Start Translating");
    expect(env.els.startStopBtn.disabled).toBe(false);
  });

  test("stop hides sync badge and warming-up", async () => {
    const env = loadSidepanel();
    env.chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: true });
    env.clickStart();
    await flushPromises();
    env.clickStart();
    await flushPromises();
    expect(env.els.warmingUp.classList._set.has("hidden")).toBe(true);
    expect(env.els.syncBadge.className).toContain("hidden");
  });
});

// ===================================================================
// Connecting timer
// ===================================================================

describe("connecting timer", () => {
  test("shows elapsed seconds", () => {
    const env = loadSidepanel();
    env.setDateNow(1000);
    env.clickStart();
    env.setDateNow(4000); 
    env.tickInterval(1000);
    expect(env.els.elapsedTimer.textContent).toContain("3");
  });

  test("after 5s: message changes to server starting", () => {
    const env = loadSidepanel();
    env.setDateNow(1000);
    env.clickStart();
    env.setDateNow(7000); 
    env.tickInterval(1000);
    expect(env.els.warmingText.textContent).toContain("starting up");
  });

  test("after 60s: shows timeout error", () => {
    const env = loadSidepanel();
    env.setDateNow(1000);
    env.clickStart();
    env.setDateNow(62000); 
    env.tickInterval(1000);
    expect(env.els.errorBanner.classList._set.has("hidden")).toBe(false);
    expect(env.els.errorMessage.textContent).toContain("timed out");
  });

  test("after 60s: resets UI to idle", () => {
    const env = loadSidepanel();
    env.setDateNow(1000);
    env.clickStart();
    env.setDateNow(62000);
    env.tickInterval(1000);
    expect(env.els.startStopBtn.textContent).toBe("Start Translating");
    expect(env.els.statusBadge.className).toContain("idle");
  });

  test("stopConnectingTimer clears interval on stop", async () => {
    const env = loadSidepanel();
    env.chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: true });
    env.clickStart();
    await flushPromises(); 
    const countBefore = env.intervals.length;
    env.clickStart(); 
    await flushPromises();
    expect(env.intervals.length).toBeLessThan(countBefore);
  });
});

// ===================================================================
// Error banner
// ===================================================================

describe("error banner", () => {
  test("retry button hides error and re-starts capture", async () => {
    const env = loadSidepanel();
    env.chrome.runtime.sendMessage.mockResolvedValueOnce({ error: "fail" });
    env.clickStart();
    await flushPromises();
    expect(env.els.errorBanner.classList._set.has("hidden")).toBe(false);
    env.clickRetry();
    expect(env.els.errorBanner.classList._set.has("hidden")).toBe(true);
  });

  test("dismiss button hides error", () => {
    const env = loadSidepanel();
    env.els.errorBanner.classList.remove("hidden"); 
    env.els.errorMessage.textContent = "some error";
    env.clickDismiss();
    expect(env.els.errorBanner.classList._set.has("hidden")).toBe(true);
  });
});

// ===================================================================
// Caption deduplication
// ===================================================================

describe("caption dedup", () => {
  function addCaption(env, text, speaker = "Speaker 1") {
    if (!env._playbackStarted) { env.startPlayback(); env._playbackStarted = true; }
    env.sendMsg({ type: "CAPTION", caption: { speaker, translated: text, original: text } });
  }

  test("empty caption rejected", () => {
    const env = loadSidepanel();
    addCaption(env, "");
    expect(env.els.captions.children.length).toBe(0);
  });

  test("whitespace-only caption rejected", () => {
    const env = loadSidepanel();
    addCaption(env, "   ");
    expect(env.els.captions.children.length).toBe(0);
  });

  test("exact duplicate rejected", () => {
    const env = loadSidepanel();
    addCaption(env, "Goal by Messi");
    addCaption(env, "Goal by Messi");
    expect(env.els.captions.children.length).toBe(1);
  });

  test("substring of recent caption rejected", () => {
    const env = loadSidepanel();
    addCaption(env, "And it is a magnificent goal by Messi");
    addCaption(env, "goal by Messi");
    expect(env.els.captions.children.length).toBe(1);
  });

  test("superset containing recent caption rejected (long original)", () => {
    const env = loadSidepanel();
    addCaption(env, "Goal by Lionel Messi from outside the box");
    addCaption(env, "Goal by Lionel Messi from outside the box with a curving shot");
    expect(env.els.captions.children.length).toBe(1);
  });

  test("short common word NOT falsely rejected as substring", () => {
    const env = loadSidepanel();
    addCaption(env, "the quick brown fox jumps over the lazy dog");
    addCaption(env, "the"); 
    expect(env.els.captions.children.length).toBe(2);
  });

  test("60% word overlap rejected for 4+ word captions", () => {
    const env = loadSidepanel();
    addCaption(env, "great pass from the midfielder to the striker");
    addCaption(env, "great pass from the midfielder to striker now"); 
    expect(env.els.captions.children.length).toBe(1);
  });

  test("short caption (<4 words) skips overlap check", () => {
    const env = loadSidepanel();
    addCaption(env, "What a goal");
    addCaption(env, "What a save"); 
    expect(env.els.captions.children.length).toBe(2);
  });

  test("caption older than 10 entries back NOT checked", () => {
    const env = loadSidepanel();
    addCaption(env, "First caption ever spoken in this match today");
    const fillers = [
      "brilliant overhead kick lands perfectly inside the net",
      "referee shows yellow card after dangerous sliding tackle",
      "goalkeeper dives left saving penalty with fingertips",
      "corner kick taken short played back to midfielder",
      "substitution announced manager brings fresh legs forward",
      "VAR checking potential offside before confirming decision",
      "halftime whistle blows players walking towards tunnel",
      "free kick awarded outside box dangerous position",
      "throw in taken quickly catching defenders completely off guard",
      "injury stoppage medical staff rushing onto pitch now",
      "counterattack breaks through open space behind defensive line",
    ];
    for (const f of fillers) addCaption(env, f);
    addCaption(env, "First caption ever spoken in this match today"); 
    expect(env.els.captions.children.length).toBe(13);
  });

  test("total capped at 200 captions", () => {
    const env = loadSidepanel();
    for (let i = 0; i < 210; i++) addCaption(env, `Unique caption ${i}`);
    expect(env.els.captions.children.length).toBeLessThanOrEqual(200);
  });

  test("sidepanel does NOT write captionHistory to storage (moved to SW — BUG-006)", () => {
    const env = loadSidepanel();
    addCaption(env, "Hello world");
    expect(env.chrome.storage.local.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ captionHistory: expect.any(Array) })
    );
  });
});

// ===================================================================
// Caption rendering
// ===================================================================

describe("caption rendering", () => {
  function addCaption(env, text, speaker = "Speaker 1") {
    if (!env._playbackStarted) { env.startPlayback(); env._playbackStarted = true; }
    env.sendMsg({ type: "CAPTION", caption: { speaker, translated: text, original: text } });
  }

  test("empty state hidden when captions exist", () => {
    const env = loadSidepanel();
    addCaption(env, "Hello");
    expect(env.els.emptyState.classList._set.has("hidden")).toBe(true);
  });

  test("empty state shown when no captions", () => {
    const env = loadSidepanel();
    expect(env.els.emptyState.classList._set.has("hidden")).toBe(false);
  });

  test("only new captions rendered incrementally", () => {
    const env = loadSidepanel();
    addCaption(env, "First");
    const count1 = env.els.captions.children.length;
    addCaption(env, "Second");
    const count2 = env.els.captions.children.length;
    expect(count2 - count1).toBe(1);
  });

  test("speaker index extracted from name", () => {
    const env = loadSidepanel();
    addCaption(env, "Test", "Speaker 3");
    const item = env.els.captions.children[0];
    expect(item.className).toContain("speaker-3");
  });

  test("speaker index defaults to 0 for non-numeric name", () => {
    const env = loadSidepanel();
    addCaption(env, "Test", "Narrator");
    const item = env.els.captions.children[0];
    expect(item.className).toContain("speaker-0");
  });

  test("speaker color cycles mod 5", () => {
    const env = loadSidepanel();
    addCaption(env, "Test", "Speaker 7");
    const item = env.els.captions.children[0];
    expect(item.className).toContain("speaker-2"); 
  });

  test("original text shown when different from translated", () => {
    const env = loadSidepanel();
    env.startPlayback();
    env.sendMsg({
      type: "CAPTION",
      caption: { speaker: "Speaker 1", translated: "Goal!", original: "Gol!" },
    });
    const item = env.els.captions.children[0];
    const origDiv = item.children.find((c) => c.className === "original");
    expect(origDiv).toBeTruthy();
    expect(origDiv.textContent).toBe("Gol!");
  });

  test("original text hidden when same as translated", () => {
    const env = loadSidepanel();
    env.startPlayback();
    env.sendMsg({
      type: "CAPTION",
      caption: { speaker: "Speaker 1", translated: "Goal!", original: "Goal!" },
    });
    const item = env.els.captions.children[0];
    const origDiv = item.children.find((c) => c.className === "original");
    expect(origDiv).toBeFalsy();
  });

  test("auto-scrolls to bottom", () => {
    const env = loadSidepanel();
    addCaption(env, "Hello");
    expect(env.els.captions.scrollTop).toBe(env.els.captions.scrollHeight);
  });
});

// ===================================================================
// Status updates
// ===================================================================

describe("setStatus", () => {
  test("maps known statuses to labels", () => {
    const env = loadSidepanel();
    env.sendMsg({ type: "STATUS", status: "streaming" });
    expect(env.els.statusBadge.textContent).toBe("Live");
  });

  test("updates CSS class", () => {
    const env = loadSidepanel();
    env.sendMsg({ type: "STATUS", status: "buffering" });
    expect(env.els.statusBadge.className).toContain("buffering");
  });
});

// ===================================================================
// Message handling — state transitions
// ===================================================================

describe("message handling", () => {
  test("CAPTION hides warming-up and stops timer", () => {
    const env = loadSidepanel();
    env.clickStart(); 
    env.startPlayback(); 
    env.sendMsg({ type: "CAPTION", caption: { speaker: "S1", translated: "Hi", original: "Hola" } });
    expect(env.els.warmingUp.classList._set.has("hidden")).toBe(true);
  });

  test("CAPTION sets status to streaming", () => {
    const env = loadSidepanel();
    env.startPlayback(); 
    env.sendMsg({ type: "CAPTION", caption: { speaker: "S1", translated: "Hi", original: "Hola" } });
    expect(env.els.statusBadge.className).toContain("streaming");
  });

  test("STATUS:streaming hides warming, stops timer", () => {
    const env = loadSidepanel();
    env.clickStart();
    env.sendMsg({ type: "STATUS", status: "streaming" });
    expect(env.els.warmingUp.classList._set.has("hidden")).toBe(true);
  });

  test("STATUS:idle resets full UI", () => {
    const env = loadSidepanel();
    env.sendMsg({ type: "STATUS", status: "idle" });
    expect(env.els.startStopBtn.textContent).toBe("Start Translating");
    expect(env.els.startStopBtn.disabled).toBe(false);
    expect(env.els.warmingUp.classList._set.has("hidden")).toBe(true);
  });

  test("SILENCE_WARNING shows warning element", () => {
    const env = loadSidepanel();
    env.sendMsg({ type: "SILENCE_WARNING" });
    expect(env.els.silenceWarning.classList._set.has("hidden")).toBe(false);
  });

  test("CAPTURE_ERROR shows error and resets UI to idle", () => {
    const env = loadSidepanel();
    env.sendMsg({ type: "CAPTURE_ERROR", error: "WebSocket failed" });
    expect(env.els.errorBanner.classList._set.has("hidden")).toBe(false);
    expect(env.els.errorMessage.textContent).toBe("WebSocket failed");
    expect(env.els.startStopBtn.textContent).toBe("Start Translating");
    expect(env.els.statusBadge.className).toContain("idle");
  });

  test("CHUNK_ERROR shows error but does not reset UI", () => {
    const env = loadSidepanel();
    env.sendMsg({ type: "STATUS", status: "streaming" });
    env.sendMsg({ type: "CHUNK_ERROR", error: "Retry-able" });
    expect(env.els.errorBanner.classList._set.has("hidden")).toBe(false);
    expect(env.els.statusBadge.className).toContain("streaming");
  });

  test("VIDEO_SYNC_STATUS synced — shows buffer + rate", () => {
    const env = loadSidepanel();
    env.sendMsg({ type: "VIDEO_SYNC_STATUS", synced: true, bufferAheadMs: 2500, videoRate: 1.0 });
    expect(env.els.syncBadge.textContent).toContain("Synced");
    expect(env.els.syncBadge.textContent).toContain("2.5");
    expect(env.els.syncBadge.className).toContain("synced");
  });

  test("VIDEO_SYNC_STATUS drifting — shows low buffer", () => {
    const env = loadSidepanel();
    env.sendMsg({ type: "VIDEO_SYNC_STATUS", synced: false, bufferAheadMs: 500, videoRate: 0.95 });
    expect(env.els.syncBadge.textContent).toContain("Low buffer");
    expect(env.els.syncBadge.className).toContain("drifting");
  });

  test("VIDEO_SYNC_STATUS buffering — shows buffering text", () => {
    const env = loadSidepanel();
    env.sendMsg({ type: "VIDEO_SYNC_STATUS", status: "buffering" });
    expect(env.els.syncBadge.textContent).toContain("Buffering");
    expect(env.els.syncBadge.className).toContain("waiting");
  });
});

// ===================================================================
// Backend URL settings (BYO-Modal opt-in)
// ===================================================================

describe("backend URL settings (BYO Modal)", () => {
  function clickSave(env) {
    const fn = env.els.saveBackendBtn._listeners.click;
    if (fn && fn.length) fn[0]();
  }
  function clickReset(env) {
    const fn = env.els.resetBackendBtn._listeners.click;
    if (fn && fn.length) fn[0]();
  }

  test("loads saved backend URL from storage into the input on init", () => {
    const env = loadSidepanel({
      storedData: { backendUrl: "wss://alice--polyglot-streamingservice-web.modal.run" },
    });
    expect(env.els.backendUrl.value).toBe(
      "wss://alice--polyglot-streamingservice-web.modal.run"
    );
  });

  test("save with empty URL clears storage and reports default", async () => {
    const env = loadSidepanel({ storedData: { backendUrl: "wss://old.modal.run" } });
    env.els.backendUrl.value = "";
    clickSave(env);
    await flushPromises();
    expect(env.chrome.storage.local._data.backendUrl).toBeUndefined();
    expect(env.els.backendStatus.className).toContain("ok");
  });

  test("save with non-ws scheme rejects and does not persist", async () => {
    const env = loadSidepanel();
    env.els.backendUrl.value = "http://example.com";
    clickSave(env);
    await flushPromises();
    expect(env.chrome.storage.local._data.backendUrl).toBeUndefined();
    expect(env.els.backendStatus.className).toContain("error");
    expect(env.chrome.permissions.request).not.toHaveBeenCalled();
  });

  test("save with wss Modal URL requests *.modal.run permission and persists on grant", async () => {
    const env = loadSidepanel();
    env.els.backendUrl.value = "wss://alice--polyglot-streamingservice-web.modal.run";
    clickSave(env);
    await flushPromises();
    expect(env.chrome.permissions.request).toHaveBeenCalledWith({
      origins: ["https://alice--polyglot-streamingservice-web.modal.run/*"],
    });
    expect(env.chrome.storage.local._data.backendUrl).toBe(
      "wss://alice--polyglot-streamingservice-web.modal.run"
    );
    expect(env.els.backendStatus.className).toContain("ok");
  });

  test("save aborts and does not persist when user denies permission", async () => {
    const env = loadSidepanel();
    env.chrome.permissions.request.mockResolvedValueOnce(false);
    env.els.backendUrl.value = "wss://bob--polyglot-streamingservice-web.modal.run";
    clickSave(env);
    await flushPromises();
    expect(env.chrome.storage.local._data.backendUrl).toBeUndefined();
    expect(env.els.backendStatus.className).toContain("error");
  });

  test("save with ws://localhost skips permission request (covered by host_permissions)", async () => {
    const env = loadSidepanel();
    env.els.backendUrl.value = "ws://localhost:9000";
    clickSave(env);
    await flushPromises();
    expect(env.chrome.permissions.request).not.toHaveBeenCalled();
    expect(env.chrome.storage.local._data.backendUrl).toBe("ws://localhost:9000");
  });

  test("reset clears stored URL", async () => {
    const env = loadSidepanel({ storedData: { backendUrl: "wss://x.modal.run" } });
    clickReset(env);
    await flushPromises();
    expect(env.chrome.storage.local._data.backendUrl).toBeUndefined();
    expect(env.els.backendUrl.value).toBe("");
  });
});
