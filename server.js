const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const publicDir = path.join(__dirname, 'public');

// serve static assets from /public
app.use(express.static(publicDir));

// make / load index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const rooms = new Map();
const roomByAccessKey = new Map();
const participantBySocketId = new Map();

function generateId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function buildParticipantId() {
  return `p_${generateId(12)}`;
}

function buildRoomId() {
  return `r_${generateId(12)}`;
}

function buildAccessKey() {
  return `k_${generateId(18)}`;
}

function sanitizeLabel(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return fallback;
  return collapsed.slice(0, 24);
}

function createRoom() {
  const roomId = buildRoomId();
  const accessKey = buildAccessKey();
  const room = {
    id: roomId,
    accessKey,
    members: new Set(),
    cameras: new Set(),
    viewers: new Set()
  };

  rooms.set(roomId, room);
  roomByAccessKey.set(accessKey, roomId);
  return room;
}

function getRoomByAccessKey(accessKey) {
  if (typeof accessKey !== 'string') return null;
  const trimmed = accessKey.trim();
  if (!trimmed) return null;

  const roomId = roomByAccessKey.get(trimmed);
  if (!roomId) return null;
  return rooms.get(roomId) || null;
}

function roomCameraList(room) {
  return [...room.cameras]
    .map((participantId) => {
      const member = [...room.members]
        .map((socketId) => participantBySocketId.get(socketId))
        .find((candidate) => candidate?.participantId === participantId);

      if (!member) return null;
      return {
        id: member.participantId,
        name: member.label || 'Camera',
        videoEnabled: member.videoEnabled !== false
      };
    })
    .filter(Boolean);
}

function cleanupRoomIfEmpty(room) {
  if (room.members.size > 0) return;
  rooms.delete(room.id);
  roomByAccessKey.delete(room.accessKey);
}

io.on('connection', (socket) => {
  console.log('[Signal] socket connected', { socketId: socket.id });

  function removeSocketFromRoom() {
    const participant = participantBySocketId.get(socket.id);
    if (!participant) return;

    const room = rooms.get(participant.roomId);
    if (!room) {
      participantBySocketId.delete(socket.id);
      delete socket.data.authorizedRoomId;
      return;
    }

    room.members.delete(socket.id);
    room.cameras.delete(participant.participantId);
    room.viewers.delete(participant.participantId);

    if (participant.role === 'camera') {
      console.log('[Signal] camera-left broadcast', { roomId: room.id, participantId: participant.participantId });
      socket.to(room.id).emit('camera-left', { id: participant.participantId });
    }

    socket.leave(room.id);
    participantBySocketId.delete(socket.id);

    if (socket.data.authorizedRoomId === room.id) {
      delete socket.data.authorizedRoomId;
    }

    cleanupRoomIfEmpty(room);
  }

  socket.on('authorize-room', ({ accessKey }, callback) => {
    const normalizedKey = typeof accessKey === 'string' ? accessKey.trim() : '';

    let room;
    let created = false;
    if (normalizedKey) {
      room = getRoomByAccessKey(normalizedKey);
      if (!room) {
        if (typeof callback === 'function') {
          callback({ ok: false, error: 'Invalid access key.' });
        }
        return;
      }
    } else {
      room = createRoom();
      created = true;
    }

    socket.data.authorizedRoomId = room.id;

    if (typeof callback === 'function') {
      callback({
        ok: true,
        created,
        roomId: room.id,
        accessKey: room.accessKey
      });
    }
  });

  socket.on('join-room', ({ role, name, label, videoEnabled }, callback) => {
    const roomId = socket.data.authorizedRoomId;
    const room = roomId ? rooms.get(roomId) : null;

    console.log('[Signal] join-room request', {
      socketId: socket.id,
      roomId,
      role,
      name,
      label
    });

    if (!room) {
      if (typeof callback === 'function') {
        callback({ ok: false, error: 'Unauthorized room access.' });
      }
      return;
    }

    if (role !== 'camera' && role !== 'viewer') {
      if (typeof callback === 'function') {
        callback({ ok: false, error: 'Invalid role.' });
      }
      return;
    }

    removeSocketFromRoom();

    const participantId = buildParticipantId();
    const member = {
      socketId: socket.id,
      participantId,
      role,
      roomId,
      label: sanitizeLabel(label || name, role === 'camera' ? 'Camera feed' : 'Viewer'),
      videoEnabled: role === 'camera' ? videoEnabled !== false : undefined
    };

    participantBySocketId.set(socket.id, member);
    room.members.add(socket.id);
    if (role === 'camera') room.cameras.add(participantId);
    if (role === 'viewer') room.viewers.add(participantId);

    socket.join(room.id);

    socket.emit('session-authorized', {
      roomId: room.id,
      participantId,
      role,
      accessKey: room.accessKey
    });

    if (role === 'viewer') {
      socket.emit('existing-cameras', roomCameraList(room));
    }

    if (role === 'camera') {
      socket.to(room.id).emit('camera-joined', {
        id: participantId,
        name: member.label,
        videoEnabled: member.videoEnabled !== false
      });
    }

    if (typeof callback === 'function') {
      callback({ ok: true });
    }
  });

  socket.on('signal', ({ target, payload, data }) => {
    const signalPayload = payload || data;
    if (!target || !signalPayload) return;

    const sender = participantBySocketId.get(socket.id);
    if (!sender) return;

    const room = rooms.get(sender.roomId);
    if (!room) return;

    const recipientSocketId = [...room.members].find((socketId) => {
      const participant = participantBySocketId.get(socketId);
      return participant?.participantId === target;
    });

    if (!recipientSocketId) {
      console.log('[Signal] blocked signal to unknown target', { from: sender.participantId, target });
      return;
    }

    io.to(recipientSocketId).emit('signal', {
      from: sender.participantId,
      data: signalPayload
    });
  });

  socket.on('camera-video-state', ({ enabled }) => {
    const participant = participantBySocketId.get(socket.id);
    if (!participant || participant.role !== 'camera') return;

    const room = rooms.get(participant.roomId);
    if (!room) return;

    participant.videoEnabled = enabled !== false;

    io.to(room.id).emit('camera-video-state', {
      id: participant.participantId,
      enabled: participant.videoEnabled
    });
  });

  socket.on('leave-room', removeSocketFromRoom);

  socket.on('disconnect', () => {
    console.log('[Signal] socket disconnected', { socketId: socket.id });
    removeSocketFromRoom();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
