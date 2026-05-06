/**
 * Side panel UI controller.
 *
 * Manages language selection, start/stop, caption display, and status.
 * Communicates with the service worker via chrome.runtime messages.
 */

/* global chrome */

const startStopBtn = document.getElementById("startStopBtn");
const statusBadge = document.getElementById("statusBadge");
const captionsEl = document.getElementById("captions");
const emptyState = document.getElementById("emptyState");
const silenceWarning = document.getElementById("silenceWarning");
const warmingUp = document.getElementById("warmingUp");
const warmingText = document.getElementById("warmingText");
const elapsedTimer = document.getElementById("elapsedTimer");
const sourceLangEl = document.getElementById("sourceLang");
const targetLangEl = document.getElementById("targetLang");
const syncBadge = document.getElementById("syncBadge");
const errorBanner = document.getElementById("errorBanner");
const errorMessage = document.getElementById("errorMessage");
const retryBtn = document.getElementById("retryBtn");
const dismissBtn = document.getElementById("dismissBtn");
const pauseResumeBtn = document.getElementById("pauseResumeBtn");
const newVideoBtn = document.getElementById("newVideoBtn");

let isCapturing = false;
let isPaused = false;
let playbackStarted = false; // suppress captions until audio is actually playing
let captions = [];
let connectingStartTime = null;
let connectingTimerInterval = null;

// Don't auto-stop on panel open — the user may have navigated away and back

// Load saved preferences
chrome.storage.local.get(["sourceLang", "targetLang", "captionHistory"], (data) => {
  if (data.sourceLang) sourceLangEl.value = data.sourceLang;
  if (data.targetLang) targetLangEl.value = data.targetLang;
  if (data.captionHistory && data.captionHistory.length > 0) {
    captions = data.captionHistory;
    renderCaptions();
  }
});

sourceLangEl.addEventListener("change", () => {
  chrome.storage.local.set({ sourceLang: sourceLangEl.value });
});
targetLangEl.addEventListener("change", () => {
  chrome.storage.local.set({ targetLang: targetLangEl.value });
});

// -- Error display --

function showError(message) {
  errorMessage.textContent = message;
  errorBanner.classList.remove("hidden");
}

function hideError() {
  errorBanner.classList.add("hidden");
  errorMessage.textContent = "";
}

retryBtn.addEventListener("click", () => {
  hideError();
  startCapture();
});

dismissBtn.addEventListener("click", () => {
  hideError();
});

// -- Connecting timer --

function startConnectingTimer() {
  stopConnectingTimer();
  connectingStartTime = Date.now();
  warmingText.textContent = "Connecting to server...";
  elapsedTimer.textContent = "";

  connectingTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - connectingStartTime) / 1000);
    elapsedTimer.textContent = `(${elapsed}s)`;

    if (elapsed >= 5 && elapsed < 60) {
      warmingText.textContent = "Connecting — streaming server is starting up...";
    }

    if (elapsed >= 60) {
      resetUIToIdle();
      showError("Connection timed out. The server may be overloaded.");
    }
  }, 1000);
}

function stopConnectingTimer() {
  if (connectingTimerInterval) {
    clearInterval(connectingTimerInterval);
    connectingTimerInterval = null;
  }
  connectingStartTime = null;
  elapsedTimer.textContent = "";
}

// Single source of truth for "session is over, return UI to idle". Every
// teardown path (manual stop, connect timeout, server error, capture error,
// auto-stop on tab switch) goes through here so we can't leave half-state
// (e.g. pause button visible after a failed restart). Does NOT touch the
// error banner — callers decide whether to show/hide it.
function resetUIToIdle() {
  isCapturing = false;
  isPaused = false;
  playbackStarted = false;

  stopConnectingTimer();

  startStopBtn.textContent = "Start Translating";
  startStopBtn.className = "btn btn-start";
  startStopBtn.disabled = false;

  pauseResumeBtn.textContent = "Pause";
  pauseResumeBtn.className = "btn btn-pause hidden";

  newVideoBtn.classList.add("hidden");
  newVideoBtn.disabled = false;

  sourceLangEl.disabled = false;
  targetLangEl.disabled = false;

  warmingUp.classList.add("hidden");
  syncBadge.className = "sync-badge hidden";
  silenceWarning.classList.add("hidden");

  setStatus("idle");
}

// -- Start / Stop --

startStopBtn.addEventListener("click", () => {
  if (isCapturing) {
    stopCapture();
  } else {
    startCapture();
  }
});

// -- Pause / Resume --

pauseResumeBtn.addEventListener("click", () => {
  if (isPaused) {
    setPauseUI(false);
    chrome.runtime.sendMessage({ type: "RESUME_ALL" });
  } else {
    setPauseUI(true);
    chrome.runtime.sendMessage({ type: "PAUSE_ALL" });
  }
});

// -- New Video (reset + restart) --

newVideoBtn.addEventListener("click", () => resetAndRestart({ alreadyStopped: false }));

async function resetAndRestart({ alreadyStopped }) {
  newVideoBtn.disabled = true;
  try {
    if (!alreadyStopped && isCapturing) {
      await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    }
    // Always clear capture state — in the alreadyStopped path the SW already
    // tore down the session, but the sidepanel's flag was still true. Without
    // this, a subsequent failed startCapture would leave isCapturing=true
    // and the next button click would try to STOP a session that doesn't exist.
    isCapturing = false;

    // Wipe captions — the SW also writes captionHistory, clear that too so
    // the sidepanel doesn't reload the old list on next open.
    captions = [];
    captionsEl.innerHTML = "";
    captionsEl.appendChild(emptyState);
    emptyState.classList.remove("hidden");
    await chrome.storage.local.set({ captionHistory: [] });

    // Reset transient UI state
    playbackStarted = false;
    silenceWarning.classList.add("hidden");
    syncBadge.className = "sync-badge hidden";
    pauseResumeBtn.classList.add("hidden");
    newVideoBtn.classList.add("hidden");

    // Kick off a fresh capture
    await startCapture();
  } finally {
    newVideoBtn.disabled = false;
  }
}

function setPauseUI(paused) {
  isPaused = paused;
  if (paused) {
    pauseResumeBtn.textContent = "Resume";
    pauseResumeBtn.className = "btn btn-resume";
    setStatus("paused");
  } else {
    pauseResumeBtn.textContent = "Pause";
    pauseResumeBtn.className = "btn btn-pause";
    setStatus("streaming");
  }
}

async function startCapture() {
  startStopBtn.disabled = true;
  // Lock language selectors so users can't change them mid-stream — the
  // change wouldn't take effect until the next Start, but the live UI made
  // it look like it would (BUG-021).
  sourceLangEl.disabled = true;
  targetLangEl.disabled = true;
  silenceWarning.classList.add("hidden");
  hideError();
  warmingUp.classList.remove("hidden");
  setStatus("connecting");
  startConnectingTimer();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      sourceLang: sourceLangEl.value,
      targetLang: targetLangEl.value,
    });

    if (response && response.error) {
      resetUIToIdle();
      showError(response.error);
      return;
    }

    isCapturing = true;
    startStopBtn.textContent = "Stop";
    startStopBtn.className = "btn btn-stop";
    startStopBtn.disabled = false;
    newVideoBtn.classList.remove("hidden");
  } catch (err) {
    resetUIToIdle();
    showError("Failed to start capture. Please try again.");
  }
}

async function stopCapture() {
  startStopBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
  } catch (err) {
    // ignore
  }
  resetUIToIdle();
}

// -- Status --

function setStatus(status) {
  const labels = {
    idle: "Idle",
    connecting: "Connecting...",
    streaming: "Live",
    buffering: "Buffering...",
    paused: "Paused",
  };
  statusBadge.textContent = labels[status] || status;
  statusBadge.className = "status-badge " + status;
}

// -- Captions --

function addCaption(caption) {
  const newText = (caption.translated || caption.text || "").trim();
  if (!newText) return;

  // Dedup against recent captions
  const newWords = newText.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/);
  const recent = captions.slice(-10);
  if (recent.some((c) => {
    const oldText = (c.translated || c.text || "").trim();
    if (!oldText) return false;
    if (oldText === newText) return true;
    if ((oldText.includes(newText) && newText.length > 10) || (newText.includes(oldText) && oldText.length > 10)) return true;
    if (newWords.length >= 4) {
      const oldWords = new Set(oldText.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/));
      const overlap = newWords.filter((w) => oldWords.has(w)).length;
      if (overlap / newWords.length >= 0.6) return true;
    }
    return false;
  })) {
    return;
  }

  captions.push(caption);
  if (captions.length > 200) captions = captions.slice(-200);
  renderCaptions();
  // Storage is written by the service worker on CAPTION relay — don't
  // double-write from here, it would race the SW's write chain.
}

function renderCaptions() {
  if (captions.length === 0) {
    emptyState.classList.remove("hidden");
    return;
  }
  emptyState.classList.add("hidden");

  const existingCount = captionsEl.querySelectorAll(".caption-item").length;
  for (let i = existingCount; i < captions.length; i++) {
    const cap = captions[i];
    const speakerIdx = extractSpeakerIndex(cap.speaker);

    const div = document.createElement("div");
    div.className = `caption-item speaker-${speakerIdx % 5}`;

    const speakerDiv = document.createElement("div");
    speakerDiv.className = "speaker";
    speakerDiv.textContent = cap.speaker || "Speaker";

    const textDiv = document.createElement("div");
    textDiv.className = "text";
    textDiv.textContent = cap.translated || cap.text || "";

    div.appendChild(speakerDiv);
    div.appendChild(textDiv);

    if (cap.original && cap.original !== (cap.translated || cap.text)) {
      const origDiv = document.createElement("div");
      origDiv.className = "original";
      origDiv.textContent = cap.original;
      div.appendChild(origDiv);
    }

    captionsEl.appendChild(div);
  }

  captionsEl.scrollTop = captionsEl.scrollHeight;
}

function extractSpeakerIndex(speaker) {
  if (!speaker) return 0;
  const match = speaker.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

// -- Listen for messages --

chrome.runtime.onMessage.addListener((message) => {
  // Tab navigated to a new URL while capturing — SW already stopped the
  // session. Auto-restart with fresh state so the user doesn't have to
  // click Start again.
  if (message.type === "URL_CHANGED") {
    resetAndRestart({ alreadyStopped: true }).catch(() => {});
    return;
  }

  // User activated a different tab — the captured stream is bound to the
  // original tab, so we stop cleanly. We don't auto-restart: the new tab may
  // not have a video, and silently capturing it would surprise the user.
  if (message.type === "TAB_SWITCHED") {
    resetUIToIdle();
    return;
  }

  if (message.type === "CAPTION") {
    // Don't show captions until playback has started — during buffering
    // the user sees the video but hears nothing, so captions are confusing.
    if (!playbackStarted) return;
    warmingUp.classList.add("hidden");
    stopConnectingTimer();
    setStatus("streaming");
    addCaption(message.caption);
  }

  // HIDE_OVERLAY signals playback has begun (overlay is removed when audio starts)
  if (message.type === "HIDE_OVERLAY" || message.type === "VIDEO_SYNC_STATUS") {
    playbackStarted = true;
    if (isCapturing && !isPaused) {
      pauseResumeBtn.classList.remove("hidden");
    }
  }

  // Video pause/resume initiated by the user clicking the video player
  if (message.type === "USER_PAUSED_VIDEO") {
    setPauseUI(true);
    pauseResumeBtn.classList.remove("hidden");
  }
  if (message.type === "USER_RESUMED_VIDEO") {
    setPauseUI(false);
  }

  // Re-buffer for late-arriving speakers
  if (message.type === "REBUFFER_START") {
    setStatus("buffering");
  }
  if (message.type === "REBUFFER_END") {
    if (isCapturing && !isPaused) {
      setStatus("streaming");
    }
  }

  if (message.type === "STATUS") {
    setStatus(message.status);
    if (message.status === "streaming") {
      warmingUp.classList.add("hidden");
      stopConnectingTimer();
    }
    if (message.status === "idle") {
      resetUIToIdle();
    }
  }

  if (message.type === "SILENCE_WARNING") {
    silenceWarning.classList.remove("hidden");
  }

  if (message.type === "CAPTURE_ERROR") {
    resetUIToIdle();
    showError(message.error);
  }

  if (message.type === "CHUNK_ERROR") {
    showError(message.error);
  }

  if (message.type === "VIDEO_SYNC_STATUS") {
    if (message.bufferAheadMs !== undefined && message.videoRate !== undefined) {
      const bufSec = (message.bufferAheadMs / 1000).toFixed(1);
      const rateStr = message.videoRate.toFixed(2);
      if (message.synced) {
        syncBadge.textContent = `Synced (${bufSec}s buf, ${rateStr}x)`;
        syncBadge.className = "sync-badge synced";
      } else {
        syncBadge.textContent = `Low buffer (${bufSec}s, ${rateStr}x)`;
        syncBadge.className = "sync-badge drifting";
      }
    } else if (message.status === "buffering") {
      syncBadge.textContent = "Buffering...";
      syncBadge.className = "sync-badge waiting";
    }
  }
});
