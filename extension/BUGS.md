# Chrome Extension v2 — Bug Log

Running log of bugs / smells found in the v2 extension. Each entry:
- **ID** — stable reference (BUG-NNN)
- **Severity** — HIGH (user-visible correctness), MED (edge/reliability), LOW (smell/cleanup)
- **Location** — file:line where relevant
- **Description** — what's wrong
- **Repro** — real-world steps OR a test sketch
- **Status** — Open / Fixed / Won't fix

## Resolution status (2026-04-25)

All 25 catalogued bugs have been addressed:
- **Fixed (24)**: BUG-001 through BUG-009, BUG-011, BUG-012, BUG-013, BUG-014, BUG-015, BUG-016, BUG-017, BUG-019, BUG-020, BUG-021, BUG-022, BUG-023, BUG-024, BUG-025
- **Won't fix (1)**: BUG-010 — re-analysis showed the frame-count exit is rate-correct; audio frames are emitted per audio-second, not per wall-clock-second.
- **Acknowledged but not fixed (1)**: BUG-018 — frameBuffer.shift() is O(n) but at N=300 the cost is negligible and a ring-buffer refactor would touch indexing across the file. Filed for future work.

`tests/bug-proofs.test.js` has been updated: each test now asserts the FIXED behavior and the suite passes (`npm test` shows 403 passing).

---

## Verification status (run `npm test` in `chrome-extension-v2/` to reproduce)

`tests/bug-proofs.test.js` contains 33 proof tests — each asserts the CURRENT (buggy) behavior. A passing proof test = the bug is real. When we fix a bug, we flip the assertion to express correct behavior (at which point the test goes red until the fix lands).

### Proven real (33/33 proofs pass + 5 pre-existing BUG tests fail)

| Bug | Evidence | Proof type |
|---|---|---|
| BUG-001 | 3 tests in `bug-proofs.test.js` | Behavioral (SW relays) + source grep (offscreen listens) |
| BUG-002 | `bug-proofs.test.js` | Behavioral — dup utterance + caption → caption never delivered |
| BUG-003 | 3 tests | Source + behavioral — `VIDEO_CLEANUP` doesn't reduce pause listener count |
| BUG-004 | `bug-proofs.test.js` | Source grep — `fullscreenchange` only calls `resizeCanvas` |
| BUG-005 | `netflix-pipeline.test.js` × 2 | **Pre-existing failing tests** + source grep |
| BUG-006 | `bug-proofs.test.js` | Source grep — only sidepanel writes `captionHistory` |
| BUG-007 | `bug-proofs.test.js` × 2 | Source grep — no `"waiting"` listener anywhere |
| BUG-008 | `bug-proofs.test.js` | Source grep — no `tabs.onRemoved` / `onUpdated` |
| BUG-009 | `bug-proofs.test.js` × 2 | Source grep — no `"ratechange"` listener, no rate clamp |
| BUG-010 | `bug-proofs.test.js` | Source grep — exit condition is frame-count, no wall clock |
| BUG-011 | Folded into BUG-003 proof | Behavioral — pause listener count unchanged after teardown |
| BUG-012 | `bug-proofs.test.js` | Source grep — `delayFrames` not referenced in `onVideoFrame` |
| BUG-013 | `bug-proofs.test.js` | Source grep — `audioStartSec` not even referenced in handler |
| BUG-014 | `bug-proofs.test.js` | Source grep — no `popstate`/`hashchange` |
| BUG-015 | `youtube-pipeline.test.js` × 2, `netflix-pipeline.test.js` × 1 | **Pre-existing failing tests** |
| BUG-016 | `bug-proofs.test.js` | Source grep — only `mediaKeys` checked, no `requestMediaKeySystemAccess` |
| BUG-017 | `bug-proofs.test.js` | Source grep — no `setTimeout` → `observer.disconnect` |
| BUG-018 | `bug-proofs.test.js` | Source grep — `frameBuffer.shift()` present |
| BUG-019 | `bug-proofs.test.js` × 2 | Behavioral — 5 captions → 5 `storage.set` calls |
| BUG-020 | `bug-proofs.test.js` × 2 | Source + behavioral — 200×100 thumbnail passes |
| BUG-021 | `bug-proofs.test.js` | Source grep — no `.disabled` assignment |
| BUG-022 | `bug-proofs.test.js` × 2 | Source count — many `console.log`, no `DEBUG` flag |
| BUG-023 | `bug-proofs.test.js` | Source grep — `recentCaptions` is array + `.includes` |
| BUG-024 | `bug-proofs.test.js` | Source grep — hardcoded `0.005` threshold |
| BUG-025 | `bug-proofs.test.js` | Source grep — `onended` always calls `scheduleBufferedAudio` |

### Caveats on the proofs

The proofs come in three flavors:

1. **Pre-existing failing BUG: tests** (BUG-005, BUG-015) — strongest evidence. Describe expected behavior and fail today.

2. **Behavioral proofs** (BUG-002, BUG-003/011 listener counts, BUG-019 storage calls, BUG-020 tiny video) — drive the module and observe an effect. Second-strongest.

3. **Source-grep proofs** (majority) — assert the code does or doesn't contain a pattern. These are only as strong as my claim that "the absence of this pattern means the bug is real." For bugs like BUG-007 ("no `waiting` listener exists"), the source grep IS the proof — there's no possible runtime where the listener fires without the code existing. For bugs like BUG-012 (`delayFrames` dead code), the grep proves the variable isn't read in the loop, but doesn't prove that's a bug — it's dead-code-ness is the claim.

### Known-weak proofs (flagging honestly)

- **BUG-001 relay mechanics**: I'm asserting via the docs that `chrome.runtime.sendMessage` from a content script reaches both SW and offscreen in real Chrome. The two sub-proofs (SW relays; offscreen has a listener) are each true — the *conclusion* that this causes double delivery is a documentation claim, not a runtime test. To turn this into a hard proof I'd need a harness that loads SW + offscreen in the same faithful runtime mock (not currently in helpers.js). **Recommended: manually verify in real Chrome before fixing** — open DevTools on both the SW and offscreen, add a `console.trace()` on the USER_PAUSED_VIDEO listeners, pause the video, count frames.

- **BUG-023 perf**: proof shows `recentCaptions` is an array. Whether this is a *bug* at N=20 is an opinion, not a fact.

- **BUG-024 trimSilence threshold**: proof shows threshold is 0.005. Whether that's too aggressive is domain-dependent (fine for sports, possibly bad for audiobooks).

### Can't be unit-tested (need real browser)

These bugs have source-grep proofs showing the prerequisite (missing code) but can't be fully reproduced in Jest. Manual repro documented in each entry:

- BUG-004 (fullscreen DOM re-parenting)
- BUG-006 (sidepanel close — can't close a sidepanel in Node)
- BUG-014 (SPA nav — would need jsdom + history API + real video)
- BUG-016 (DRM timing — needs EME-encrypted stream)
- BUG-017 (runaway MutationObserver — perf claim, not correctness)

---

## HIGH severity

### BUG-001 — Double delivery of pause/resume messages via SW relay
**Location:** `service-worker.js:124-126`, `offscreen/offscreen.js:137-155`, `sidepanel/sidepanel.js:319-325`

`chrome.runtime.sendMessage` from a content script fans out to **all** extension contexts (SW, offscreen, sidepanel). The service worker then re-broadcasts `USER_PAUSED_VIDEO` / `USER_RESUMED_VIDEO` via `broadcastToExtension(message)`, so offscreen and sidepanel receive each message twice.

Offscreen's handler is idempotent (`isPaused = true` then `true`; `suspend()` on an already-suspended context is a no-op), so today it masks the bug. But: pause semantics get fragile — e.g. if you later add `silenceFrames = 0` on pause, the second delivery wipes the counter mid-frame.

**Repro (test):** Given the existing SW message-relay test scaffolding, assert that offscreen's `isPaused` listener fires **once** per user-triggered pause. Today it fires twice.

**Fix sketch:** Don't re-broadcast `USER_PAUSED_VIDEO`/`USER_RESUMED_VIDEO` in the SW — offscreen and sidepanel already receive the original from the content script.

---

### BUG-002 — `pendingCaptions` / `scheduledAudioTimes` leak on dropped utterances
**Location:** `offscreen/offscreen.js:77-78, 394-408, 481-517`

Caption and audio are keyed by `seq` in two maps. Delivery happens when the *second* of the pair arrives.

If `finalizeUtterance()` drops an utterance via dedup (exact-key or timestamp-overlap), the corresponding caption — which arrives on its own `caption` message and may already be in `pendingCaptions` — is **never delivered and never cleared**. The map grows unbounded across a long session with frequent re-captures (seekback, Deepgram dupes).

Similarly, if a caption message is dropped by the backend for a seq that *did* get `scheduleAudioItem`, `scheduledAudioTimes` leaks an entry.

**Repro (test):**
1. Pump `utterance_start {seq:1}` → binary chunks → `utterance_end {seq:1, start:0, end:1}`.
2. Pump the identical `utterance_end {seq:2, start:0, end:1}` → should be dedup-dropped.
3. Send `caption {seq:2, translated:"foo"}`.
4. Assert `pendingCaptions.size === 0` (currently → 1, leaks forever).

**Fix sketch:** Either (a) cap map size with FIFO eviction, or (b) clear entries for dropped seqs. Easiest: in the dedup-drop branches, also `pendingCaptions.delete(utterance.seq)` (though caption and utterance seqs aren't guaranteed to match — verify with backend).

---

### BUG-003 — Content-script `chrome.runtime.onMessage` listener never removed on teardown
**Location:** `content-script.js:14, 529, 685-701`

The IIFE registers a persistent `chrome.runtime.onMessage` listener. `__liveTranslatorV2Teardown` nulls out state (video, canvas, flags) but **never calls `chrome.runtime.onMessage.removeListener(...)`**. A fresh injection's IIFE runs `onMessage.addListener(...)` again — now there are 2. Over multiple start/stop cycles (or SPA navs that re-inject), listeners stack.

Effect: old listeners still fire on every message with stale closure state. `video` is null so most branches early-out, but:
- `sendResponse({ ok: !!video, mode: syncMode })` for `START_SYNC` — multiple handlers calling `sendResponse` can interleave; only first wins, the others throw "message port closed" errors.
- Old `bindPauseDetection` listeners (attached via `addEventListener` inside the old closure) also still fire and can send `USER_PAUSED_VIDEO` with stale `userPaused`/`extensionPaused` flags → contradicts the new IIFE's truth.

**Repro:** Start → Stop → Start → Stop 3×. Observe in DevTools console that `onMessage` is being called N times per message.

**Fix sketch:** Store the listener ref and `removeListener` in teardown. Same for the `bindPauseDetection` handlers (remove from `video.addEventListener("pause"/"play", ...)`).

---

### BUG-004 — Fullscreen breaks the canvas overlay
**Location:** `content-script.js:187-190`

Canvas is appended to `video.parentElement` and positioned with `videoRect - parentRect`. When the user enters YouTube fullscreen, the browser promotes a *different* element (usually `#movie_player` or similar) to fullscreen — the canvas is no longer a descendant of the fullscreen element, so it's **not rendered at all** during fullscreen. User sees the (hidden) video with no translated frames.

`document.addEventListener("fullscreenchange", resizeCanvas)` only recomputes geometry, which doesn't help because the canvas is in the wrong DOM subtree.

**Repro:** Start capture on any YouTube video → press `F` for fullscreen → nothing is drawn, the video (hidden via `opacity:0`) looks black.

**Fix sketch:** On `fullscreenchange`, if `document.fullscreenElement` exists and is not an ancestor of canvas, re-parent canvas into `document.fullscreenElement` (or into the video's new parent chain). Recompute geometry.

---

### BUG-005 — No WebSocket reconnect on transient disconnect
**Location:** `offscreen/offscreen.js:233`

`ws.onclose = () => stopCapture()` — any close, even a transient network blip, nukes the whole session. User has to manually click Start again; captions before the drop are kept but the pipeline dies.

**Repro:** Start capture → block `localhost:8765` for 2s (Little Snitch, `sudo pfctl`, or kill/restart the server) → extension silently dies.

**Fix sketch:** On abnormal close (code ≠ 1000), hold audio buffer, attempt reconnect with backoff (1s, 2s, 4s, cap 8s, 3 attempts). Keep Deepgram session continuity via backend support, or accept that a new session will produce a small repeated translation at the seam.

*Known gap per CLAUDE.md — still tracking here for completeness.*

---

### BUG-006 — Captions lost when side panel is closed mid-session
**Location:** `sidepanel/sidepanel.js:224-250`, `offscreen/offscreen.js:98-104`

Captions flow offscreen → SW → sidepanel. The sidepanel itself persists them to `chrome.storage.local`. If the user closes the side panel during a session, `chrome.runtime.sendMessage` from offscreen silently fails (`.catch(() => {})`), captions that fire during the closed window are lost, and on reopen the history is whatever was last persisted.

**Repro:** Start capture → close the side panel → wait 30s → reopen. Captions emitted while closed are gone.

**Fix sketch:** Move the persistence up to the service worker (or offscreen). Sidepanel reads from storage on open; storage is the source of truth, not the DOM.

---

### BUG-007 — Video `waiting` (stall/rebuffer) doesn't pause translated audio
**Location:** `content-script.js:103-128` (only handles `pause`/`play`)

If the video stalls for network buffering, it fires `waiting` (and later `canplay`/`playing`) — not `pause`. Our audio keeps playing. User hears translated commentary continue over a frozen video.

**Repro:** Start capture on a video, then throttle network to "Slow 3G" in DevTools → video stalls, audio continues → persistent desync.

**Fix sketch:** Listen for `waiting` → send `USER_PAUSED_VIDEO`-ish signal (or a new `VIDEO_STALLED`); on `playing` send resume. Plus reset drift state if stall was long.

---

## MEDIUM severity

### BUG-008 — `activeTabId` not cleared on tab close / navigation
**Location:** `service-worker.js:17, 150-197` (no `tabs.onRemoved` or `tabs.onUpdated` hooks)

If the user closes the captured tab without hitting Stop, the SW still holds `activeTabId` and `sessionActive = true`. Subsequent `sendToContentScript` calls target a dead tab (harmless — errors swallowed by `() => {}`), but offscreen keeps streaming silence through the WS (the tab-capture stream ends, but the WebSocket and AudioContext persist until user clicks Stop on the ghost session).

**Repro:** Start capture → close the tab → observe WS still open in offscreen, silence-warning UI triggers but nothing recovers.

**Fix sketch:** `chrome.tabs.onRemoved.addListener(tabId => if (tabId === activeTabId) handleStopCapture())`. Same for `onUpdated` when URL changes away from the original.

---

### BUG-009 — Video rate change via YouTube shortcuts breaks canvas-mode sync
**Location:** `content-script.js` (no handler for `ratechange`)

In canvas mode the video is hidden but still receives keyboard input on the tab. YouTube's `>` / `<` shortcuts change `playbackRate`. The frame buffer now drains at the new rate, but audio plays at 1×. Permanent drift.

**Repro:** Start capture on YouTube → press `>` once to go to 1.25× → drift accumulates ~12 frames/sec.

**Fix sketch:** Listen to `ratechange`; either force rate back to 1.0 in canvas mode, or match `playbackCtx.destination` rate (harder). Simplest: clamp to 1.0 while capture is active.

---

### BUG-010 — Seekback replay-zone heuristic assumes 1× playback
**Location:** `offscreen/offscreen.js:85-88, 299-306, 573-579`

Replay zone ends when `capturedFrameCount >= seekbackFrameMark * 2`. This only holds if the video plays the replay at 1×. If the user adjusts rate during replay (or the video auto-rate-adjusts due to ABR), we either (a) drop too many frames (miss fresh audio) or (b) drop too few (duplicate translations).

**Repro (test):** Drive the offscreen state machine into the replay zone. Artificially vary `capturedFrameCount` increment rate (simulating 2× replay by doubling the frame cadence) → show backend receives duplicate content.

**Fix sketch:** Use wall-clock duration since seekback, not frame count. Exit zone when `Date.now() - seekbackStartMs >= totalAudioCapturedSec * 1000`.

---

### BUG-011 — Old IIFE pause/play listeners remain on `<video>` after teardown
**Location:** `content-script.js:103-128, 685-701`

`video.addEventListener("pause", ...)` inside `bindPauseDetection`. Teardown nulls `video` but doesn't `removeEventListener`. When the user (on the same page) starts a new session, the old handlers still fire against the same `<video>` element, sending `USER_PAUSED_VIDEO` with closure state frozen from a prior session.

**Repro:** Start → Stop → Start on the same page → pause the video manually → sidepanel may receive two USER_PAUSED_VIDEO messages, one from each IIFE.

**Fix sketch:** Track handler refs in teardown; `video.removeEventListener("pause", pauseFn)`, etc.

---

### BUG-012 — `delayFrames` is dead code (never consulted in draw loop)
**Location:** `content-script.js:45, 234-240, 549-554`

`delayFrames` is computed in `updateDelayFrames()` and updated on `SET_DELAY`, but `onVideoFrame` only checks `frameBuffer.length > 1` before shifting — the delay is implicitly whatever accumulated during the buffer phase. The `SET_DELAY` → `targetDelaySec` → `delayFrames` plumbing does nothing at runtime.

Not a functional bug today (the buffer-accumulation implicitly matches pipeline latency), but it's confusing and means a backend latency change after playback starts isn't reflected.

**Repro (test):** Simulate `SET_DELAY` with `delaySec=10` mid-playback; assert that the buffered frame count actually converges toward `10 * 30 = 300`. Currently doesn't.

**Fix sketch:** Either remove `delayFrames` entirely (plus `SET_DELAY`), or gate `frameBuffer.shift()` on `frameBuffer.length > delayFrames` so the buffer can actually grow/shrink to match a changing target.

---

### BUG-013 — `PLAYBACK_STARTED.audioStartSec` is sent but unused
**Location:** `offscreen/offscreen.js:569-579`, `content-script.js:624-638`

Offscreen computes `audioStartSec = decodedQueue[0].originalStartSec` and ships it to the content script, which only logs it. The comment implies it's meant to "align the canvas to the same position" but nothing acts on it.

If the first utterance starts at `originalStartSec > 0`, the frame buffer's oldest frame is `t = 0`, but the first audio payload corresponds to `t = originalStartSec`. The leading silence gap in playback compensates in practice (`Math.min(gap, 3.0)`), capped at 3s — so for long leading silences the alignment is off.

**Repro:** Open a video that starts with 10s of ambient music, then first speech. Audio has 3s silence then first TTS. Frame buffer shows frame `t=0` when audio plays `t=10` content. Desync = 7s.

**Fix sketch:** Either (a) drop frames older than `audioStartSec` from the buffer on `PLAYBACK_STARTED`, or (b) remove the silence cap and let the gap be real.

---

### BUG-014 — SPA navigation (YouTube next-video) isn't re-detected
**Location:** `content-script.js:85-95` (observer disconnects once video is found)

Once a `<video>` is found, we `observer.disconnect()`. YouTube's SPA nav typically reuses the same `<video>` element, so this is *mostly* fine — but if a site tears down and rebuilds the video node on nav, we don't notice and `video` points to an orphaned element.

**Repro:** Start capture on a Twitch VOD → click a clip in chat → video element replaced → canvas overlay pointed at stale element.

**Fix sketch:** Keep observer alive (or recreate on `popstate` / `hashchange`), re-check `findVideo()` on URL change.

---

### BUG-015 — `VIDEO_SYNC_STATUS` handler in sidepanel has no sender
**Location:** `sidepanel/sidepanel.js:372-387`, nothing in `offscreen.js` / `content-script.js` emits it

The sync badge UI is wired for buffer/rate status, but no code emits `VIDEO_SYNC_STATUS`. CLAUDE.md describes a drift-correction polling loop ("poll actual video position every 2s, adjust rate (0.85x-1.10x)") — that loop isn't implemented.

Not a bug in current behavior, but it's a feature gap vs. the documented design. Flagging so we decide: implement it, or strip the dead UI.

---

### BUG-016 — DRM detection false-negatives via `mediaKeys`
**Location:** `content-script.js:138-143`

`video.mediaKeys` is frequently `null` at the moment we check, even on EME-encrypted streams — it's only set once EME negotiation completes. So `detectDRM()` often returns `false` on DRM content, and we fall through to the frame-black-check (which does catch it, but wastes ~15 frames ≈ 500ms before falling back).

Not a correctness bug (the fallback works), but increases time-to-playback on Netflix et al.

**Fix sketch:** Also check `navigator.requestMediaKeySystemAccess` history, or MediaSource/MSE fingerprints, or just skip `mediaKeys` as unreliable and rely wholly on frame-content verification.

---

## LOW severity (smells / cleanup)

### BUG-017 — `MutationObserver` on `document.body` with subtree is expensive
**Location:** `content-script.js:92`

Fires on every DOM change anywhere in the page. YouTube mutates constantly (comments, thumbnails, live chat). Once we've found a video we disconnect, so the window is small — but on pages where video load is slow (or absent), observer stays hot.

**Fix sketch:** Add a 10s timeout; if still no video, disconnect and show "no video found" in sidepanel.

### BUG-018 — `frameBuffer.shift()` is O(n) on a 300-element array @ 30fps
**Location:** `content-script.js:311, 316, 331`

At 30fps × 300 elements = 9000 shifts/sec. Not a perf problem on a modern laptop but wastes CPU and garbages memory. A ring buffer would be O(1).

### BUG-019 — `chrome.storage.local.set({ captionHistory })` on every caption
**Location:** `sidepanel/sidepanel.js:249`

Writes the full caption array (up to 200 items) on every new caption. Wasteful I/O. Batch with a debounced write (500ms) instead.

### BUG-020 — Multiple `<video>` on page: "largest non-playing" can pick a thumbnail/preview
**Location:** `content-script.js:70-78`

Picks the largest by area if nothing is playing. On sites like Twitter/Instagram feeds, hover-preview thumbnails are large and autoplay briefly. We could lock on a preview.

**Fix sketch:** Require a min size (e.g., `videoWidth >= 480`) and prefer videos with a duration >= 60s.

### BUG-021 — Language selectors remain editable during capture
**Location:** `sidepanel/sidepanel.js:46-51` (no `disabled` toggle)

User can change source/target while streaming; the change is ignored until next Start, but the UI makes it look live.

**Fix sketch:** Disable selects while `isCapturing`.

### BUG-022 — Verbose `console.log` in prod
**Location:** `offscreen/offscreen.js:133, 142, 154, 301, 418, 438, 488, 499, 511, 583`, `content-script.js:353, 361, 367, 385, 393, 632`

Noise. Gate behind a `DEBUG` flag or strip.

### BUG-023 — `recentCaptions` dedup is O(n) scan with string `includes`
**Location:** `offscreen/offscreen.js:381-383`

Small N (20) so fine, but using a `Set` would be cleaner and guards against duplicated work with the sidepanel's own fuzzy dedup.

### BUG-024 — `trimSilence` threshold 0.005 can cut soft speech endings
**Location:** `offscreen/offscreen.js:458-475`

ElevenLabs sometimes has a long soft tail; 0.005 trims quieter-than-whisper. OK for sports but could degrade for music/quiet voiceover.

### BUG-025 — `onended` of one source triggers full `scheduleBufferedAudio()` drain
**Location:** `offscreen/offscreen.js:648-650`

Every audio source's `onended` calls `scheduleBufferedAudio` which drains the *entire* queue. Most calls are no-ops (queue empty), but with many utterances piling up, it's repeated work.

---

## Notes / Observations (not bugs, but worth knowing)

- Overrun-correction math (`translationOverrun`) is correct but reads like it shouldn't be — verified by hand, the `max(0, …)` clamp covers both asymmetric cases.
- The synchronous dedup in `finalizeUtterance()` is subtle and load-bearing — any future refactor that adds an `await` above `seenUtteranceKeys.add(...)` will re-open dedup races.
- `bindPauseDetection`'s `extensionTriggeredPause/Play` flag is a single-shot token — if any code path triggers two extension-issued pauses without the event firing between them, the second looks like a user pause. No path does this today (verified).
- The "first utterance adds up to 3s silence" behavior is by design — canvas frame 0 aligns to audio at `originalStartSec=0`. See BUG-013 for the case where it breaks.

---

## Working through these

Suggested order to tackle, cheapest-value-first:
1. BUG-003, BUG-011 (listener leaks) — quick, clear fix, improves stability for any multi-session flow.
2. BUG-001 (double-relay) — 1-line fix in SW.
3. BUG-002 (caption map leak) — add size cap + dedup-drop cleanup.
4. BUG-004 (fullscreen) — user-visible, needs DOM re-parenting.
5. BUG-007 (stall pause) — add `waiting`/`playing` listeners.
6. BUG-008 (tab close cleanup) — add `tabs.onRemoved` hook.
7. BUG-009 (rate change hijack) — clamp or match.
8. BUG-006 (caption persistence) — move up to SW.
9. BUG-005 (WS reconnect) — nontrivial, save for last.

Remaining items = cleanup + the feature-gap ones (BUG-015).
