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

// quiet favicon 404s (served if file exists, otherwise no-content)
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(publicDir, 'favicon.ico'), (err) => {
    if (err) res.status(204).end();
  });
});

// make / load index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const rooms = new Map();
const roomByAccessKey = new Map();
const roomByNumber = new Map();
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

function normalizeRoomNumber(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function isValidRoomNumber(value) {
  return /^[A-Z0-9_-]{3,24}$/.test(value);
}

function sanitizeLabel(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return fallback;
  return collapsed.slice(0, 24);
}

function createRoom(roomNumber) {
  const roomId = buildRoomId();
  const accessKey = buildAccessKey();
  const room = {
    id: roomId,
    roomNumber,
    accessKey,
    members: new Set(),
    cameras: new Set(),
    viewers: new Set()
  };

  rooms.set(roomId, room);
  roomByAccessKey.set(accessKey, roomId);
  roomByNumber.set(roomNumber, roomId);
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
  roomByNumber.delete(room.roomNumber);
}

function parseRoomCode(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { roomNumber: '', accessKey: '' };

  const [roomPart, accessPart] = raw.split(':');
  if (accessPart) {
    return {
      roomNumber: normalizeRoomNumber(roomPart),
      accessKey: accessPart.trim()
    };
  }

  return {
    roomNumber: normalizeRoomNumber(raw),
    accessKey: ''
  };
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

  socket.on('authorize-room', ({ roomCode }, callback) => {
    const { roomNumber, accessKey } = parseRoomCode(roomCode);

    let room;
    let created = false;
    if (accessKey) {
      room = getRoomByAccessKey(accessKey);
      if (!room || room.roomNumber !== roomNumber) {
        if (typeof callback === 'function') {
          callback({ ok: false, error: 'Invalid room code.' });
        }
        return;
      }
    } else {
      if (!isValidRoomNumber(roomNumber)) {
        if (typeof callback === 'function') {
          callback({ ok: false, error: 'Room number must be 3-24 chars (A-Z, 0-9, _, -).' });
        }
        return;
      }

      const existingRoomId = roomByNumber.get(roomNumber);
      if (existingRoomId) {
        const room = rooms.get(existingRoomId);
        socket.data.authorizedRoomId = room.id;

        callback({
          ok: true,
          created: false,
          roomNumber: room.roomNumber,
          roomId: room.id,
          accessKey: room.accessKey,
          roomCode: `${room.roomNumber}:${room.accessKey}`
        });
        return;
      }

      room = createRoom(roomNumber);
      created = true;
    }

    console.log('[Signal] authorize-room resolved', {
      socketId: socket.id,
      roomNumber: room.roomNumber,
      roomId: room.id,
      created
    });

    socket.data.authorizedRoomId = room.id;

    if (typeof callback === 'function') {
      callback({
        ok: true,
        created,
        roomNumber: room.roomNumber,
        roomId: room.id,
        accessKey: room.accessKey,
        roomCode: `${room.roomNumber}:${room.accessKey}`
      });
    }
  });

  socket.on('join-room', ({ role, name, label, videoEnabled, roomId: requestedRoomId, accessKey, roomCode }, callback) => {
    const { roomNumber: parsedRoomNumber, accessKey: parsedAccessKey } = parseRoomCode(roomCode);
    const normalizedRequestedRoomId = typeof requestedRoomId === 'string' ? requestedRoomId.trim() : '';
    const normalizedRequestedRoomNumber = normalizeRoomNumber(normalizedRequestedRoomId);
    const normalizedAccessKey = typeof accessKey === 'string' ? accessKey.trim() : '';
    const providedAccessKey = normalizedAccessKey || parsedAccessKey;
    const authorizedRoomId = socket.data.authorizedRoomId;

    function rejectJoin(message) {
      if (typeof callback === 'function') {
        callback({ ok: false, error: message });
      }
    }

    console.log('[Signal] join-room request', {
      socketId: socket.id,
      authorizedRoomId,
      requestedRoomId: normalizedRequestedRoomId || undefined,
      requestedRoomNumber: parsedRoomNumber || normalizedRequestedRoomNumber || undefined,
      role,
      name,
      label,
      hasAccessKey: Boolean(providedAccessKey),
      hasRoomCode: Boolean(roomCode)
    });

    let room = null;
    let resolvedBy = 'none';
    let conflictReason = null;

    if (authorizedRoomId) {
      room = rooms.get(authorizedRoomId) || null;
      if (room) resolvedBy = 'authorizedRoomId';
    }

    if (!room && normalizedRequestedRoomId) {
      room = rooms.get(normalizedRequestedRoomId) || null;
      if (room) {
        resolvedBy = 'requestedRoomId';
      } else {
        const mappedRoomId = roomByNumber.get(normalizedRequestedRoomNumber);
        if (mappedRoomId) {
          room = rooms.get(mappedRoomId) || null;
          if (room) resolvedBy = 'requestedRoomNumber';
        }
      }
    }

    if (!room && parsedRoomNumber) {
      const mappedRoomId = roomByNumber.get(parsedRoomNumber);
      if (mappedRoomId) {
        room = rooms.get(mappedRoomId) || null;
        if (room) resolvedBy = 'roomCode.roomNumber';
      }
    }

    if (!room && providedAccessKey) {
      room = getRoomByAccessKey(providedAccessKey) || null;
      if (room) resolvedBy = 'accessKey';
    }

    if (room && normalizedRequestedRoomId) {
      const requestedLooksLikeRoomNumber = Boolean(normalizedRequestedRoomNumber);
      const requestedMatchesRoom = requestedLooksLikeRoomNumber
        ? room.roomNumber === normalizedRequestedRoomNumber
        : room.id === normalizedRequestedRoomId;
      if (!requestedMatchesRoom) {
        if (resolvedBy === 'authorizedRoomId') {
          console.log('[Signal] join-room ignored requestedRoomId mismatch due to prior authorization', {
            socketId: socket.id,
            authorizedRoomId,
            requestedRoomId: normalizedRequestedRoomId,
            resolvedRoomId: room.id,
            resolvedRoomNumber: room.roomNumber
          });
        } else {
          conflictReason = 'requested room does not match resolved room';
          room = null;
        }
      }
    }

    if (room && providedAccessKey && room.accessKey !== providedAccessKey) {
      conflictReason = 'access key does not match resolved room';
      room = null;
    }

    if (room && parsedRoomNumber && room.roomNumber !== parsedRoomNumber) {
      conflictReason = 'room code number does not match resolved room';
      room = null;
    }

    if (!room) {
      console.log('[Signal] join-room resolve failed', {
        socketId: socket.id,
        authorizedRoomId,
        requestedRoomId: normalizedRequestedRoomId || undefined,
        requestedRoomNumber: parsedRoomNumber || normalizedRequestedRoomNumber || undefined,
        hasAccessKey: Boolean(providedAccessKey),
        conflictReason: conflictReason || 'room not found'
      });
      rejectJoin('Room not found.');
      return;
    }

    if (roomByNumber.get(room.roomNumber) !== room.id) {
      roomByNumber.set(room.roomNumber, room.id);
      console.log('[Signal] join-room repaired roomByNumber mapping', {
        roomNumber: room.roomNumber,
        roomId: room.id
      });
    }

    if (role !== 'camera' && role !== 'viewer') {
      rejectJoin('Invalid role.');
      return;
    }

    removeSocketFromRoom();
    socket.data.authorizedRoomId = room.id;

    const participantId = buildParticipantId();
    const member = {
      socketId: socket.id,
      participantId,
      role,
      roomId: room.id,
      label: sanitizeLabel(label || name, role === 'camera' ? 'Camera feed' : 'Viewer'),
      videoEnabled: role === 'camera' ? videoEnabled !== false : undefined
    };

    participantBySocketId.set(socket.id, member);
    room.members.add(socket.id);
    if (role === 'camera') room.cameras.add(participantId);
    if (role === 'viewer') room.viewers.add(participantId);

    // Always join by persistent room.id so users resolving by roomId/roomNumber end up in the same room.
    socket.join(room.id);

    console.log('[Signal] join-room success', {
      socketId: socket.id,
      participantId,
      role,
      resolvedBy,
      roomId: room.id,
      roomNumber: room.roomNumber,
      members: room.members.size,
      cameras: room.cameras.size,
      viewers: room.viewers.size
    });

    socket.emit('session-authorized', {
      roomNumber: room.roomNumber,
      roomId: room.id,
      participantId,
      role,
      accessKey: room.accessKey,
      roomCode: `${room.roomNumber}:${room.accessKey}`
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
      callback({
        ok: true,
        room: {
          id: room.id,
          roomNumber: room.roomNumber,
          accessKey: room.accessKey
        }
      });
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
