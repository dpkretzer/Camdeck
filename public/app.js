const socket = io();

const homeScreen = document.getElementById("homeScreen");
const roleScreen = document.getElementById("roleScreen");
const liveScreen = document.getElementById("liveScreen");

const roomIdInput = document.getElementById("roomId");
const cameraNameInput = document.getElementById("cameraName");
const connectRoomBtn = document.getElementById("connectRoom");
const changeRoomBtn = document.getElementById("changeRoom");
const disconnectRoomBtn = document.getElementById("disconnectRoom");
const retryPlaybackBtn = document.getElementById("retryPlayback");
const rejoinLastBtn = document.getElementById("rejoinLast");
const toggleLayoutBtn = document.getElementById("toggleLayout");
const toggleMotionFollowBtn = document.getElementById("toggleMotionFollow");
const toggleMuteBtn = document.getElementById("toggleMute");
const toggleCameraBtn = document.getElementById("toggleCamera");

const connectedRoomLabel = document.getElementById("connectedRoomLabel");
const liveRoomLabel = document.getElementById("liveRoomLabel");
const statusMessage = document.getElementById("statusMessage");
const connectionBadge = document.getElementById("connectionBadge");
const emptyState = document.getElementById("emptyState");
const sessionTimeline = document.getElementById("sessionTimeline");

const startCameraBtn = document.getElementById("startCamera");
const startViewerBtn = document.getElementById("startViewer");
const remoteVideos = document.getElementById("remoteVideos");

let currentRoomId = "";
let role = null;
let localStream = null;
let layoutMode = "grid";
let motionFollowEnabled = false;
let localPeerTile = null;
const peers = new Map();
const cameraNames = new Map();
const motionWatchers = new Map();
const lastMotionLogAt = new Map();

function normalizeRoomId(value) {
  return value.trim().toUpperCase();
}

function validateRoomId(nextRoomId) {
  return /^[A-Z0-9_-]{3,24}$/.test(nextRoomId);
}

function showScreen(screen) {
  [homeScreen, roleScreen, liveScreen].forEach((item) => {
    item.classList.toggle("active", item === screen);
    if (item === screen) {
      item.classList.remove("hidden");
    } else {
      item.classList.add("hidden");
    }
  });
}

function setStatus(message) {
  statusMessage.textContent = message || "";
}

window.addEventListener("error", (event) => {
  const detail = event?.message || "Unexpected app error.";
  setStatus(`App error: ${detail}`);
});

function setConnectionBadge(connected) {
  connectionBadge.textContent = connected ? "Server connection: online" : "Server connection: offline";
  connectionBadge.classList.toggle("text-emerald-300", connected);
  connectionBadge.classList.toggle("text-rose-300", !connected);
}

function roomId() {
  return normalizeRoomId(roomIdInput.value.trim());
}

function cameraName() {
  return cameraNameInput.value.trim().slice(0, 24);
}

function saveSession(nextRole = role) {
  if (!currentRoomId) return;
  localStorage.setItem(
    "camdeck-session",
    JSON.stringify({ roomId: currentRoomId, role: nextRole || null, cameraName: cameraName() })
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

function applyMotionFollowButton() {
  toggleMotionFollowBtn.textContent = `Motion follow: ${motionFollowEnabled ? "On" : "Off"}`;
}

function applyLocalControlButtons() {
  const controlsEnabled = role === "camera" && !!localStream;
  toggleMuteBtn.disabled = !controlsEnabled;
  toggleCameraBtn.disabled = !controlsEnabled;
  toggleMuteBtn.classList.toggle("opacity-50", !controlsEnabled);
  toggleCameraBtn.classList.toggle("opacity-50", !controlsEnabled);

  if (!localStream) {
    toggleMuteBtn.textContent = "Mute";
    toggleCameraBtn.textContent = "Camera off";
    return;
  }

  const [audioTrack] = localStream.getAudioTracks();
  const [videoTrack] = localStream.getVideoTracks();
  toggleMuteBtn.textContent = audioTrack && audioTrack.enabled ? "Mute" : "Unmute";
  toggleCameraBtn.textContent = videoTrack && videoTrack.enabled ? "Camera off" : "Camera on";
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

function joinRoomWithRole(roleName) {
  return new Promise((resolve, reject) => {
    socket.emit(
      "join-room",
      {
        roomId: currentRoomId,
        role: roleName,
        name: roleName === "camera" ? cameraName() : ""
      },
      (response) => {
        if (!response || !response.ok) {
          reject(new Error(response?.error || "Failed to join room"));
          return;
        }
        resolve();
      }
    );
  });
}

function getReadableMediaError(error) {
  if (!error?.name) return "Unable to access camera/microphone.";

  if (error.name === "NotAllowedError") {
    return "Permission denied. Please allow camera and microphone access in browser settings.";
  }
  if (error.name === "NotFoundError") {
    return "Camera or microphone not found. Please connect a device and retry.";
  }
  if (error.name === "NotReadableError") {
    return "Camera is busy or unavailable. Close other apps using the camera and retry.";
  }
  if (error.name === "OverconstrainedError") {
    return "Camera does not support requested quality. Try another camera device.";
  }

  return `Media error: ${error.name}`;
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

  const mediaFrame = document.createElement("div");
  mediaFrame.className = "relative aspect-video overflow-hidden rounded-xl bg-black/90";

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
  footer.className = "mt-2 flex items-center justify-between gap-2";

  const name = document.createElement("p");
  name.id = `name-${id}`;
  name.className = "truncate text-sm font-medium text-slate-100";
  name.textContent = displayName || "Participant";

  const badges = document.createElement("div");
  badges.className = "flex items-center gap-1";
  badges.id = `badges-${id}`;
  badges.append(
    createStatusBadge("Mic on", "bg-emerald-500/20 text-emerald-200"),
    createStatusBadge("Cam on", "bg-cyan-500/20 text-cyan-200")
  );

  footer.append(name, badges);
  card.append(mediaFrame, footer);

  const handleCanPlay = () => {
    loadingOverlay.classList.add("hidden");
    placeholder.classList.add("hidden");
    video.removeEventListener("canplay", handleCanPlay);
  };

  video.addEventListener("canplay", handleCanPlay);
  remoteVideos.appendChild(card);
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
  badges.innerHTML = "";
  badges.append(
    createStatusBadge(micOn ? "Mic on" : "Mic off", micOn ? "bg-emerald-500/20 text-emerald-200" : "bg-rose-500/20 text-rose-200"),
    createStatusBadge(camOn ? "Cam on" : "Cam off", camOn ? "bg-cyan-500/20 text-cyan-200" : "bg-amber-500/20 text-amber-200")
  );
}

function clearPeersAndVideos() {
  peers.forEach((pc) => pc.close());
  peers.clear();
  cameraNames.clear();
  motionWatchers.forEach(({ intervalId }) => clearInterval(intervalId));
  motionWatchers.clear();
  lastMotionLogAt.clear();
  localPeerTile = null;
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
      remoteVideos.prepend(card);
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, 900);

  motionWatchers.set(id, { intervalId });
}

function attachRemoteVideo(id, stream) {
  const card = buildParticipantTile(id, cameraNames.get(id) || "Camera feed", false);
  const video = card.querySelector("video");
  if (!video) return;

  video.srcObject = stream;
  setTileLoading(id, true);
  setTilePlaceholder(id, false);

  const [videoTrack] = stream.getVideoTracks();
  const [audioTrack] = stream.getAudioTracks();
  setTileMediaBadges(id, audioTrack ? audioTrack.enabled : false, videoTrack ? videoTrack.enabled : false);

  video.play().catch(() => {
    setTileLoading(id, false);
    setTilePlaceholder(id, true, "Tap retry if playback is blocked");
  });

  if (!videoTrack) {
    setTileLoading(id, false);
    setTilePlaceholder(id, true, "No camera yet");
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
  setTileMediaBadges("local", audioTrack ? audioTrack.enabled : false, videoTrack ? videoTrack.enabled : false);

  video.play().catch(() => {
    setTileLoading("local", false);
    setTilePlaceholder("local", true, "Preview unavailable");
  });
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

function leaveRoom() {
  socket.emit("leave-room");
  clearPeersAndVideos();
  stopLocalStream();
  role = null;
}

function disconnectAndReturnToRoleScreen() {
  leaveRoom();
  showScreen(roleScreen);
  setStatus("Disconnected from the room.");
}

function connectRoom() {
  const enteredRoom = roomId();

  if (!enteredRoom) {
    alert("Enter your room key.");
    return;
  }

  if (!validateRoomId(enteredRoom)) {
    alert("Room key must be 3-24 characters (letters, numbers, - or _)."
    );
    return;
  }

  currentRoomId = enteredRoom;
  roomIdInput.value = currentRoomId;
  connectedRoomLabel.textContent = `Connected to room: ${currentRoomId}`;
  liveRoomLabel.textContent = `Room: ${currentRoomId}`;
  setStatus("Room number accepted. Choose camera or viewer.");
  saveSession();
  showScreen(roleScreen);
}

function localMediaConstraints() {
  return {
    video: {
      width: { ideal: 1280, max: 1920 },
      height: { ideal: 720, max: 1080 },
      frameRate: { ideal: 24, max: 30 },
      facingMode: "user"
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  };
}

async function startCamera() {
  role = "camera";

  if (!currentRoomId) {
    setStatus("Connect to a room first.");
    showScreen(homeScreen);
    return;
  }

  clearPeersAndVideos();

  try {
    await ensureSocketConnected();
    localStream = await navigator.mediaDevices.getUserMedia(localMediaConstraints());

    mountLocalTile(localStream, cameraName() || "You (camera)");
    await joinRoomWithRole("camera");

    saveSession("camera");
    showScreen(liveScreen);
    setStatus("You are sharing this device as a camera.");
    addTimelineEvent("Camera session started.");
    applyLocalControlButtons();
  } catch (err) {
    console.error(err);
    const message = getReadableMediaError(err);
    setStatus(message);
    alert(message);
    role = null;
    stopLocalStream();
    showScreen(roleScreen);
  }
}

async function startViewer() {
  role = "viewer";

  if (!currentRoomId) {
    setStatus("Connect to a room first.");
    showScreen(homeScreen);
    return;
  }

  clearPeersAndVideos();
  stopLocalStream();

  try {
    await ensureSocketConnected();
    await joinRoomWithRole("viewer");
    saveSession("viewer");
    showScreen(liveScreen);
    setStatus("Viewing cameras in this room.");
    addTimelineEvent("Viewer session started.");
    applyLocalControlButtons();
    updateEmptyState();
  } catch (err) {
    console.error(err);
    setStatus("Failed to connect. Please try again.");
    role = null;
    showScreen(roleScreen);
  }
}

function makePeer(targetId, initiator) {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signal", {
        target: targetId,
        data: { type: "candidate", candidate: event.candidate }
      });
    }
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) attachRemoteVideo(targetId, stream);
  };

  if (role === "camera" && localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  if (initiator) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        socket.emit("signal", {
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
  setTileMediaBadges("local", localStream.getAudioTracks()[0]?.enabled ?? false, videoTrack.enabled);
  setTilePlaceholder("local", !videoTrack.enabled, "Camera is off");
  applyLocalControlButtons();
  setStatus(videoTrack.enabled ? "Camera enabled." : "Camera disabled.");
}

socket.on("existing-cameras", (cameras) => {
  if (role !== "viewer") return;

  cameras.forEach(({ id, name }) => {
    cameraNames.set(id, name || "Camera feed");
    addTimelineEvent(`${cameraNames.get(id)} available.`);
    if (!peers.has(id)) makePeer(id, true);
  });
});

socket.on("camera-joined", ({ id, name }) => {
  if (role !== "viewer") return;
  cameraNames.set(id, name || "Camera feed");
  addTimelineEvent(`${cameraNames.get(id)} joined.`);

  if (!peers.has(id)) makePeer(id, true);
});

socket.on("signal", async ({ from, data }) => {
  let pc = peers.get(from);
  if (!pc) pc = makePeer(from, false);

  try {
    if (data.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("signal", {
        target: from,
        data: { type: "answer", sdp: pc.localDescription }
      });
    } else if (data.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === "candidate") {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (err) {
    console.error("Signal error:", err);
  }
});

socket.on("camera-left", ({ id }) => {
  const pc = peers.get(id);
  if (pc) {
    pc.close();
    peers.delete(id);
  }

  cameraNames.delete(id);
  const watcher = motionWatchers.get(id);
  if (watcher) {
    clearInterval(watcher.intervalId);
    motionWatchers.delete(id);
  }

  lastMotionLogAt.delete(id);
  const card = document.getElementById(`card-${id}`);
  if (card) card.remove();
  addTimelineEvent("A camera disconnected.");
  updateEmptyState();
});

socket.on("connect", () => {
  setConnectionBadge(true);
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
  leaveRoom();
  currentRoomId = "";
  roomIdInput.value = "";
  cameraNameInput.value = "";
  localStorage.removeItem("camdeck-session");
  showScreen(homeScreen);
  setStatus("");
});

disconnectRoomBtn.addEventListener("click", disconnectAndReturnToRoleScreen);
retryPlaybackBtn.addEventListener("click", () => {
  document.querySelectorAll("video").forEach((video) => {
    video.play().catch(() => {});
  });
  setStatus("Retrying video playback.");
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

rejoinLastBtn.addEventListener("click", async () => {
  const previous = loadSession();
  if (!previous?.roomId) {
    setStatus("No previous session found.");
    return;
  }

  currentRoomId = normalizeRoomId(previous.roomId);
  roomIdInput.value = currentRoomId;
  cameraNameInput.value = previous.cameraName || "";
  connectedRoomLabel.textContent = `Connected to room: ${currentRoomId}`;
  liveRoomLabel.textContent = `Room: ${currentRoomId}`;
  showScreen(roleScreen);
  setStatus("Last session loaded.");

  if (previous.role === "camera") {
    await startCamera();
  } else if (previous.role === "viewer") {
    await startViewer();
  }
});

showScreen(homeScreen);
applyLayout();
applyMotionFollowButton();
applyLocalControlButtons();
setConnectionBadge(socket.connected);
