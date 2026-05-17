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

const DEFAULT_BACKEND_URL = "ws://localhost:8765";

let isCapturing = false;
let isPaused = false;
let playbackStarted = false; 
let captions = [];
let connectingStartTime = null;
let connectingTimerInterval = null;
chrome.storage.local.get(["sourceLang", "targetLang", "captionHistory", "backendUrl"], (data) => {
  if (data.sourceLang) sourceLangEl.value = data.sourceLang;
  if (data.targetLang) targetLangEl.value = data.targetLang;
  if (data.backendUrl) backendUrlEl.value = data.backendUrl;
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
  startStopBtn.disabled = false;

  pauseResumeBtn.textContent = "Pause";
  pauseResumeBtn.className = "btn btn-pause hidden";

  newVideoBtn.classList.add("hidden");
  newVideoBtn.disabled = false;

  sourceLangEl.disabled = false;
  targetLangEl.disabled = false;

  warmingUp.classList.add("hidden");
  silenceWarning.classList.add("hidden");

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
  }
  resetUIToIdle();
}


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

  if (message.type === "URL_CHANGED") {
    resetAndRestart({ alreadyStopped: true }).catch(() => {});
    return;
  }
  if (message.type === "TAB_SWITCHED") {
    resetUIToIdle();
    return;
  }

  if (message.type === "CAPTION") {
    if (!playbackStarted) return;
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
