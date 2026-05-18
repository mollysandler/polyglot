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
const errorBanner = document.getElementById("errorBanner");
const errorMessage = document.getElementById("errorMessage");
const retryBtn = document.getElementById("retryBtn");
const dismissBtn = document.getElementById("dismissBtn");
const pauseResumeBtn = document.getElementById("pauseResumeBtn");
const newVideoBtn = document.getElementById("newVideoBtn");
const backendUrlEl = document.getElementById("backendUrl");
const saveBackendBtn = document.getElementById("saveBackendBtn");
const resetBackendBtn = document.getElementById("resetBackendBtn");
const backendStatusEl = document.getElementById("backendStatus");
const sourceModeTabBtn = document.getElementById("sourceModeTab");
const sourceModeMicBtn = document.getElementById("sourceModeMic");
const micHintEl = document.getElementById("micHint");
const micReplayPromptEl = document.getElementById("micReplayPrompt");
const micReplayCountEl = document.getElementById("micReplayCount");
const playMicAudioBtn = document.getElementById("playMicAudioBtn");
const discardMicAudioBtn = document.getElementById("discardMicAudioBtn");
const micPostPlaybackPromptEl = document.getElementById("micPostPlaybackPrompt");
const micPostPlaybackStatusEl = document.getElementById("micPostPlaybackStatus");
const saveMicAudioBtn = document.getElementById("saveMicAudioBtn");
const replayMicAudioBtn = document.getElementById("replayMicAudioBtn");
const newMicRecordingBtn = document.getElementById("newMicRecordingBtn");
const micBufferLiveEl = document.getElementById("micBufferLive");
const micBufferLiveCountEl = document.getElementById("micBufferLiveCount");

const DEFAULT_BACKEND_URL = "ws://localhost:8765";

let isCapturing = false;
let isPaused = false;
let playbackStarted = false;
let captions = [];
let connectingStartTime = null;
let connectingTimerInterval = null;
let sourceMode = "tab";

function applySourceModeUI(mode) {
  sourceMode = mode === "mic" ? "mic" : "tab";
  const isMic = sourceMode === "mic";
  sourceModeTabBtn.classList.toggle("active", !isMic);
  sourceModeMicBtn.classList.toggle("active", isMic);
  sourceModeTabBtn.setAttribute("aria-checked", String(!isMic));
  sourceModeMicBtn.setAttribute("aria-checked", String(isMic));
  micHintEl.classList.toggle("hidden", !isMic);
}

chrome.storage.local.get(["sourceLang", "targetLang", "captionHistory", "backendUrl", "sourceMode"], (data) => {
  if (data.sourceLang) sourceLangEl.value = data.sourceLang;
  if (data.targetLang) targetLangEl.value = data.targetLang;
  if (data.backendUrl) backendUrlEl.value = data.backendUrl;
  if (data.sourceMode) applySourceModeUI(data.sourceMode);
  if (data.captionHistory && data.captionHistory.length > 0) {
    captions = data.captionHistory;
    renderCaptions();
  }
});

function setSourceMode(mode) {
  if (isCapturing) return; 
  applySourceModeUI(mode);
  chrome.storage.local.set({ sourceMode });
}
sourceModeTabBtn.addEventListener("click", () => setSourceMode("tab"));
sourceModeMicBtn.addEventListener("click", () => setSourceMode("mic"));

sourceLangEl.addEventListener("change", () => {
  chrome.storage.local.set({ sourceLang: sourceLangEl.value });
});
targetLangEl.addEventListener("change", () => {
  chrome.storage.local.set({ targetLang: targetLangEl.value });
});

function setBackendStatus(text, kind) {
  backendStatusEl.textContent = text || "";
  backendStatusEl.className = "settings-status" + (kind ? " " + kind : "");
}
function backendUrlToPermissionOrigin(url) {
  let parsed;
  try { parsed = new URL(url); } catch (e) { return null; }
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1") return null;
  const scheme = parsed.protocol === "wss:" ? "https:" : "http:";
  return `${scheme}//${host}/*`;
}

saveBackendBtn.addEventListener("click", async () => {
  const raw = backendUrlEl.value.trim();
  if (!raw) {
    await chrome.storage.local.remove("backendUrl");
    setBackendStatus(`Cleared. Will use default ${DEFAULT_BACKEND_URL}.`, "ok");
    return;
  }
  if (!/^wss?:\/\//.test(raw)) {
    setBackendStatus("URL must start with ws:// or wss://", "error");
    return;
  }

  const originPattern = backendUrlToPermissionOrigin(raw);
  if (originPattern) {
    try {
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      if (!granted) {
        setBackendStatus("Permission denied; URL not saved.", "error");
        return;
      }
    } catch (err) {
      setBackendStatus("Could not request permission: " + (err.message || err), "error");
      return;
    }
  }

  await chrome.storage.local.set({ backendUrl: raw });
  setBackendStatus("Saved. Click Start Translating to use the new backend.", "ok");
});

resetBackendBtn.addEventListener("click", async () => {
  backendUrlEl.value = "";
  await chrome.storage.local.remove("backendUrl");
  setBackendStatus(`Reset to default ${DEFAULT_BACKEND_URL}.`, "ok");
});

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

function resetUIToIdle() {
  isCapturing = false;
  isPaused = false;
  playbackStarted = false;

  stopConnectingTimer();

  startStopBtn.textContent = "Start Translating";
  startStopBtn.className = "btn btn-start";
  startStopBtn.classList.remove("hidden");
  startStopBtn.disabled = false;

  pauseResumeBtn.textContent = "Pause";
  pauseResumeBtn.className = "btn btn-pause hidden";

  newVideoBtn.classList.add("hidden");
  newVideoBtn.disabled = false;

  sourceLangEl.disabled = false;
  targetLangEl.disabled = false;
  sourceModeTabBtn.disabled = false;
  sourceModeMicBtn.disabled = false;

  warmingUp.classList.add("hidden");
  silenceWarning.classList.add("hidden");
  micReplayPromptEl.classList.add("hidden");
  if (micPostPlaybackPromptEl) micPostPlaybackPromptEl.classList.add("hidden");
  if (micBufferLiveEl) micBufferLiveEl.classList.add("hidden");
  if (playMicAudioBtn) playMicAudioBtn.disabled = false;
  if (discardMicAudioBtn) discardMicAudioBtn.disabled = false;
  if (saveMicAudioBtn) saveMicAudioBtn.disabled = false;
  if (replayMicAudioBtn) replayMicAudioBtn.disabled = false;
  if (newMicRecordingBtn) newMicRecordingBtn.disabled = false;

  setStatus("idle");
}

startStopBtn.addEventListener("click", () => {
  if (isCapturing) {
    stopCapture();
  } else {
    startCapture();
  }
});

pauseResumeBtn.addEventListener("click", () => {
  if (isPaused) {
    setPauseUI(false);
    chrome.runtime.sendMessage({ type: "RESUME_ALL" });
  } else {
    setPauseUI(true);
    chrome.runtime.sendMessage({ type: "PAUSE_ALL" });
  }
});

newVideoBtn.addEventListener("click", () => resetAndRestart({ alreadyStopped: false }));

async function resetAndRestart({ alreadyStopped }) {
  newVideoBtn.disabled = true;
  try {
    if (!alreadyStopped && isCapturing) {
      await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    }
    isCapturing = false;

    captions = [];
    captionsEl.innerHTML = "";
    captionsEl.appendChild(emptyState);
    emptyState.classList.remove("hidden");
    await chrome.storage.local.set({ captionHistory: [] });

    playbackStarted = false;
    silenceWarning.classList.add("hidden");
    pauseResumeBtn.classList.add("hidden");
    newVideoBtn.classList.add("hidden");

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
  sourceLangEl.disabled = true;
  targetLangEl.disabled = true;
  sourceModeTabBtn.disabled = true;
  sourceModeMicBtn.disabled = true;
  silenceWarning.classList.add("hidden");
  hideError();
  warmingUp.classList.remove("hidden");
  setStatus("connecting");
  startConnectingTimer();

  if (sourceMode === "mic") {
    try {
      const probeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      probeStream.getTracks().forEach((t) => t.stop());
    } catch (permErr) {
      resetUIToIdle();
      if (permErr && permErr.name === "NotFoundError") {
        showError("No microphone detected. Connect or enable a microphone and try again.");
        return;
      }
      try {
        await chrome.windows.create({
          url: chrome.runtime.getURL("permission/permission.html"),
          type: "popup",
          width: 480,
          height: 360,
        });
        showError("Microphone access was not granted. A new window has opened to grant access; come back and click Start when done.");
      } catch (winErr) {
        showError("Microphone access was denied and the permission helper failed to open. Visit chrome://settings/content/microphone and remove any block on this extension, then try again.");
      }
      return;
    }
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      sourceLang: sourceLangEl.value,
      targetLang: targetLangEl.value,
      sourceMode,
    });

    if (response && response.error) {
      resetUIToIdle();
      showError(response.error);
      return;
    }

    isCapturing = true;
    startStopBtn.textContent = sourceMode === "mic" ? "Done" : "Stop";
    startStopBtn.className = "btn btn-stop";
    startStopBtn.disabled = false;
    if (sourceMode === "mic") {
      micBufferLiveCountEl.textContent = "0";
      micBufferLiveEl.classList.remove("hidden");
    }

    if (sourceMode !== "mic") {
      newVideoBtn.classList.remove("hidden");
    }
  } catch (err) {
    resetUIToIdle();
    showError("Failed to start capture. Please try again.");
  }
}

async function stopCapture() {
  startStopBtn.disabled = true;
  const stoppedSourceMode = sourceMode;
  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
  } catch (err) {}

  if (stoppedSourceMode === "mic" && resp && resp.micBufferedCount > 0) {
    showMicReplayPrompt(resp.micBufferedCount);
    isCapturing = false;
    startStopBtn.disabled = false;
    return;
  }

  resetUIToIdle();
}

function showMicReplayPrompt(count) {
  micReplayCountEl.textContent = count === 1 ? "(1 chunk ready)" : `(${count} chunks ready)`;
  micReplayPromptEl.classList.remove("hidden");
  startStopBtn.classList.add("hidden");
  pauseResumeBtn.classList.add("hidden");
  newVideoBtn.classList.add("hidden");
  setStatus("idle");
}

function hideMicReplayPrompt() {
  micReplayPromptEl.classList.add("hidden");
  // We don't always want to reveal startStopBtn here — the post-playback
  // prompt also wants the start button hidden until the user clicks Restart.
}

function showMicPostPlaybackPrompt() {
  micPostPlaybackStatusEl.textContent = "";
  micPostPlaybackPromptEl.classList.remove("hidden");
  startStopBtn.classList.add("hidden");
  if (micBufferLiveEl) micBufferLiveEl.classList.add("hidden");
  replayMicAudioBtn.disabled = false;
  saveMicAudioBtn.disabled = false;
  newMicRecordingBtn.disabled = false;
  setStatus("idle");
}

function hideMicPostPlaybackPrompt() {
  micPostPlaybackPromptEl.classList.add("hidden");
  startStopBtn.classList.remove("hidden");
}

playMicAudioBtn.addEventListener("click", async () => {
  playMicAudioBtn.disabled = true;
  discardMicAudioBtn.disabled = true;
  setStatus("streaming");
  try {
    await chrome.runtime.sendMessage({ type: "PLAY_BUFFERED_MIC_AUDIO" });
  } catch (err) {
    showError("Could not start playback: " + (err.message || err));
    playMicAudioBtn.disabled = false;
    discardMicAudioBtn.disabled = false;
  }
});

discardMicAudioBtn.addEventListener("click", async () => {
  discardMicAudioBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "DISCARD_BUFFERED_MIC_AUDIO" });
  } catch (err) {}
  hideMicReplayPrompt();
  startStopBtn.classList.remove("hidden");
  resetUIToIdle();
  playMicAudioBtn.disabled = false;
  discardMicAudioBtn.disabled = false;
});

saveMicAudioBtn.addEventListener("click", async () => {
  saveMicAudioBtn.disabled = true;
  micPostPlaybackStatusEl.textContent = "Encoding…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: "SAVE_BUFFERED_MIC_AUDIO" });
    if (!resp || !resp.wavBytes) {
      micPostPlaybackStatusEl.textContent = "(nothing to save)";
      saveMicAudioBtn.disabled = false;
      return;
    }
    const blob = new Blob([resp.wavBytes], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const a = document.createElement("a");
    a.href = url;
    a.download = `polyglot-${stamp}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    micPostPlaybackStatusEl.textContent = "Saved.";
  } catch (err) {
    micPostPlaybackStatusEl.textContent = "Save failed: " + (err.message || err);
  } finally {
    saveMicAudioBtn.disabled = false;
  }
});

replayMicAudioBtn.addEventListener("click", async () => {
  replayMicAudioBtn.disabled = true;
  micPostPlaybackStatusEl.textContent = "Playing…";
  setStatus("streaming");
  try {
    await chrome.runtime.sendMessage({ type: "PLAY_BUFFERED_MIC_AUDIO" });
    // Re-enable + status reset happens when MIC_PLAYBACK_DONE arrives in the
    // listener (which calls showMicPostPlaybackPrompt → enables the button).
  } catch (err) {
    micPostPlaybackStatusEl.textContent = "Replay failed: " + (err.message || err);
    replayMicAudioBtn.disabled = false;
  }
});

newMicRecordingBtn.addEventListener("click", async () => {
  newMicRecordingBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "DISCARD_BUFFERED_MIC_AUDIO" });
  } catch (err) {}
  hideMicPostPlaybackPrompt();
  resetUIToIdle();
  newMicRecordingBtn.disabled = false;
});


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


function addCaption(caption) {
  const newText = (caption.translated || caption.text || "").trim();
  if (!newText) return;

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

  if (message.type === "MIC_PLAYBACK_DONE") {
    // Don't reset to idle automatically — leave the buffer intact and show a
    // Save / Restart prompt so the user can download the file or explicitly
    // end the session.
    hideMicReplayPrompt();
    showMicPostPlaybackPrompt();
    return;
  }

  if (message.type === "MIC_BUFFER_COUNT") {
    if (typeof message.count === "number") {
      micBufferLiveCountEl.textContent = String(message.count);
    }
    return;
  }

  if (message.type === "URL_CHANGED") {
    resetAndRestart({ alreadyStopped: true }).catch(() => {});
    return;
  }
  if (message.type === "TAB_SWITCHED") {
    resetUIToIdle();
    return;
  }

  if (message.type === "CAPTION") {

    if (!playbackStarted && sourceMode !== "mic") return;
    warmingUp.classList.add("hidden");
    stopConnectingTimer();
    setStatus("streaming");
    addCaption(message.caption);
  }
  if (message.type === "HIDE_OVERLAY" || message.type === "VIDEO_SYNC_STATUS") {
    playbackStarted = true;
    if (isCapturing && !isPaused) {
      pauseResumeBtn.classList.remove("hidden");
    }
  }
  if (message.type === "USER_PAUSED_VIDEO") {
    setPauseUI(true);
    pauseResumeBtn.classList.remove("hidden");
  }
  if (message.type === "USER_RESUMED_VIDEO") {
    setPauseUI(false);
  }

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
      if (!micReplayPromptEl.classList.contains("hidden")) return;
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

});
