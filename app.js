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

const connectedRoomLabel = document.getElementById("connectedRoomLabel");
const liveRoomLabel = document.getElementById("liveRoomLabel");
const statusMessage = document.getElementById("statusMessage");
const connectionBadge = document.getElementById("connectionBadge");
const emptyState = document.getElementById("emptyState");

const startCameraBtn = document.getElementById("startCamera");
const startViewerBtn = document.getElementById("startViewer");
const localVideo = document.getElementById("localVideo");
const remoteVideos = document.getElementById("remoteVideos");

let currentRoomId = "";
let role = null;
let localStream = null;
let layoutMode = "grid";
const peers = new Map();
const cameraNames = new Map();

function normalizeRoomId(value) {
  return value.replace(/\D+/g, "");
}

function showScreen(screen) {
  [homeScreen, roleScreen, liveScreen].forEach((item) => {
    item.classList.toggle("active", item === screen);
  });
}

function setStatus(message) {
  statusMessage.textContent = message || "";
}

function setConnectionBadge(connected) {
  connectionBadge.textContent = connected ? "Server connection: online" : "Server connection: offline";
  connectionBadge.classList.toggle("online", connected);
  connectionBadge.classList.toggle("offline", !connected);
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
  remoteVideos.classList.toggle("grid", layoutMode === "grid");
  remoteVideos.classList.toggle("focus", layoutMode === "focus");
  toggleLayoutBtn.textContent = layoutMode === "grid" ? "Focus layout" : "Grid layout";
}

function updateEmptyState() {
  const show = role === "viewer" && remoteVideos.children.length === 0;
  emptyState.style.display = show ? "block" : "none";
}

function ensureSocketConnected() {
  if (socket.connected) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Could not connect to server"));
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

function clearPeersAndVideos() {
  peers.forEach((pc) => pc.close());
  peers.clear();
  cameraNames.clear();
  remoteVideos.innerHTML = "";
  updateEmptyState();
}

function stopLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
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
    alert("Enter a room number");
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

async function startCamera() {
  role = "camera";

  if (!currentRoomId) {
    setStatus("Connect to a room first.");
    showScreen(homeScreen);
    return;
  }

  clearPeersAndVideos();
  localVideo.style.display = "block";

  try {
    await ensureSocketConnected();

    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });

    localVideo.srcObject = localStream;

    await joinRoomWithRole("camera");
    saveSession("camera");

    showScreen(liveScreen);
    setStatus("You are sharing this device as a camera.");
  } catch (err) {
    console.error(err);
    alert("Could not join as camera. Check permissions and room number.");
    role = null;
    stopLocalStream();
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
  localVideo.style.display = "none";

  try {
    await ensureSocketConnected();
    await joinRoomWithRole("viewer");
    saveSession("viewer");
    showScreen(liveScreen);
    setStatus("Viewing cameras in this room.");
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

  if (role === "camera" && localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  if (role === "viewer") {
    pc.addTransceiver("video", { direction: "recvonly" });

    pc.ontrack = (event) => {
      attachRemoteVideo(targetId, event.streams[0]);
    };
  }

  peers.set(targetId, pc);

  if (initiator) {
    createOffer(targetId, pc);
  }

  return pc;
}

async function createOffer(targetId, pc) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit("signal", {
    target: targetId,
    data: { type: "offer", sdp: pc.localDescription }
  });
}

function attachRemoteVideo(id, stream) {
  let el = document.getElementById(`video-${id}`);
  let card = document.getElementById(`card-${id}`);

  if (!el || !card) {
    card = document.createElement("div");
    card.id = `card-${id}`;
    card.className = "videoCard";
    const cardHeader = document.createElement("div");
    cardHeader.className = "videoCardHeader";

    const name = document.createElement("p");
    name.className = "cameraName";
    name.id = `name-${id}`;
    name.textContent = cameraNames.get(id) || "Camera feed";

    const status = document.createElement("span");
    status.className = "feedStatus";
    status.id = `feed-status-${id}`;
    status.textContent = "Live";

    const fullScreenBtn = document.createElement("button");
    fullScreenBtn.className = "secondary";
    fullScreenBtn.textContent = "Fullscreen";
    fullScreenBtn.addEventListener("click", async () => {
      const video = document.getElementById(`video-${id}`);
      if (!video) return;
      if (video.requestFullscreen) {
        await video.requestFullscreen();
      }
    });

    cardHeader.append(name, status, fullScreenBtn);

    el = document.createElement("video");
    el.id = `video-${id}`;
    el.autoplay = true;
    el.playsInline = true;
    el.muted = true;
    el.controls = true;

    card.append(cardHeader, el);
    remoteVideos.appendChild(card);
  }

  el.srcObject = stream;
  el.play().catch((err) => {
    console.log("play blocked:", err);
  });
  updateEmptyState();
}

socket.on("existing-cameras", (cameras) => {
  if (role !== "viewer") return;

  cameras.forEach(({ id, name }) => {
    cameraNames.set(id, name || "Camera feed");
    if (!peers.has(id)) {
      makePeer(id, true);
    }
  });
});

socket.on("camera-joined", ({ id, name }) => {
  if (role !== "viewer") return;
  cameraNames.set(id, name || "Camera feed");

  if (!peers.has(id)) {
    makePeer(id, true);
  }
});

socket.on("signal", async ({ from, data }) => {
  let pc = peers.get(from);
  if (!pc) {
    pc = makePeer(from, false);
  }

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
  const card = document.getElementById(`card-${id}`);
  if (card) card.remove();
  updateEmptyState();
});

socket.on("connect", () => {
  setConnectionBadge(true);
});

socket.on("disconnect", () => {
  setConnectionBadge(false);
  if (role) {
    setStatus("Connection lost. Reconnecting…");
  }
});

connectRoomBtn.addEventListener("click", connectRoom);
roomIdInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    connectRoom();
  }
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
});

startCameraBtn.addEventListener("click", startCamera);
startViewerBtn.addEventListener("click", startViewer);

toggleLayoutBtn.addEventListener("click", () => {
  layoutMode = layoutMode === "grid" ? "focus" : "grid";
  applyLayout();
});

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

roomIdInput.addEventListener("input", () => {
  roomIdInput.value = normalizeRoomId(roomIdInput.value);
});

applyLayout();
setConnectionBadge(socket.connected);

const previous = loadSession();
if (previous?.roomId) {
  roomIdInput.value = normalizeRoomId(previous.roomId);
}
if (previous?.cameraName) {
  cameraNameInput.value = previous.cameraName;
}
