const socket = io();

const roomIdInput = document.getElementById('roomId');
const deviceLabelInput = document.getElementById('deviceLabel');
const startCameraBtn = document.getElementById('startCamera');
const startViewerBtn = document.getElementById('startViewer');
const localVideo = document.getElementById('localVideo');
const cameraPanel = document.getElementById('cameraPanel');
const viewerPanel = document.getElementById('viewerPanel');
const remoteGrid = document.getElementById('remoteGrid');
const cameraStatus = document.getElementById('cameraStatus');
const viewerStatus = document.getElementById('viewerStatus');
const toggleMuteBtn = document.getElementById('toggleMute');
const switchCamBtn = document.getElementById('switchCam');

let role = null;
let localStream = null;
let facingMode = 'environment';
let micEnabled = true;
const peers = new Map(); // peerId -> RTCPeerConnection
const remoteVideos = new Map(); // peerId -> HTMLVideoElement

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

function getRoomId() {
  return roomIdInput.value.trim();
}

function getDeviceLabel() {
  return deviceLabelInput.value.trim() || (role === 'camera' ? 'Tablet Camera' : 'Viewer');
}

async function startCamera() {
  role = 'camera';
  const roomId = getRoomId();
  if (!roomId) {
    alert('Enter a room code first.');
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode },
      audio: true
    });

    localVideo.srcObject = localStream;
    cameraPanel.classList.remove('hidden');
    viewerPanel.classList.add('hidden');
    cameraStatus.textContent = 'Live';

    socket.emit('join-room', {
      roomId,
      role,
      label: getDeviceLabel()
    });
  } catch (err) {
    console.error(err);
    alert('Camera access failed. Make sure camera permissions are allowed.');
  }
}

async function startViewer() {
  role = 'viewer';
  const roomId = getRoomId();
  if (!roomId) {
    alert('Enter a room code first.');
    return;
  }

  viewerPanel.classList.remove('hidden');
  cameraPanel.classList.add('hidden');
  viewerStatus.textContent = 'Looking for cameras…';

  socket.emit('join-room', {
    roomId,
    role,
    label: getDeviceLabel()
  });
}

function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', {
        target: peerId,
        payload: { type: 'candidate', candidate: event.candidate }
      });
    }
  };

  if (role === 'viewer') {
    pc.ontrack = (event) => attachRemoteStream(peerId, event.streams[0]);
  }

  if (role === 'camera' && localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  peers.set(peerId, pc);

  if (isInitiator) {
    negotiate(peerId, pc);
  }

  return pc;
}

async function negotiate(peerId, pc) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit('signal', {
    target: peerId,
    payload: { type: 'offer', sdp: pc.localDescription }
  });
}

function attachRemoteStream(peerId, stream) {
  let video = remoteVideos.get(peerId);

  if (!video) {
    const card = document.createElement('div');
    card.className = 'remote-card';
    card.dataset.peerId = peerId;

    const title = document.createElement('h3');
    title.textContent = `Camera ${peerId.slice(0, 5)}`;
    card.appendChild(title);

    video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    card.appendChild(video);

    remoteGrid.appendChild(card);
    remoteVideos.set(peerId, video);
  }

  video.srcObject = stream;
  viewerStatus.textContent = 'Watching live cameras';
}

function removeRemoteStream(peerId) {
  const card = document.querySelector(`[data-peer-id="${peerId}"]`);
  if (card) card.remove();

  const video = remoteVideos.get(peerId);
  if (video && video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
  }
  remoteVideos.delete(peerId);

  if (remoteVideos.size === 0) {
    viewerStatus.textContent = 'Waiting for cameras…';
  }
}

socket.on('camera-list', (cameras) => {
  if (role !== 'viewer') return;
  cameras.forEach(cam => {
    if (!peers.has(cam.id)) createPeerConnection(cam.id, true);
  });
});

socket.on('camera-added', (cam) => {
  if (role !== 'viewer') return;
  if (!peers.has(cam.id)) createPeerConnection(cam.id, true);
});

socket.on('signal', async ({ from, payload }) => {
  let pc = peers.get(from);
  if (!pc) pc = createPeerConnection(from, false);

  try {
    if (payload.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('signal', {
        target: from,
        payload: { type: 'answer', sdp: pc.localDescription }
      });
    } else if (payload.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    } else if (payload.type === 'candidate') {
      await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
    }
  } catch (err) {
    console.error('Signal handling error:', err);
  }
});

socket.on('peer-left', ({ id, role: peerRole }) => {
  const pc = peers.get(id);
  if (pc) {
    pc.close();
    peers.delete(id);
  }
  if (peerRole === 'camera') removeRemoteStream(id);
});

toggleMuteBtn?.addEventListener('click', () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(track => (track.enabled = micEnabled));
  toggleMuteBtn.textContent = micEnabled ? 'Mute mic' : 'Unmute mic';
});

switchCamBtn?.addEventListener('click', async () => {
  if (!localStream || role !== 'camera') return;
  facingMode = facingMode === 'environment' ? 'user' : 'environment';

  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode },
      audio: true
    });

    const oldVideoTracks = localStream.getVideoTracks();
    oldVideoTracks.forEach(t => t.stop());

    const newVideoTrack = newStream.getVideoTracks()[0];
    const audioTrack = localStream.getAudioTracks()[0];

    const merged = new MediaStream([newVideoTrack, ...(audioTrack ? [audioTrack] : [])]);
    localStream = merged;
    localVideo.srcObject = localStream;

    peers.forEach((pc) => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(newVideoTrack);
    });
  } catch (err) {
    console.error(err);
    alert('Could not switch camera.');
  }
});

startCameraBtn.addEventListener('click', startCamera);
startViewerBtn.addEventListener('click', startViewer);