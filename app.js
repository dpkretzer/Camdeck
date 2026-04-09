const socket = io();

const homeScreen = document.getElementById("homeScreen");
const roleScreen = document.getElementById("roleScreen");
const liveScreen = document.getElementById("liveScreen");

const roomIdInput = document.getElementById("roomId");
const connectRoomBtn = document.getElementById("connectRoom");
const changeRoomBtn = document.getElementById("changeRoom");
const disconnectRoomBtn = document.getElementById("disconnectRoom");
const retryPlaybackBtn = document.getElementById("retryPlayback");

const connectedRoomLabel = document.getElementById("connectedRoomLabel");
const liveRoomLabel = document.getElementById("liveRoomLabel");
const statusMessage = document.getElementById("statusMessage");

const startCameraBtn = document.getElementById("startCamera");
const startViewerBtn = document.getElementById("startViewer");
const localVideo = document.getElementById("localVideo");
const remoteVideos = document.getElementById("remoteVideos");

let currentRoomId = "";
let role = null;
let localStream = null;
const peers = new Map();

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

function roomId() {
  return normalizeRoomId(roomIdInput.value.trim());
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
        role: roleName
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
  remoteVideos.innerHTML = "";
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
    showScreen(liveScreen);
    setStatus("Viewing cameras in this room.");
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

  if (!el) {
    el = document.createElement("video");
    el.id = `video-${id}`;
    el.autoplay = true;
    el.playsInline = true;
    el.muted = true;
    el.controls = true;
    remoteVideos.appendChild(el);
  }

  el.srcObject = stream;
  el.play().catch((err) => {
    console.log("play blocked:", err);
  });
}

socket.on("existing-cameras", (cameraIds) => {
  if (role !== "viewer") return;

  cameraIds.forEach((id) => {
    if (!peers.has(id)) {
      makePeer(id, true);
    }
  });
});

socket.on("camera-joined", ({ id }) => {
  if (role !== "viewer") return;

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

  const el = document.getElementById(`video-${id}`);
  if (el) el.remove();
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

roomIdInput.addEventListener("input", () => {
  roomIdInput.value = normalizeRoomId(roomIdInput.value);
});
