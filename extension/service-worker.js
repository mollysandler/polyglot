/**
 * Service worker: orchestrator for the streaming translation extension.
 *
 * Responsibilities:
 *   - Open side panel on action click
 *   - Create offscreen document and get tab stream ID
 *   - Relay messages between offscreen doc, content script, and side panel
 *   - Keepalive handling to prevent SW suspension
 */

/* global chrome */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeTabId = null;
let sessionActive = false;

// ---------------------------------------------------------------------------
// Action click -> open side panel
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ---------------------------------------------------------------------------
// Tab lifecycle — stop capture if the captured tab is closed or navigates
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  if (sessionActive && tabId === activeTabId) {
    handleStopCapture().catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Top-frame navigation tears down the content script and the media source.
  // Without stopping, the offscreen WebSocket keeps the session alive on a
  // stream that's no longer producing content. We notify the sidepanel so
  // it can auto-restart on the new video with cleared state.
  if (sessionActive && tabId === activeTabId && changeInfo.url) {
    handleStopCapture()
      .then(() => broadcastToExtension({ type: "URL_CHANGED", url: changeInfo.url }))
      .catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  // User switched to a different tab. The captured MediaStream is bound to
  // the original tab, so the session no longer matches what they're looking
  // at. Stop cleanly and tell the sidepanel to reset — we don't auto-restart
  // because the new tab may not have a video.
  if (sessionActive && tabId !== activeTabId) {
    handleStopCapture()
      .then(() => broadcastToExtension({ type: "TAB_SWITCHED" }))
      .catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "START_CAPTURE":
      handleStartCapture(message.sourceLang, message.targetLang, message.sourceMode)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    case "STOP_CAPTURE":
      handleStopCapture()
        .then((result) => sendResponse(result || { ok: true }))
        .catch(() => sendResponse({ ok: true }));
      return true;

    case "PLAY_BUFFERED_MIC_AUDIO":
    case "DISCARD_BUFFERED_MIC_AUDIO":
    case "GET_MIC_BUFFER_STATUS":
      chrome.runtime.sendMessage({ type: message.type })
        .then((resp) => sendResponse(resp || { ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case "MIC_PLAYBACK_DONE":
    case "MIC_BUFFER_COUNT":
      broadcastToExtension(message);
      break;

    // --------------- Relay from offscreen -> side panel ---------------
    case "CAPTION":
      // Persist captions here (not in the sidepanel) so they aren't lost
      // when the user closes the side panel mid-session.
      persistCaption(message.caption);
      broadcastToExtension(message);
      break;

    case "STATUS":
    case "SILENCE_WARNING":
    case "CAPTURE_ERROR":
    case "CHUNK_ERROR":
    case "VIDEO_SYNC_STATUS":
      broadcastToExtension(message);
      break;

    // --------------- Overlay commands (offscreen -> content script) ---------------
    case "SHOW_OVERLAY":
      sendToContentScript({ type: "SHOW_OVERLAY", text: message.text });
      break;

    case "HIDE_OVERLAY":
      sendToContentScript({ type: "HIDE_OVERLAY" });
      break;

    case "OVERLAY_PROGRESS":
      sendToContentScript({
        type: "UPDATE_OVERLAY",
        text: message.text,
        progress: message.progress,
      });
      break;

    // --------------- Sync initialization (offscreen -> content script) ---------------
    case "START_SYNC":
      sendToContentScript({ type: "START_SYNC" }, (response) => {
        if (response && response.mode) {
          // Report chosen sync mode back to offscreen
          sendToOffscreen({ type: "SYNC_MODE_REPORT", mode: response.mode });
        }
      });
      break;

    case "SET_DELAY":
      // Relay measured pipeline latency to content script for canvas delay
      sendToContentScript({ type: "SET_DELAY", delaySec: message.delaySec });
      break;

    case "PLAYBACK_STARTED":
      // Tell content script that audio playback began — start drawing canvas frames.
      // audioStartSec tells the canvas which video position the audio starts from.
      sendToContentScript({ type: "PLAYBACK_STARTED", audioStartSec: message.audioStartSec });
      break;

    // --------------- Sync mode report (content script -> offscreen) ---------------
    case "SYNC_MODE":
      sendToOffscreen({ type: "SYNC_MODE_REPORT", mode: message.mode });
      break;

    // --------------- Seekback fallback commands (offscreen -> content script) ------
    case "VIDEO_SEEK_BACK":
      sendToContentScript({
        type: "VIDEO_SEEK_BACK",
        seekBackSec: message.seekBackSec,
      });
      break;

    case "VIDEO_ADJUST_RATE":
      sendToContentScript({ type: "VIDEO_ADJUST_RATE", rate: message.rate });
      break;

    // --------------- Pause / Resume (side panel <-> offscreen + content script) ----
    case "PAUSE_ALL":
      sendToOffscreen({ type: "PAUSE_ALL" });
      sendToContentScript({ type: "PAUSE_ALL" });
      break;

    case "RESUME_ALL":
      sendToOffscreen({ type: "RESUME_ALL" });
      sendToContentScript({ type: "RESUME_ALL" });
      break;

    // From content script when user pauses/resumes the video directly.
    // DO NOT re-broadcast: the content script's sendMessage already fans out
    // to offscreen and sidepanel. Re-broadcasting here causes double delivery.
    case "USER_PAUSED_VIDEO":
    case "USER_RESUMED_VIDEO":
      break;

    // --------------- Re-buffer (offscreen -> content script + side panel) ------
    case "REBUFFER_START":
      sendToContentScript({ type: "REBUFFER_START" });
      broadcastToExtension(message);
      break;

    case "REBUFFER_END":
      sendToContentScript({ type: "REBUFFER_END" });
      broadcastToExtension(message);
      break;

    // --------------- Keepalive ---------------
    case "keepalive":
      break;
  }
});

// ---------------------------------------------------------------------------
// Start capture
// ---------------------------------------------------------------------------

async function handleStartCapture(sourceLang, targetLang, sourceMode) {
  const mode = sourceMode === "mic" ? "mic" : "tab";

  // Create offscreen document (used for both modes — it hosts the AudioContext
  // and WebSocket).
  await ensureOffscreenDocument();

  if (mode === "mic") {
    // Microphone mode: no tab capture, no content-script injection, no tab
    // mute. The offscreen doc will call getUserMedia({audio:true}) directly.
    sessionActive = true;
    activeTabId = null;
    return await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      sourceMode: "mic",
      sourceLang,
      targetLang,
    });
  }

  // Tab-audio mode (original flow)
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found");
  activeTabId = tab.id;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ["content-script.js"],
    });
  } catch (e) {
    console.warn("Content script injection failed (may already be injected):", e);
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: activeTabId,
  });

  await chrome.tabs.update(activeTabId, { muted: true });

  sessionActive = true;
  return await chrome.runtime.sendMessage({
    type: "START_CAPTURE",
    sourceMode: "tab",
    streamId,
    sourceLang,
    targetLang,
  });
}

async function handleStopCapture() {
  sessionActive = false;
  let micBufferedCount = 0;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    if (resp && typeof resp.micBufferedCount === "number") {
      micBufferedCount = resp.micBufferedCount;
    }
  } catch (e) {}
  if (activeTabId) {
    chrome.tabs.update(activeTabId, { muted: false }).catch(() => {});
    sendToContentScript({ type: "VIDEO_CLEANUP" });
    activeTabId = null;
  }
  return { ok: true, micBufferedCount };
}

// ---------------------------------------------------------------------------
// Offscreen document management
// ---------------------------------------------------------------------------

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture tab audio and play translated audio",
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendToContentScript(msg, callback) {
  if (!activeTabId) return;
  chrome.tabs.sendMessage(activeTabId, msg, callback || (() => {}));
}

function sendToOffscreen(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function broadcastToExtension(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

const CAPTION_FLUSH_DEBOUNCE_MS = 0;
let captionWriteChain = Promise.resolve();
let pendingCaptionBatch = [];
let captionFlushScheduled = false;

function persistCaption(caption) {
  if (!caption) return;
  pendingCaptionBatch.push(caption);
  if (captionFlushScheduled) return;
  captionFlushScheduled = true;
  Promise.resolve().then(() => {
    captionFlushScheduled = false;
    flushCaptionBatch();
  });
}

function flushCaptionBatch() {
  if (pendingCaptionBatch.length === 0) return;
  const batch = pendingCaptionBatch;
  pendingCaptionBatch = [];
  captionWriteChain = captionWriteChain.then(async () => {
    const { captionHistory = [] } = await chrome.storage.local.get("captionHistory");
    for (const c of batch) captionHistory.push(c);
    if (captionHistory.length > 200) captionHistory.splice(0, captionHistory.length - 200);
    await chrome.storage.local.set({ captionHistory });
  }).catch(() => {});
}
