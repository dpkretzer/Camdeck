const socket = io({
  autoConnect: false,
  auth: (cb) => cb(buildSocketAuth())
});

const homeScreen = document.getElementById("homeScreen");
const roleScreen = document.getElementById("roleScreen");
const liveScreen = document.getElementById("liveScreen");

const roomIdInput = document.getElementById("roomId");
const cameraNameInput = document.getElementById("cameraName");
const cameraSelectInput = document.getElementById("cameraSelect");
const connectRoomBtn = document.getElementById("connectRoom");
const changeRoomBtn = document.getElementById("changeRoom");
const disconnectRoomBtn = document.getElementById("disconnectRoom");
const retryPlaybackBtn = document.getElementById("retryPlayback");
const rejoinLastBtn = document.getElementById("rejoinLast");
const toggleLayoutBtn = document.getElementById("toggleLayout");
const toggleMotionFollowBtn = document.getElementById("toggleMotionFollow");
const toggleMuteBtn = document.getElementById("toggleMute");
const toggleCameraBtn = document.getElementById("toggleCamera");
const startRecordingBtn = document.getElementById("startRecording");
const stopRecordingBtn = document.getElementById("stopRecording");
const cameraHudOnlyControls = [toggleMuteBtn, toggleCameraBtn, startRecordingBtn, stopRecordingBtn, toggleMotionFollowBtn, toggleLayoutBtn];

const statusMessage = document.getElementById("statusMessage");
const connectionBadge = document.getElementById("connectionBadge");
const roleInfoChip = document.getElementById("roleInfoChip");
const hudMicBadge = document.getElementById("hudMicBadge");
const hudCameraBadge = document.getElementById("hudCameraBadge");
const hudRecordingBadge = document.getElementById("hudRecordingBadge");
const hudOnlineBadge = document.getElementById("hudOnlineBadge");
const emptyState = document.getElementById("emptyState");
const sessionTimeline = document.getElementById("sessionTimeline");
const toastRegion = document.getElementById("toastRegion");

const startCameraBtn = document.getElementById("startCamera");
const startViewerBtn = document.getElementById("startViewer");
const remoteVideos = document.getElementById("remoteVideos");

let currentRoomId = "";
let currentRoomNumber = "";
let currentAccessKey = "";
let currentRoomCode = "";
let role = null;
let localStream = null;
let localParticipantId = "";
let layoutMode = "grid";
let motionFollowEnabled = false;
let localPeerTile = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingStream = null;
let recordingSourceLabel = "";
let availableCameraDevices = [];
let selectedCameraDeviceId = "";
let activeJoinAttempt = 0;
let activeCameraTileId = "";
const peers = new Map();
const cameraNames = new Map();
const cameraVideoStates = new Map();
const tileMediaStates = new Map();
const motionWatchers = new Map();
const lastMotionLogAt = new Map();
const pendingRemoteVideoToggle = new Set();
let cameraController = null;

function isViewCameraFeedsPageActive() {
  const liveVisible = liveScreen?.classList.contains("active");
  return Boolean(window.viewerPage?.isViewerFeedsPage?.() && liveVisible && role);
}

function syncCameraSocketLifecycle() {
  if (!cameraController) return;
  if (isViewCameraFeedsPageActive()) {
    cameraController.init();
  } else {
    cameraController.destroy();
  }
}

function normalizeRoomCode(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (!trimmed.includes(":")) {
    return trimmed.toUpperCase();
  }

  const [roomNumber, accessKey] = trimmed.split(":");
  const normalizedRoom = (roomNumber || "").trim().toUpperCase();
  const normalizedAccessKey = (accessKey || "").trim();
  return `${normalizedRoom}:${normalizedAccessKey}`;
}

function validateRoomCodeInput(value) {
  const normalized = value.trim();
  if (!normalized) return false;

  if (normalized.includes(":")) {
    const [roomNumber, accessKey] = normalized.split(":");
    return /^[A-Z0-9_-]{3,24}$/i.test((roomNumber || "").trim()) && /^k_[A-Za-z0-9_-]{8,}$/.test((accessKey || "").trim());
  }

  return /^[A-Z0-9_-]{3,24}$/i.test(normalized);
}

function showScreen(screen) {
  [homeScreen, roleScreen, liveScreen].forEach((item) => {
    item.classList.toggle("active", item === screen);
    if (item === screen) {
      item.classList.remove("hidden");
      item.style.display = "block";
    } else {
      item.classList.add("hidden");
      item.style.display = "none";
    }
  });

  // Keep URL/page flag in sync so camera sockets are only active on /viewer while live is visible.
  if (screen === liveScreen) {
    window.viewerPage?.enterViewerFeedsPage?.();
  } else {
    window.viewerPage?.leaveViewerFeedsPage?.();
  }
  syncCameraSocketLifecycle();
}

function setStatus(message) {
  statusMessage.textContent = message || "";
}

function showToast(message, type = "info", durationMs = 2600) {
  if (!toastRegion || !message) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.setAttribute("role", "status");
  toast.textContent = message;
  toastRegion.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(6px)";
    setTimeout(() => toast.remove(), 220);
  }, durationMs);
}

function setButtonBusy(button, busy, busyLabel = "Loading...") {
  if (!button) return;
  if (busy) {
    if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent;
    button.textContent = busyLabel;
    button.classList.add("btn-loading");
    button.disabled = true;
    return;
  }

  button.classList.remove("btn-loading");
  if (button.dataset.defaultLabel) {
    button.textContent = button.dataset.defaultLabel;
  }
  button.disabled = false;
}

window.addEventListener("error", (event) => {
  const detail = event?.message || "Unexpected app error.";
  setStatus(`App error: ${detail}`);
});


function updateLiveInfoChips() {
  if (roleInfoChip) {
    roleInfoChip.textContent = role ? role.toUpperCase() : "None";
  }
}

function setConnectionBadge(connected) {
  connectionBadge.textContent = connected ? "Server connection: online" : "Server connection: offline";
  connectionBadge.classList.toggle("online", connected);
  connectionBadge.classList.toggle("offline", !connected);
  updateFeedHudBadges();
}

function setHudBadgeState(element, text, { active = false, alert = false } = {}) {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("is-active", active);
  element.classList.toggle("is-alert", alert);
}

function updateFeedHudBadges() {
  const [audioTrack] = localStream?.getAudioTracks?.() || [];
  const [videoTrack] = localStream?.getVideoTracks?.() || [];
  const isRecording = mediaRecorder && mediaRecorder.state === "recording";

  const micText = audioTrack ? `MIC ${audioTrack.enabled ? "ON" : "OFF"}` : "MIC --";
  const cameraText = videoTrack ? `CAM ${videoTrack.enabled ? "ON" : "OFF"}` : "CAM --";
  const recordingText = `REC ${isRecording ? "ON" : "OFF"}`;
  const onlineText = `NET ${socket.connected ? "ON" : "OFF"}`;

  setHudBadgeState(hudMicBadge, micText, { active: Boolean(audioTrack?.enabled), alert: Boolean(audioTrack && !audioTrack.enabled) });
  setHudBadgeState(hudCameraBadge, cameraText, { active: Boolean(videoTrack?.enabled), alert: Boolean(videoTrack && !videoTrack.enabled) });
  setHudBadgeState(hudRecordingBadge, recordingText, { active: Boolean(isRecording), alert: !isRecording });
  setHudBadgeState(hudOnlineBadge, onlineText, { active: socket.connected, alert: !socket.connected });
}

function roomId() {
  return normalizeRoomCode(roomIdInput.value.trim());
}

function cameraName() {
  // Username/camera-name entry was removed from login; keep optional support if field exists.
  return cameraNameInput?.value?.trim?.().slice(0, 24) || "";
}

function cameraDeviceId() {
  return cameraSelectInput.value || selectedCameraDeviceId || "";
}

function resetRoomContext() {
  currentRoomId = "";
  currentRoomNumber = "";
  currentAccessKey = "";
  currentRoomCode = "";
  localParticipantId = "";
  activeJoinAttempt += 1;
  updateLiveInfoChips();
  console.log("[Signal] room state cleared", {
    currentRoomId,
    currentRoomNumber,
    hasAccessKey: Boolean(currentAccessKey),
    hasRoomCode: Boolean(currentRoomCode),
    activeJoinAttempt
  });
}

function applyAuthorizedRoom(authorization, source = "unknown") {
  currentRoomId = authorization?.roomId || "";
  currentRoomNumber = authorization?.roomNumber || "";
  currentAccessKey = authorization?.accessKey || "";
  currentRoomCode = authorization?.roomCode || "";
  updateLiveInfoChips();
  console.log("[Signal] applyAuthorizedRoom", {
    source,
    roomId: currentRoomId || undefined,
    roomNumber: currentRoomNumber || undefined,
    hasAccessKey: Boolean(currentAccessKey),
    hasRoomCode: Boolean(currentRoomCode)
  });
}

function saveSession(nextRole = role) {
  if (!currentRoomId || !currentAccessKey || !currentRoomCode) return;
  localStorage.setItem(
    "camdeck-session",
    JSON.stringify({
      roomId: currentRoomId,
      roomNumber: currentRoomNumber,
      accessKey: currentAccessKey,
      roomCode: currentRoomCode,
      role: nextRole || null,
      cameraName: cameraName()
    })
  );
}

function loadSession() {
  try {
    const sessionRaw = localStorage.getItem("camdeck-session");
    if (!sessionRaw) return null;
    return JSON.parse(sessionRaw);
  } catch {
    return null;
  }
}

function applyLayout() {
  const focusMode = layoutMode === "focus";
  remoteVideos.classList.toggle("xl:grid-cols-1", focusMode);
  remoteVideos.classList.toggle("2xl:grid-cols-1", focusMode);
  toggleLayoutBtn.textContent = focusMode ? "Grid layout" : "Focus layout";
}

function applyActiveCameraLayout() {
  const cards = Array.from(remoteVideos.querySelectorAll("[data-participant-tile]"));
  if (!cards.length) {
    activeCameraTileId = "";
    return;
  }

  const hasActive = cards.some((card) => card.id === `card-${activeCameraTileId}`);
  if (!hasActive) {
    activeCameraTileId = cards[0].id.replace("card-", "");
  }

  cards.forEach((card) => {
    const cardId = card.id.replace("card-", "");
    const isActive = cardId === activeCameraTileId;
    card.classList.toggle("active-camera", isActive);
    card.classList.toggle("thumbnail-camera", !isActive);
  });

  const activeCard = document.getElementById(`card-${activeCameraTileId}`);
  if (activeCard && remoteVideos.firstElementChild !== activeCard) {
    remoteVideos.prepend(activeCard);
  }
}

function setActiveCameraTile(id, { scrollIntoView = true } = {}) {
  if (!id || !document.getElementById(`card-${id}`)) return;
  activeCameraTileId = id;
  applyActiveCameraLayout();
  if (scrollIntoView) {
    document.getElementById(`card-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function applyMotionFollowButton() {
  toggleMotionFollowBtn.textContent = `Motion follow: ${motionFollowEnabled ? "On" : "Off"}`;
}

function applyLocalControlButtons() {
  const controlsEnabled = role === "camera" && !!localStream;
  const hasAudioTrack = Boolean(localStream?.getAudioTracks?.().length);
  const muteEnabled = controlsEnabled && hasAudioTrack;

  toggleMuteBtn.disabled = !muteEnabled;
  toggleCameraBtn.disabled = !controlsEnabled;
  toggleMuteBtn.classList.toggle("opacity-50", !muteEnabled);
  toggleCameraBtn.classList.toggle("opacity-50", !controlsEnabled);

  if (!localStream) {
    toggleMuteBtn.textContent = "Mute";
    toggleCameraBtn.textContent = "Camera off";
    updateFeedHudBadges();
    return;
  }

  const [audioTrack] = localStream.getAudioTracks();
  const [videoTrack] = localStream.getVideoTracks();
  if (!audioTrack) {
    toggleMuteBtn.textContent = "Mute unavailable";
  } else {
    toggleMuteBtn.textContent = audioTrack.enabled ? "Mute" : "Unmute";
  }
  toggleCameraBtn.textContent = videoTrack && videoTrack.enabled ? "Camera off" : "Camera on";
  updateFeedHudBadges();
}

function applyRecordingButtons() {
  const recorderSupported = typeof MediaRecorder !== "undefined";
  const isRecording = mediaRecorder && mediaRecorder.state === "recording";
  startRecordingBtn.disabled = !recorderSupported || isRecording;
  stopRecordingBtn.disabled = !recorderSupported || !isRecording;
  startRecordingBtn.classList.toggle("opacity-50", !recorderSupported || isRecording);
  stopRecordingBtn.classList.toggle("opacity-50", !recorderSupported || !isRecording);
  updateFeedHudBadges();
}

function applyLiveControlsVisibility() {
  const hideCameraHudControls = role === "camera";
  cameraHudOnlyControls.forEach((button) => {
    if (!button) return;
    button.classList.toggle("hidden", hideCameraHudControls);
    button.setAttribute("aria-hidden", hideCameraHudControls ? "true" : "false");
  });
}

function updateEmptyState() {
  const participantTiles = remoteVideos.querySelectorAll("[data-participant-tile]").length;
  emptyState.style.display = role === "viewer" && participantTiles === 0 ? "block" : "none";
}

function addTimelineEvent(message) {
  const item = document.createElement("li");
  const now = new Date();
  const stamp = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  item.textContent = `[${stamp}] ${message}`;
  sessionTimeline.prepend(item);

  while (sessionTimeline.children.length > 30) {
    sessionTimeline.removeChild(sessionTimeline.lastChild);
  }
}


function buildSocketAuth() {
  return {
    roomId: currentRoomId || "",
    roomCode: currentRoomCode || "",
    accessKey: currentAccessKey || "",
    role: role === "camera" ? "camera" : "viewer",
    name: cameraName() || "guest"
  };
}

function ensureSocketConnected() {
  if (socket.connected) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Could not connect to server. Is KoziKamera running?"));
    }, 5000);

    const onConnect = () => {
      cleanup();
      resolve();
    };

    const onError = (err) => {
      cleanup();
      reject(err || new Error("Connection error"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
    };

    socket.on("connect", onConnect);
    socket.on("connect_error", onError);
    socket.connect();
  });
}

async function refreshAuthorizationForJoin(source) {
  if (!currentRoomCode) {
    throw new Error("No room code available. Reconnect to a room first.");
  }

  const authorization = await authorizeRoom(currentRoomCode);
  applyAuthorizedRoom(authorization, source);
}

function joinRoomWithRole(roleName) {
  const joinAttempt = ++activeJoinAttempt;
  const [videoTrack] = localStream?.getVideoTracks?.() || [];
  return refreshAuthorizationForJoin(`joinRoomWithRole:${roleName}`).then(() => {
    const authPayload = {
      roomId: currentRoomId || undefined,
      accessKey: currentAccessKey || undefined,
      roomCode: currentRoomCode || undefined
    };

    console.log("[Signal] join-room auth payload", {
      role: roleName,
      roomId: authPayload.roomId,
      roomCode: authPayload.roomCode,
      hasAccessKey: Boolean(authPayload.accessKey),
      hasRoomCode: Boolean(authPayload.roomCode),
      joinAttempt
    });

    return new Promise((resolve, reject) => {
      socket.emit(
        "join-room",
        {
          role: roleName,
          name: roleName === "camera" ? cameraName() : "",
          videoEnabled: roleName === "camera" ? videoTrack?.enabled !== false : undefined,
          pageContext: window.viewerPage?.isViewerFeedsPage?.() ? "viewer-feeds" : "default",
          ...authPayload
        },
        (response) => {
          if (joinAttempt !== activeJoinAttempt) {
            console.warn("[Signal] Ignoring stale join-room callback", { joinAttempt, activeJoinAttempt });
            reject(new Error("Stale join response ignored."));
            return;
          }
          if (!response || !response.ok) {
            reject(new Error(response?.error || "Failed to join room"));
            return;
          }
          resolve();
        }
      );
    });
  });
}

function getReadableMediaError(error) {
  const errorName = error?.name || "UnknownError";
  const errorMessage = error?.message ? ` (${error.message})` : "";
  const failedConstraint = error?.constraint ? ` [constraint: ${error.constraint}]` : "";
  const detail = `${errorName}${errorMessage}${failedConstraint}`;

  if (errorName === "NotAllowedError" || errorName === "SecurityError") {
    return `Permission denied. Allow camera/microphone access in browser settings and reload. [${detail}]`;
  }
  if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
    return `No camera or microphone found. Connect a device and retry. [${detail}]`;
  }
  if (errorName === "NotReadableError" || errorName === "TrackStartError" || errorName === "AbortError") {
    return `Camera is busy or already in use. Close other camera apps and retry. [${detail}]`;
  }
  if (errorName === "OverconstrainedError" || errorName === "ConstraintNotSatisfiedError") {
    return `Unsupported camera constraints. Try another camera or lower quality settings. [${detail}]`;
  }
  if (errorName === "TypeError") {
    return `Invalid media constraints or insecure context. Use HTTPS/localhost and valid device settings. [${detail}]`;
  }

  return `Media setup failed. [${detail}]`;
}

function createStatusBadge(text, colorClass) {
  const badge = document.createElement("span");
  badge.className = `rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${colorClass}`;
  badge.textContent = text;
  return badge;
}

function buildParticipantTile(id, displayName, isLocal = false) {
  let card = document.getElementById(`card-${id}`);
  if (card) return card;

  card = document.createElement("article");
  card.id = `card-${id}`;
  card.dataset.participantTile = "true";
  card.className = `relative overflow-hidden rounded-2xl border bg-slate-900/80 p-3 shadow-lg ${
    isLocal ? "border-cyan-300/70 ring-1 ring-cyan-300/50" : "border-white/10"
  }`;
  card.classList.add("video-card-clickable");
  card.tabIndex = 0;

  const mediaFrame = document.createElement("div");
  mediaFrame.className = "mediaFrame relative overflow-hidden rounded-xl bg-black/90";

  const video = document.createElement("video");
  video.id = `video-${id}`;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.controls = !isLocal;
  video.className = "h-full w-full object-cover";

  const loadingOverlay = document.createElement("div");
  loadingOverlay.id = `loading-${id}`;
  loadingOverlay.className = "absolute inset-0 flex items-center justify-center bg-slate-950/80 text-xs text-slate-200";
  loadingOverlay.textContent = "Loading video…";

  const placeholder = document.createElement("div");
  placeholder.id = `placeholder-${id}`;
  placeholder.className = "absolute inset-0 hidden items-center justify-center bg-slate-900/90 px-3 text-center text-xs text-slate-300";
  placeholder.textContent = "No camera yet";

  mediaFrame.append(video, loadingOverlay, placeholder);

  const footer = document.createElement("div");
  footer.className = "tileFooter mt-1 flex items-center justify-between gap-2";

  const name = document.createElement("p");
  name.id = `name-${id}`;
  name.className = "truncate text-sm font-medium text-slate-100";
  name.textContent = displayName || "Participant";

  const badges = document.createElement("div");
  badges.className = "flex items-center gap-1";
  badges.id = `badges-${id}`;
  badges.append(
    createStatusBadge("Mic on", "bg-emerald-500/20 text-emerald-200"),
    createStatusBadge("Live", "bg-cyan-500/20 text-cyan-200")
  );

  const tileControls = document.createElement("div");
  tileControls.className = "flex items-center gap-2";
  tileControls.append(badges);

  const videoToggleBtn = document.createElement("button");
  videoToggleBtn.id = `video-toggle-${id}`;
  videoToggleBtn.className = "secondary px-2 py-1 text-[10px]";
  videoToggleBtn.textContent = "Camera off";
  const canToggleLocal = isLocal && role === "camera";
  const canToggleRemote = !isLocal && role === "viewer";
  videoToggleBtn.disabled = !(canToggleLocal || canToggleRemote);
  videoToggleBtn.classList.toggle("opacity-50", videoToggleBtn.disabled);
  videoToggleBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (id === "local") {
      toggleCamera();
      return;
    }
    if (role === "viewer") {
      requestViewerCameraToggle(id);
    }
  });
  tileControls.append(videoToggleBtn);

  footer.append(name, tileControls);
  card.append(mediaFrame, footer);

  const handleCanPlay = () => {
    loadingOverlay.classList.add("hidden");
    placeholder.classList.add("hidden");
    video.removeEventListener("canplay", handleCanPlay);
  };

  video.addEventListener("canplay", handleCanPlay);
  card.addEventListener("click", () => setActiveCameraTile(id, { scrollIntoView: false }));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setActiveCameraTile(id, { scrollIntoView: false });
    }
  });
  remoteVideos.appendChild(card);
  if (!activeCameraTileId) {
    activeCameraTileId = id;
  }
  applyActiveCameraLayout();
  return card;
}

function setTileName(id, name) {
  const nameEl = document.getElementById(`name-${id}`);
  if (nameEl) nameEl.textContent = name;
}

function setTilePlaceholder(id, visible, message = "No camera yet") {
  const placeholder = document.getElementById(`placeholder-${id}`);
  if (!placeholder) return;
  placeholder.textContent = message;
  placeholder.classList.toggle("hidden", !visible);
  placeholder.classList.toggle("flex", visible);
}

function setTileLoading(id, visible, message = "Loading video…") {
  const loading = document.getElementById(`loading-${id}`);
  if (!loading) return;
  loading.textContent = message;
  loading.classList.toggle("hidden", !visible);
}

function setTileMediaBadges(id, micOn, camOn) {
  const badges = document.getElementById(`badges-${id}`);
  if (!badges) return;
  tileMediaStates.set(id, { micOn, camOn });
  badges.innerHTML = "";
  badges.append(
    createStatusBadge(micOn ? "Mic on" : "Mic off", micOn ? "bg-emerald-500/20 text-emerald-200" : "bg-rose-500/20 text-rose-200"),
    createStatusBadge(camOn ? "Live" : "Offline", camOn ? "bg-cyan-500/20 text-cyan-200" : "bg-amber-500/20 text-amber-200")
  );
}

function setTileVideoToggleButton(id, camOn) {
  const toggleBtn = document.getElementById(`video-toggle-${id}`);
  if (!toggleBtn) return;
  toggleBtn.textContent = camOn ? "Camera off" : "Camera on";
}

function requestViewerCameraToggle(id) {
  if (role !== "viewer" || !id || pendingRemoteVideoToggle.has(id)) return;

  const toggleBtn = document.getElementById(`video-toggle-${id}`);
  const currentlyEnabled = cameraVideoStates.get(id) !== false;
  const nextEnabled = !currentlyEnabled;

  pendingRemoteVideoToggle.add(id);
  if (toggleBtn) {
    toggleBtn.disabled = true;
    toggleBtn.classList.add("opacity-50");
  }

  cameraController.emit("viewer-camera-video-toggle", { targetCameraId: id, enabled: nextEnabled }, (response) => {
    pendingRemoteVideoToggle.delete(id);
    if (toggleBtn) {
      toggleBtn.disabled = false;
      toggleBtn.classList.remove("opacity-50");
    }

    if (!response?.ok) {
      const errorMessage = response?.error || "Could not change camera state.";
      setStatus(errorMessage);
      showToast(errorMessage, "error");
      return;
    }

    setStatus(`Requested ${cameraNames.get(id) || "camera"} ${nextEnabled ? "on" : "off"}.`);
  });
}

function clearPeersAndVideos() {
  peers.forEach((pc) => pc.close());
  peers.clear();
  cameraNames.clear();
  cameraVideoStates.clear();
  tileMediaStates.clear();
  motionWatchers.forEach(({ intervalId }) => clearInterval(intervalId));
  motionWatchers.clear();
  lastMotionLogAt.clear();
  localPeerTile = null;
  activeCameraTileId = "";
  remoteVideos.innerHTML = "";
  sessionTimeline.innerHTML = "";
  updateEmptyState();
}

function detectMotionOnVideo(id, videoEl) {
  if (motionWatchers.has(id)) return;

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;

  let previousFrame = null;
  const intervalId = setInterval(() => {
    if (!document.body.contains(videoEl) || videoEl.readyState < 2) return;

    const w = Math.min(videoEl.videoWidth || 0, 320);
    const h = Math.min(videoEl.videoHeight || 0, 180);
    if (!w || !h) return;

    canvas.width = w;
    canvas.height = h;
    context.drawImage(videoEl, 0, 0, w, h);
    const frame = context.getImageData(0, 0, w, h).data;

    if (!previousFrame) {
      previousFrame = new Uint8ClampedArray(frame);
      return;
    }

    let changed = 0;
    for (let i = 0; i < frame.length; i += 16) {
      const diff =
        Math.abs(frame[i] - previousFrame[i]) +
        Math.abs(frame[i + 1] - previousFrame[i + 1]) +
        Math.abs(frame[i + 2] - previousFrame[i + 2]);
      if (diff > 25) changed += 1;
    }

    previousFrame = new Uint8ClampedArray(frame);
    const motionDetected = changed > 60;
    const card = document.getElementById(`card-${id}`);
    if (!card) return;

    card.classList.toggle("ring-2", motionDetected);
    card.classList.toggle("ring-amber-300/80", motionDetected);

    if (!motionDetected) return;

    const now = Date.now();
    const lastLogged = lastMotionLogAt.get(id) || 0;
    if (now - lastLogged > 8000) {
      addTimelineEvent(`Motion detected on ${cameraNames.get(id) || "camera feed"}.`);
      lastMotionLogAt.set(id, now);
    }

    if (motionFollowEnabled) {
      layoutMode = "focus";
      applyLayout();
      setActiveCameraTile(id);
    }
  }, 900);

  motionWatchers.set(id, { intervalId });
}

function attachRemoteVideo(id, stream) {
  console.log("[WebRTC] Attaching remote stream", {
    id,
    streamId: stream.id,
    tracks: stream.getTracks().map((track) => `${track.kind}:${track.readyState}`)
  });
  const card = buildParticipantTile(id, cameraNames.get(id) || "Camera feed", false);
  const video = card.querySelector("video");
  if (!video) return;

  video.srcObject = stream;
  setTileLoading(id, true);
  setTilePlaceholder(id, false);

  const [videoTrack] = stream.getVideoTracks();
  const [audioTrack] = stream.getAudioTracks();
  const videoEnabled = cameraVideoStates.get(id) ?? (videoTrack ? videoTrack.enabled : false);
  setTileMediaBadges(id, audioTrack ? audioTrack.enabled : false, videoEnabled);
  setTileVideoToggleButton(id, videoEnabled);

  video.play().catch(() => {
    setTileLoading(id, false);
    setTilePlaceholder(id, true, "Tap retry if playback is blocked");
    setStatus("Remote stream received, but autoplay was blocked. Tap retry playback.");
  });

  if (!videoTrack || !videoEnabled) {
    setTileLoading(id, false);
    setTilePlaceholder(id, true, videoEnabled ? "No camera yet" : "Camera is off");
  }

  detectMotionOnVideo(id, video);
  updateEmptyState();
}

function mountLocalTile(stream, cameraLabel) {
  localPeerTile = buildParticipantTile("local", cameraLabel || "You (local)", true);
  const video = localPeerTile.querySelector("video");
  if (!video) return;

  video.muted = true;
  video.controls = false;
  video.srcObject = stream;
  setTileLoading("local", true);
  setTilePlaceholder("local", false);

  const [videoTrack] = stream.getVideoTracks();
  const [audioTrack] = stream.getAudioTracks();
  const videoEnabled = videoTrack ? videoTrack.enabled : false;
  setTileMediaBadges("local", audioTrack ? audioTrack.enabled : false, videoEnabled);
  setTileVideoToggleButton("local", videoEnabled);

  video.play().catch(() => {
    setTileLoading("local", false);
    setTilePlaceholder("local", true, "Preview unavailable");
    setStatus("Camera stream started, but preview autoplay was blocked. Tap the video to start playback.");
  });
  applyActiveCameraLayout();
}

function stopLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }

  const localCard = document.getElementById("card-local");
  if (localCard) localCard.remove();
  localPeerTile = null;
  applyLocalControlButtons();
}

function updateCameraSelectOptions(devices) {
  cameraSelectInput.innerHTML = "";
  devices.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `Camera ${index + 1}`;
    cameraSelectInput.appendChild(option);
  });

  if (!devices.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No camera devices found";
    cameraSelectInput.appendChild(option);
    cameraSelectInput.disabled = true;
    selectedCameraDeviceId = "";
    return;
  }

  cameraSelectInput.disabled = false;
  const hasSelection = devices.some((device) => device.deviceId === selectedCameraDeviceId);
  selectedCameraDeviceId = hasSelection ? selectedCameraDeviceId : devices[0].deviceId;
  cameraSelectInput.value = selectedCameraDeviceId;
}

async function refreshCameraDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    availableCameraDevices = devices.filter((device) => device.kind === "videoinput");
    console.log("[MediaDevices] devices", availableCameraDevices.map((device) => ({ deviceId: device.deviceId, label: device.label })));
    updateCameraSelectOptions(availableCameraDevices);
  } catch (error) {
    console.error("Failed to enumerate devices", error);
    setStatus(`Could not list camera devices: ${error?.name || "Error"}${error?.message ? ` - ${error.message}` : ""}`);
  }
}


function authorizeRoom(roomCode = "") {
  return new Promise((resolve, reject) => {
    socket.emit("authorize-room", { roomCode }, (response) => {
      if (!response || !response.ok) {
        reject(new Error(response?.error || "Access denied"));
        return;
      }
      resolve(response);
    });
  });
}

async function replacePeerTracks(stream) {
  const [nextVideoTrack] = stream.getVideoTracks();
  const [nextAudioTrack] = stream.getAudioTracks();

  peers.forEach((pc) => {
    const senders = pc.getSenders();
    const videoSender = senders.find((sender) => sender.track && sender.track.kind === "video");
    const audioSender = senders.find((sender) => sender.track && sender.track.kind === "audio");

    if (videoSender && nextVideoTrack) {
      videoSender.replaceTrack(nextVideoTrack);
    } else if (nextVideoTrack) {
      pc.addTrack(nextVideoTrack, stream);
    }

    if (audioSender && nextAudioTrack) {
      audioSender.replaceTrack(nextAudioTrack);
    } else if (nextAudioTrack) {
      pc.addTrack(nextAudioTrack, stream);
    }
  });
}

async function startSelectedCameraStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia is not supported in this browser/context.");
  }

  selectedCameraDeviceId = cameraDeviceId();
  console.log("[MediaDevices] selected deviceId", selectedCameraDeviceId || "default");
  try {
    const stream = await navigator.mediaDevices.getUserMedia(localMediaConstraints({ includeAudio: true }));
    console.log("[MediaDevices] stream started", {
      deviceId: selectedCameraDeviceId || "default",
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length
    });
    return stream;
  } catch (error) {
    console.error("[MediaDevices] getUserMedia failed", {
      name: error?.name,
      message: error?.message,
      constraint: error?.constraint,
      selectedCameraDeviceId
    });
    const recoverableDeviceError = selectedCameraDeviceId && (error?.name === "OverconstrainedError" || error?.name === "NotFoundError");
    if (!recoverableDeviceError) {
      console.warn("[MediaDevices] retrying with simpler constraints", {
        name: error?.name,
        message: error?.message
      });
      try {
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch {
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
    }

    console.warn("[MediaDevices] selected device failed, retrying default camera", {
      selectedCameraDeviceId,
      name: error?.name,
      message: error?.message
    });

    selectedCameraDeviceId = "";
    cameraSelectInput.value = "";
    try {
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
  }
}

async function switchCameraStream() {
  if (role !== "camera" || !localStream) return;

  const previousStream = localStream;
  const wasRecordingLocalStream = mediaRecorder && mediaRecorder.state === "recording" && recordingSourceLabel === "camera-local-stream";

  try {
    const nextStream = await startSelectedCameraStream();
    localStream = nextStream;
    mountLocalTile(localStream, cameraName() || "You (camera)");
    await replacePeerTracks(localStream);
    previousStream.getTracks().forEach((track) => track.stop());
    applyLocalControlButtons();
    addTimelineEvent("Camera source switched.");

    if (wasRecordingLocalStream) {
      stopRecording();
      setTimeout(() => startRecording(), 0);
    }
  } catch (error) {
    console.error("Failed to switch camera stream", error);
    setStatus("Could not switch camera device.");
    selectedCameraDeviceId = previousStream.getVideoTracks()[0]?.getSettings()?.deviceId || selectedCameraDeviceId;
    cameraSelectInput.value = selectedCameraDeviceId;
  }
}

function getViewerRecordableStream() {
  const prioritizedTileIds = [activeCameraTileId, ...Array.from(remoteVideos.querySelectorAll("[data-participant-tile]")).map((card) => card.id.replace("card-", ""))].filter(Boolean);
  const checked = new Set();

  for (const tileId of prioritizedTileIds) {
    if (checked.has(tileId)) continue;
    checked.add(tileId);

    const video = document.querySelector(`#card-${tileId} video`);
    const stream = video?.srcObject;
    if (!(stream instanceof MediaStream)) continue;
    if (stream.getVideoTracks().length > 0) {
      return { stream, tileId };
    }
  }

  return null;
}

function resolveRecordingTarget() {
  if (typeof MediaRecorder === "undefined") {
    return null;
  }

  if (role === "camera" && localStream) {
    return { stream: localStream, label: "camera-local-stream" };
  }

  if (role === "viewer") {
    const remoteTarget = getViewerRecordableStream();
    if (remoteTarget?.stream) {
      return {
        stream: remoteTarget.stream,
        label: `viewer-${remoteTarget.tileId || "remote-stream"}`
      };
    }
  }

  return null;
}

function buildRecordingMimeType() {
  const preferredTypes = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const type of preferredTypes) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function startRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") return;

  const target = resolveRecordingTarget();
  if (!target?.stream) {
    const message =
      typeof MediaRecorder === "undefined"
        ? "Recording is not supported in this browser."
        : "No stream available to record yet.";
    setStatus(message);
    showToast(message, "error");
    return;
  }

  recordingStream = target.stream;
  recordingSourceLabel = target.label;
  recordedChunks = [];

  const mimeType = buildRecordingMimeType();
  try {
    mediaRecorder = mimeType ? new MediaRecorder(recordingStream, { mimeType }) : new MediaRecorder(recordingStream);
  } catch (error) {
    console.error("Failed to start recorder", error);
    setStatus("Could not start recording in this browser.");
    mediaRecorder = null;
    recordingStream = null;
    recordingSourceLabel = "";
    applyRecordingButtons();
    return;
  }

  mediaRecorder.ondataavailable = (event) => {
    console.log("Recording chunk size:", event.data?.size || 0);
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = () => {
    const type = mediaRecorder?.mimeType || "video/webm";
    const blob = new Blob(recordedChunks, { type });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `camdeck-${recordingSourceLabel}-${timestamp}.webm`;
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(downloadUrl);

    console.log("Recording stopped", {
      source: recordingSourceLabel,
      chunks: recordedChunks.length,
      totalBytes: blob.size
    });
    setStatus(`Recording saved: ${fileName}`);
    showToast(`Recording saved: ${fileName}`, "success");
    addTimelineEvent(`Recording saved (${recordingSourceLabel}).`);

    mediaRecorder = null;
    recordingStream = null;
    recordingSourceLabel = "";
    recordedChunks = [];
    applyRecordingButtons();
  };

  mediaRecorder.start(1000);
  console.log("Recording started", { source: recordingSourceLabel, mimeType: mediaRecorder.mimeType });
  setStatus("Recording started.");
  applyRecordingButtons();
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  mediaRecorder.stop();
}

function leaveRoom({ disconnectSocket = false, resetRoomState = false, clearStoredSession = false, reason = "manual" } = {}) {
  stopRecording();
  if (socket.connected) {
    socket.emit("leave-room");
  }
  clearPeersAndVideos();
  stopLocalStream();
  localParticipantId = "";
  role = null;
  applyLiveControlsVisibility();
  updateLiveInfoChips();
  syncCameraSocketLifecycle();

  if (disconnectSocket && socket.connected) {
    socket.disconnect();
    console.log("[Signal] socket disconnected by client", { reason });
  }

  if (resetRoomState) {
    resetRoomContext();
  }

  if (clearStoredSession) {
    localStorage.removeItem("camdeck-session");
    console.log("[Signal] stored session cleared", { reason });
  }
}

function disconnectAndReturnToRoleScreen() {
  leaveRoom({ disconnectSocket: true, resetRoomState: true, clearStoredSession: true, reason: "disconnect_button" });
  showScreen(homeScreen);
  setStatus("Disconnected. Room state cleared. Reconnect to join again.");
}

async function connectRoom() {
  const enteredRoomCode = roomId();

  if (!validateRoomCodeInput(enteredRoomCode)) {
    alert("Enter room number (e.g. FRONTDOOR) or full room code (e.g. FRONTDOOR:k_xxx).");
    return;
  }

  try {
    setButtonBusy(connectRoomBtn, true, "Authorizing...");
    await ensureSocketConnected();
    const authorization = await authorizeRoom(enteredRoomCode);
    applyAuthorizedRoom(authorization, "connectRoom");
    roomIdInput.value = "";
    saveSession();
    showScreen(roleScreen);
    setStatus(
      authorization.created
        ? `Room ${currentRoomNumber} created. Share code: ${currentRoomCode}`
        : "Access granted. Choose camera or viewer."
    );
    showToast(authorization.created ? "Room created and connected." : "Connected successfully.", "success");
  } catch (error) {
    setStatus(error?.message || "Room authorization failed.");
    showToast(error?.message || "Room authorization failed.", "error");
  } finally {
    setButtonBusy(connectRoomBtn, false);
  }
}

function localMediaConstraints({ includeAudio = false } = {}) {
  const selectedDeviceId = cameraDeviceId();
  const videoConstraints = {
    ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
    frameRate: { ideal: 24, max: 30 },
    ...(!selectedDeviceId ? { facingMode: "user" } : {})
  };

  return {
    video: videoConstraints,
    audio: includeAudio
      ? {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      : false
  };
}

async function startCamera() {
  role = "camera";
  applyLiveControlsVisibility();
  updateLiveInfoChips();
  syncCameraSocketLifecycle();
  console.log("[WebRTC] startCamera() called", { roomId: currentRoomId });

  if (!currentRoomCode) {
    setStatus("Connect to a room first.");
    showScreen(homeScreen);
    return;
  }

  clearPeersAndVideos();

  try {
    setButtonBusy(startCameraBtn, true, "Starting...");
    await ensureSocketConnected();
    console.log("[WebRTC] Socket connected for camera");
    localStream = await startSelectedCameraStream();
    console.log("[WebRTC] Local stream ready (camera)", {
      audioTracks: localStream.getAudioTracks().length,
      videoTracks: localStream.getVideoTracks().length
    });
    await refreshCameraDevices();

    mountLocalTile(localStream, cameraName() || "You (camera)");
    // Enter /viewer before joining so camera socket listeners can initialize only on the live feed page.
    showScreen(liveScreen);
    await joinRoomWithRole("camera");
    console.log("[WebRTC] Camera joined room", { roomId: currentRoomId });

    saveSession("camera");
    setStatus("You are sharing this device as a camera.");
    showToast("Camera broadcast started.", "success");
    addTimelineEvent("Camera session started.");
    applyLocalControlButtons();
  } catch (err) {
    console.error("[WebRTC] Camera startup failed", { name: err?.name, message: err?.message, constraint: err?.constraint, err });
    const mediaErrorNames = new Set([
      "NotAllowedError",
      "SecurityError",
      "NotFoundError",
      "DevicesNotFoundError",
      "NotReadableError",
      "TrackStartError",
      "AbortError",
      "OverconstrainedError",
      "ConstraintNotSatisfiedError",
      "TypeError"
    ]);
    const message = mediaErrorNames.has(err?.name) ? getReadableMediaError(err) : err?.message || "Failed to start camera.";
    setStatus(message);
    showToast(message, "error", 3200);
    alert(message);
    role = null;
    applyLiveControlsVisibility();
    updateLiveInfoChips();
    syncCameraSocketLifecycle();
    stopLocalStream();
    showScreen(roleScreen);
  } finally {
    setButtonBusy(startCameraBtn, false);
  }
}

async function startViewer() {
  role = "viewer";
  applyLiveControlsVisibility();
  updateLiveInfoChips();
  syncCameraSocketLifecycle();
  console.log("[WebRTC] startViewer() called", { roomId: currentRoomId });

  if (!currentRoomCode) {
    setStatus("Connect to a room first.");
    showScreen(homeScreen);
    return;
  }

  clearPeersAndVideos();
  stopLocalStream();

  try {
    setButtonBusy(startViewerBtn, true, "Joining...");
    await ensureSocketConnected();
    console.log("[WebRTC] Socket connected for viewer");
    // Enter /viewer before joining so viewer-only camera events can be subscribed safely.
    showScreen(liveScreen);
    await joinRoomWithRole("viewer");
    console.log("[WebRTC] Viewer joined room", { roomId: currentRoomId });
    saveSession("viewer");
    setStatus("Viewing cameras in this room.");
    showToast("Viewer connected.", "success");
    addTimelineEvent("Viewer session started.");
    applyLocalControlButtons();
    updateEmptyState();
  } catch (err) {
    console.error("[WebRTC] Viewer startup failed", err);
    setStatus(err?.message || "Failed to connect. Please try again.");
    showToast(err?.message || "Viewer connection failed.", "error");
    role = null;
    applyLiveControlsVisibility();
    updateLiveInfoChips();
    syncCameraSocketLifecycle();
    showScreen(roleScreen);
  } finally {
    setButtonBusy(startViewerBtn, false);
  }
}

function makePeer(targetId, initiator) {
  console.log("[WebRTC] Creating peer", { targetId, initiator, role });
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log("[WebRTC] Sending ICE candidate", { targetId });
      cameraController.emit("signal", {
        target: targetId,
        data: { type: "candidate", candidate: event.candidate }
      });
    }
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    console.log("[WebRTC] ontrack", {
      targetId,
      streamId: stream?.id || null,
      trackKinds: stream ? stream.getTracks().map((track) => track.kind) : []
    });
    if (stream) attachRemoteVideo(targetId, stream);
  };

  if (role === "camera" && localStream) {
    console.log("[WebRTC] Adding local tracks", {
      targetId,
      tracks: localStream.getTracks().map((track) => `${track.kind}:${track.readyState}`)
    });
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  } else {
    // Viewer initiates without local tracks; add recvonly transceivers so offer includes media m-lines.
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    console.log("[WebRTC] Added recvonly transceivers", { targetId });
  }

  if (initiator) {
    console.log("[WebRTC] Creating offer", { targetId });
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        console.log("[WebRTC] Sending offer", { targetId });
        cameraController.emit("signal", {
          target: targetId,
          data: { type: "offer", sdp: pc.localDescription }
        });
      })
      .catch((err) => {
        console.error("Offer error:", err);
      });
  }

  peers.set(targetId, pc);
  return pc;
}

function toggleMute() {
  if (!localStream) return;
  const [audioTrack] = localStream.getAudioTracks();
  if (!audioTrack) {
    setStatus("No microphone track found for this camera.");
    return;
  }

  audioTrack.enabled = !audioTrack.enabled;
  setTileMediaBadges("local", audioTrack.enabled, localStream.getVideoTracks()[0]?.enabled ?? false);
  applyLocalControlButtons();
  setStatus(audioTrack.enabled ? "Microphone unmuted." : "Microphone muted.");
}

function toggleCamera() {
  if (!localStream) return;
  const [videoTrack] = localStream.getVideoTracks();
  if (!videoTrack) {
    setStatus("No camera track found.");
    return;
  }

  videoTrack.enabled = !videoTrack.enabled;
  if (localParticipantId) {
    cameraVideoStates.set(localParticipantId, videoTrack.enabled);
  }
  setTileMediaBadges("local", localStream.getAudioTracks()[0]?.enabled ?? false, videoTrack.enabled);
  setTileVideoToggleButton("local", videoTrack.enabled);
  setTilePlaceholder("local", !videoTrack.enabled, "Camera is off");
  applyLocalControlButtons();
  cameraController.emit("camera-video-state", { enabled: videoTrack.enabled });
  setStatus(videoTrack.enabled ? "Camera enabled." : "Camera disabled.");
}

function setupCameraController() {
  // Camera-related listeners are now attached/detached dynamically based on /viewer + live page state.
  cameraController = window.createCameraController({
    socket,
    canUseCameraSockets: isViewCameraFeedsPageActive,
    handlers: {
      onCameraVideoCommand: ({ enabled, requestedBy }) => {
        if (role !== "camera" || !localStream) return;

        const [videoTrack] = localStream.getVideoTracks();
        if (!videoTrack) return;

        const nextEnabled = enabled !== false;
        if (videoTrack.enabled === nextEnabled) return;

        videoTrack.enabled = nextEnabled;
        if (localParticipantId) {
          cameraVideoStates.set(localParticipantId, nextEnabled);
        }
        setTileMediaBadges("local", localStream.getAudioTracks()[0]?.enabled ?? false, nextEnabled);
        setTileVideoToggleButton("local", nextEnabled);
        setTilePlaceholder("local", !nextEnabled, "Camera is off");
        applyLocalControlButtons();
        cameraController.emit("camera-video-state", { enabled: nextEnabled });
        setStatus(`Camera ${nextEnabled ? "enabled" : "disabled"}${requestedBy ? ` by ${requestedBy}` : ""}.`);
      },
      onSessionAuthorized: ({ roomId, roomNumber, participantId, accessKey, roomCode }) => {
        if (!role) {
          console.warn("[Signal] Ignoring session-authorized with no active role", { roomId, participantId });
          return;
        }

        applyAuthorizedRoom({ roomId, roomNumber, accessKey, roomCode }, "session-authorized");
        localParticipantId = participantId || "";
      },
      onExistingCameras: (cameras) => {
        if (role !== "viewer") return;
        console.log("[WebRTC] existing-cameras", { count: cameras.length, cameras });

        cameras.forEach(({ id, name, videoEnabled }) => {
          cameraNames.set(id, name || "Camera feed");
          cameraVideoStates.set(id, videoEnabled !== false);
          addTimelineEvent(`${cameraNames.get(id)} available.`);
          if (!peers.has(id)) makePeer(id, true);
        });
      },
      onCameraJoined: ({ id, name, videoEnabled }) => {
        if (role !== "viewer") return;
        console.log("[WebRTC] camera-joined", { id, name });
        cameraNames.set(id, name || "Camera feed");
        cameraVideoStates.set(id, videoEnabled !== false);
        addTimelineEvent(`${cameraNames.get(id)} joined.`);

        if (!peers.has(id)) makePeer(id, true);
      },
      onSignal: async ({ from, data }) => {
        console.log("[WebRTC] signal received", { from, type: data?.type });
        let pc = peers.get(from);
        if (!pc) pc = makePeer(from, false);

        try {
          if (data.type === "offer") {
            console.log("[WebRTC] Processing offer", { from });
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            console.log("[WebRTC] Sending answer", { from });
            cameraController.emit("signal", {
              target: from,
              data: { type: "answer", sdp: pc.localDescription }
            });
          } else if (data.type === "answer") {
            console.log("[WebRTC] Processing answer", { from });
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          } else if (data.type === "candidate") {
            console.log("[WebRTC] Processing candidate", { from });
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          }
        } catch (err) {
          console.error("Signal error:", err);
        }
      },
      onCameraLeft: ({ id }) => {
        const pc = peers.get(id);
        if (pc) {
          pc.close();
          peers.delete(id);
        }

        cameraNames.delete(id);
        cameraVideoStates.delete(id);
        const watcher = motionWatchers.get(id);
        if (watcher) {
          clearInterval(watcher.intervalId);
          motionWatchers.delete(id);
        }

        lastMotionLogAt.delete(id);
        const card = document.getElementById(`card-${id}`);
        if (card) card.remove();
        if (activeCameraTileId === id) {
          activeCameraTileId = "";
        }
        applyActiveCameraLayout();
        addTimelineEvent("A camera disconnected.");
        updateEmptyState();
      },
      onCameraVideoState: ({ id, enabled }) => {
        const cameraEnabled = enabled !== false;
        cameraVideoStates.set(id, cameraEnabled);

        const cardId = id === localParticipantId && role === "camera" ? "local" : id;
        if (!document.getElementById(`card-${cardId}`)) return;

        const micOn = tileMediaStates.get(cardId)?.micOn ?? (cardId === "local" ? localStream?.getAudioTracks?.()[0]?.enabled ?? false : false);

        setTileMediaBadges(cardId, micOn, cameraEnabled);
        setTileVideoToggleButton(cardId, cameraEnabled);
        setTilePlaceholder(cardId, !cameraEnabled, "Camera is off");
        if (!cameraEnabled) {
          setTileLoading(cardId, false);
        }
        addTimelineEvent(`${cameraNames.get(id) || "Camera feed"} camera ${cameraEnabled ? "enabled" : "disabled"}.`);
      }
    }
  });

  syncCameraSocketLifecycle();
}

async function restoreSessionAfterReconnect() {
  if (!role || !currentRoomCode) return;

  clearPeersAndVideos();

  try {
    await joinRoomWithRole(role);
    if (role === "camera" && localStream) {
      mountLocalTile(localStream, cameraName() || "You (camera)");
      addTimelineEvent("Reconnected and resumed camera broadcast.");
    } else if (role === "viewer") {
      updateEmptyState();
      addTimelineEvent("Reconnected and reloading camera feeds.");
    }
    setStatus(role === "camera" ? "Camera reconnected." : "Viewer reconnected.");
  } catch (err) {
    console.error("Reconnect join failed:", err);
    setStatus("Reconnection failed. Please disconnect and reconnect.");
  }
}

socket.on("connect", () => {
  setConnectionBadge(true);
  if (role && currentRoomCode) {
    restoreSessionAfterReconnect();
  }
});

socket.on("disconnect", () => {
  setConnectionBadge(false);
  if (role) {
    setStatus("Connection lost. Reconnecting…");
    addTimelineEvent("Socket disconnected. Reconnecting…");
  }
});

socket.on("connect_error", (error) => {
  setConnectionBadge(false);
  setStatus(`Server connection failed: ${error?.message || "Unknown error"}`);
});

connectRoomBtn.addEventListener("click", connectRoom);
roomIdInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") connectRoom();
});

changeRoomBtn.addEventListener("click", () => {
  leaveRoom({ disconnectSocket: true, resetRoomState: true, clearStoredSession: true, reason: "change_room" });
  roomIdInput.value = "";
  if (cameraNameInput) cameraNameInput.value = "";
  showScreen(homeScreen);
  setStatus("");
});

cameraSelectInput.addEventListener("change", async () => {
  selectedCameraDeviceId = cameraSelectInput.value;
  console.log("[MediaDevices] selected deviceId", selectedCameraDeviceId || "default");
  if (role === "camera" && localStream) {
    await switchCameraStream();
  }
});

disconnectRoomBtn.addEventListener("click", disconnectAndReturnToRoleScreen);
retryPlaybackBtn.addEventListener("click", () => {
  document.querySelectorAll("video").forEach((video) => {
    video.play().catch(() => {});
  });
  setStatus("Retrying video playback.");
  showToast("Retrying video playback.");
});

startCameraBtn.addEventListener("click", startCamera);
startViewerBtn.addEventListener("click", startViewer);

toggleLayoutBtn.addEventListener("click", () => {
  layoutMode = layoutMode === "grid" ? "focus" : "grid";
  applyLayout();
});

toggleMotionFollowBtn.addEventListener("click", () => {
  motionFollowEnabled = !motionFollowEnabled;
  applyMotionFollowButton();
  addTimelineEvent(`Motion follow ${motionFollowEnabled ? "enabled" : "disabled"}.`);
});

toggleMuteBtn.addEventListener("click", toggleMute);
toggleCameraBtn.addEventListener("click", toggleCamera);
startRecordingBtn.addEventListener("click", startRecording);
stopRecordingBtn.addEventListener("click", stopRecording);

rejoinLastBtn.addEventListener("click", async () => {
  const previous = loadSession();
  if (!previous?.roomCode) {
    setStatus("No previous session found.");
    return;
  }

  currentRoomCode = normalizeRoomCode(previous.roomCode);
  currentRoomId = "";
  currentRoomNumber = "";
  currentAccessKey = "";
  updateLiveInfoChips();
  roomIdInput.value = "";
  if (cameraNameInput) cameraNameInput.value = previous.cameraName || "";

  try {
    setButtonBusy(rejoinLastBtn, true, "Rejoining...");
    await ensureSocketConnected();
    const authorization = await authorizeRoom(currentRoomCode);
    applyAuthorizedRoom(authorization, "rejoinLast");
    showScreen(roleScreen);
    setStatus("Last session loaded.");
    showToast("Last session restored.", "success");

    if (previous.role === "camera") {
      await startCamera();
    } else if (previous.role === "viewer") {
      await startViewer();
    }
  } catch (error) {
    setStatus(error?.message || "Could not restore previous session.");
    showToast(error?.message || "Could not restore previous session.", "error");
  } finally {
    setButtonBusy(rejoinLastBtn, false);
  }
});

window.addEventListener("popstate", () => {
  syncCameraSocketLifecycle();
});

setupCameraController();
showScreen(homeScreen);
applyLayout();
applyMotionFollowButton();
applyLocalControlButtons();
applyRecordingButtons();
applyLiveControlsVisibility();
updateLiveInfoChips();
setConnectionBadge(socket.connected);
refreshCameraDevices();

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", refreshCameraDevices);
}
