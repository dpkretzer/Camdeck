const socket = io();

const roomIdInput = document.getElementById("roomId");
const startCameraBtn = document.getElementById("startCamera");
const startViewerBtn = document.getElementById("startViewer");
const localVideo = document.getElementById("localVideo");
const remoteVideos = document.getElementById("remoteVideos");

let role = null;
let localStream = null;
const peers = new Map();

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

function roomId() {
  return roomIdInput.value.trim();
}

async function startCamera() {
  role = "camera";

  if (!roomId()) {
    alert("Enter a room code");
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });

    localVideo.srcObject = localStream;

    socket.emit("join-room", {
      roomId: roomId(),
      role: "camera"
    });
  } catch (err) {
    console.error(err);
    alert("Camera access denied or not working");
  }
}

function startViewer() {
  role = "viewer";
  remoteVideos.innerHTML = "";

  if (!roomId()) {
    alert("Enter a room code");
    return;
  }

  localVideo.style.display = "none";

  socket.emit("join-room", {
    roomId: roomId(),
    role: "viewer"
  });
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

  pc.onconnectionstatechange = () => {
    console.log("connection state:", targetId, pc.connectionState);
  };

  pc.oniceconnectionstatechange = () => {
    console.log("ice state:", targetId, pc.iceConnectionState);
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
    el.style.width = "100%";
    el.style.marginTop = "12px";
    remoteVideos.appendChild(el);
  }

  el.srcObject = stream;

  el.play().catch((err) => {
    console.log("play blocked:", err);
  });
}

socket.on("existing-cameras", (cameraIds) => {
  if (role !== "viewer") return;

  cameraIds.forEach(id => {
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

startCameraBtn.addEventListener("click", startCamera);
startViewerBtn.addEventListener("click", startViewer);