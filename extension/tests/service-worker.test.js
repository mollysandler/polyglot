/**
 * @jest-environment node
 *
 * Tests for service-worker.js — orchestrator and message relay hub.
 *
 * Ideal behavior:
 *  - Clean start/stop lifecycle with proper tab muting/unmuting
 *  - All messages correctly routed between offscreen, content script, and side panel
 *  - Errors handled gracefully, no orphaned state
 */
const {
  flushPromises,
  createChromeMock,
  loadScript,
} = require("./helpers");

function loadServiceWorker(chromeOverrides = {}) {
  const chrome = createChromeMock();
  Object.assign(chrome.tabs, chromeOverrides.tabs || {});
  Object.assign(chrome.tabCapture, chromeOverrides.tabCapture || {});
  Object.assign(chrome.scripting, chromeOverrides.scripting || {});
  Object.assign(chrome.runtime, {
    ...chrome.runtime,
    ...(chromeOverrides.runtime || {}),
    onMessage: chrome.runtime.onMessage, // preserve listener registration
  });

  const ctx = loadScript("service-worker.js", { chrome });

  return {
    ctx, chrome,
    sendMsg(msg, sender) {
      const resp = jest.fn();
      const isAsync = chrome._simulateMessage(msg, sender || {}, resp);
      return { resp, isAsync: isAsync.isAsync };
    },
    async sendMsgAsync(msg, sender) {
      const resp = jest.fn();
      chrome._simulateMessage(msg, sender || {}, resp);
      await flushPromises();
      return resp;
    },
    sentToContentScript() {
      return chrome.tabs.sendMessage.mock.calls.map((c) => ({ tabId: c[0], msg: c[1] }));
    },
    sentToOffscreen() {
      return chrome.runtime.sendMessage.mock.calls.map((c) => c[0]);
    },
  };
}

// ===================================================================
// Action click
// ===================================================================

describe("action click", () => {
  test("opens side panel with tab id", () => {
    const env = loadServiceWorker();
    const listener = env.chrome._actionListeners[0];
    listener({ id: 99 });
    expect(env.chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 99 });
  });
});

// ===================================================================
// Message routing: offscreen → side panel
// ===================================================================

describe("relay to side panel", () => {
  test.each(["CAPTION", "STATUS", "SILENCE_WARNING", "CAPTURE_ERROR", "CHUNK_ERROR", "VIDEO_SYNC_STATUS"])(
    "%s relayed via broadcastToExtension",
    (type) => {
      const env = loadServiceWorker();
      env.chrome.runtime.sendMessage.mockClear();
      env.sendMsg({ type, data: "test" });
      expect(env.chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type })
      );
    }
  );
});

// ===================================================================
// Message routing: offscreen → content script
// ===================================================================

describe("relay to content script", () => {
  test("SHOW_OVERLAY relayed with text", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    env.chrome.tabs.sendMessage.mockClear();
    env.sendMsg({ type: "SHOW_OVERLAY", text: "Buffering..." });
    expect(env.sentToContentScript()).toContainEqual(
      expect.objectContaining({ msg: { type: "SHOW_OVERLAY", text: "Buffering..." } })
    );
  });

  test("HIDE_OVERLAY relayed", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    env.chrome.tabs.sendMessage.mockClear();
    env.sendMsg({ type: "HIDE_OVERLAY" });
    expect(env.sentToContentScript()).toContainEqual(
      expect.objectContaining({ msg: { type: "HIDE_OVERLAY" } })
    );
  });

  test("OVERLAY_PROGRESS → UPDATE_OVERLAY (type renamed)", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    env.chrome.tabs.sendMessage.mockClear();
    env.sendMsg({ type: "OVERLAY_PROGRESS", text: "50%", progress: 50 });
    expect(env.sentToContentScript()).toContainEqual(
      expect.objectContaining({ msg: { type: "UPDATE_OVERLAY", text: "50%", progress: 50 } })
    );
  });

  test("SET_DELAY relayed with delaySec", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    env.chrome.tabs.sendMessage.mockClear();
    env.sendMsg({ type: "SET_DELAY", delaySec: 3.2 });
    expect(env.sentToContentScript()).toContainEqual(
      expect.objectContaining({ msg: { type: "SET_DELAY", delaySec: 3.2 } })
    );
  });

  test("PLAYBACK_STARTED relayed with audioStartSec", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    env.chrome.tabs.sendMessage.mockClear();
    env.sendMsg({ type: "PLAYBACK_STARTED", audioStartSec: 3.5 });
    expect(env.sentToContentScript()).toContainEqual(
      expect.objectContaining({ msg: { type: "PLAYBACK_STARTED", audioStartSec: 3.5 } })
    );
  });

  test("VIDEO_SEEK_BACK relayed with seekBackSec", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    env.chrome.tabs.sendMessage.mockClear();
    env.sendMsg({ type: "VIDEO_SEEK_BACK", seekBackSec: 12 });
    expect(env.sentToContentScript()).toContainEqual(
      expect.objectContaining({ msg: expect.objectContaining({ type: "VIDEO_SEEK_BACK", seekBackSec: 12 }) })
    );
  });

  test("VIDEO_ADJUST_RATE relayed with rate", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    env.chrome.tabs.sendMessage.mockClear();
    env.sendMsg({ type: "VIDEO_ADJUST_RATE", rate: 0.95 });
    expect(env.sentToContentScript()).toContainEqual(
      expect.objectContaining({ msg: expect.objectContaining({ type: "VIDEO_ADJUST_RATE", rate: 0.95 }) })
    );
  });
});

// ===================================================================
// Message routing: content script → offscreen
// ===================================================================

describe("relay to offscreen", () => {
  test("SYNC_MODE → SYNC_MODE_REPORT to offscreen", () => {
    const env = loadServiceWorker();
    env.chrome.runtime.sendMessage.mockClear();
    env.sendMsg({ type: "SYNC_MODE", mode: "seekback" });
    expect(env.sentToOffscreen()).toContainEqual(
      expect.objectContaining({ type: "SYNC_MODE_REPORT", mode: "seekback" })
    );
  });
});

// ===================================================================
// START_SYNC bidirectional relay
// ===================================================================

describe("START_SYNC relay", () => {
  test("relayed to content script, sync mode response sent to offscreen", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    // Make content script respond with sync mode
    env.chrome.tabs.sendMessage.mockImplementation((_tabId, msg, cb) => {
      if (msg.type === "START_SYNC" && cb) cb({ ok: true, mode: "canvas" });
    });
    env.chrome.runtime.sendMessage.mockClear();
    env.sendMsg({ type: "START_SYNC" });
    expect(env.sentToOffscreen()).toContainEqual(
      expect.objectContaining({ type: "SYNC_MODE_REPORT", mode: "canvas" })
    );
  });
});

// ===================================================================
// keepalive
// ===================================================================

describe("keepalive", () => {
  test("handled silently with no side effects", () => {
    const env = loadServiceWorker();
    env.chrome.runtime.sendMessage.mockClear();
    env.sendMsg({ type: "keepalive" });
    // No messages sent
    expect(env.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(env.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
});

// ===================================================================
// handleStartCapture
// ===================================================================

describe("handleStartCapture", () => {
  test("gets active tab and stores ID", async () => {
    const env = loadServiceWorker();
    const resp = await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    expect(env.chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  test("throws if no active tab", async () => {
    const env = loadServiceWorker({ tabs: { query: jest.fn(() => Promise.resolve([])) } });
    const resp = await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    expect(resp).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  test("injects content script", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    expect(env.chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ files: ["content-script.js"] })
    );
  });

  test("content script injection failure is non-fatal", async () => {
    const env = loadServiceWorker({
      scripting: { executeScript: jest.fn(() => Promise.reject(new Error("already injected"))) },
    });
    const resp = await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    // Should succeed despite injection failure — response should not contain an error
    if (resp.mock.calls.length > 0) {
      const arg = resp.mock.calls[0][0];
      expect(!arg || !arg.error).toBe(true);
    }
  });

  test("gets media stream ID from tab capture", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    expect(env.chrome.tabCapture.getMediaStreamId).toHaveBeenCalledWith(
      expect.objectContaining({ targetTabId: 42 })
    );
  });

  test("creates offscreen document", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    expect(env.chrome.offscreen.createDocument).toHaveBeenCalled();
  });

  test("mutes the active tab", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    expect(env.chrome.tabs.update).toHaveBeenCalledWith(42, { muted: true });
  });

  test("sends START_CAPTURE to offscreen with streamId and langs", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "fr", targetLang: "de" });
    expect(env.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "START_CAPTURE",
        streamId: "stream-id-123",
        sourceLang: "fr",
        targetLang: "de",
      })
    );
  });

  test("returns async (listener returns true)", () => {
    const env = loadServiceWorker();
    const { isAsync } = env.sendMsg({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    expect(isAsync).toBe(true);
  });
});

// ===================================================================
// handleStopCapture
// ===================================================================

describe("handleStopCapture", () => {
  test("sends STOP_CAPTURE to offscreen", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    env.chrome.runtime.sendMessage.mockClear();
    await env.sendMsgAsync({ type: "STOP_CAPTURE" });
    expect(env.sentToOffscreen()).toContainEqual(
      expect.objectContaining({ type: "STOP_CAPTURE" })
    );
  });

  test("unmutes the tab", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    env.chrome.tabs.update.mockClear();
    await env.sendMsgAsync({ type: "STOP_CAPTURE" });
    expect(env.chrome.tabs.update).toHaveBeenCalledWith(42, { muted: false });
  });

  test("sends VIDEO_CLEANUP to content script", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    env.chrome.tabs.sendMessage.mockClear();
    await env.sendMsgAsync({ type: "STOP_CAPTURE" });
    expect(env.sentToContentScript()).toContainEqual(
      expect.objectContaining({ msg: { type: "VIDEO_CLEANUP" } })
    );
  });

  test("clears activeTabId", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    await env.sendMsgAsync({ type: "STOP_CAPTURE" });
    // Subsequent content script messages should be no-ops
    env.chrome.tabs.sendMessage.mockClear();
    env.sendMsg({ type: "SHOW_OVERLAY", text: "test" });
    expect(env.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test("handles error from offscreen gracefully", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    env.chrome.runtime.sendMessage.mockImplementationOnce(() => Promise.reject(new Error("gone")));
    const resp = await env.sendMsgAsync({ type: "STOP_CAPTURE" });
    expect(resp).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  test("returns async (listener returns true)", () => {
    const env = loadServiceWorker();
    const { isAsync } = env.sendMsg({ type: "STOP_CAPTURE" });
    expect(isAsync).toBe(true);
  });
});

// ===================================================================
// ensureOffscreenDocument
// ===================================================================

describe("ensureOffscreenDocument", () => {
  test("does not create if document already exists", async () => {
    const env = loadServiceWorker();
    env.chrome.runtime.getContexts.mockResolvedValueOnce([{ contextType: "OFFSCREEN_DOCUMENT" }]);
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    expect(env.chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  test("creates if none exists", async () => {
    const env = loadServiceWorker();
    await env.sendMsgAsync({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    expect(env.chrome.offscreen.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "offscreen/offscreen.html",
        reasons: expect.arrayContaining(["USER_MEDIA", "AUDIO_PLAYBACK"]),
      })
    );
  });
});

// ===================================================================
// Helper function guards
// ===================================================================

describe("helper guards", () => {
  test("sendToContentScript no-ops when activeTabId is null", () => {
    const env = loadServiceWorker();
    // No start → activeTabId is null
    env.sendMsg({ type: "SHOW_OVERLAY", text: "test" });
    expect(env.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test("sendToOffscreen catches errors silently", () => {
    const env = loadServiceWorker();
    env.chrome.runtime.sendMessage.mockImplementation(() => Promise.reject(new Error("boom")));
    expect(() => env.sendMsg({ type: "SYNC_MODE", mode: "canvas" })).not.toThrow();
  });

  test("broadcastToExtension catches errors silently", () => {
    const env = loadServiceWorker();
    env.chrome.runtime.sendMessage.mockImplementation(() => Promise.reject(new Error("boom")));
    expect(() => env.sendMsg({ type: "CAPTION", caption: {} })).not.toThrow();
  });
});
