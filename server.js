const express = require('express');
const http = require('http');
const path = require('path');
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

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { cameras: new Set(), viewers: new Set() });
  }
  return rooms.get(roomId);
}

io.on('connection', (socket) => {
  function removeSocketFromRoom() {
    const roomId = socket.data.roomId;
    const role = socket.data.role;
    if (!roomId || !role || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if (role === 'camera') room.cameras.delete(socket.id);
    if (role === 'viewer') room.viewers.delete(socket.id);

    if (role === 'camera') {
      socket.to(roomId).emit('camera-left', { id: socket.id });
    }

    if (room.cameras.size === 0 && room.viewers.size === 0) {
      rooms.delete(roomId);
    }

    socket.leave(roomId);
    delete socket.data.roomId;
    delete socket.data.role;
    delete socket.data.label;
  }

  socket.on('join-room', ({ roomId, role, name, label }, callback) => {
    if (!roomId || !role) {
      if (typeof callback === 'function') {
        callback({ ok: false, error: 'Missing room or role.' });
      }
      return;
    }

    socket.data.roomId = roomId;
    socket.data.role = role;
    socket.data.label = label || name || (role === 'camera' ? 'Camera feed' : 'Viewer');

    const room = ensureRoom(roomId);
    if (role === 'camera') room.cameras.add(socket.id);
    if (role === 'viewer') room.viewers.add(socket.id);

    socket.join(roomId);

    if (role === 'viewer') {
      const cameras = [...room.cameras].map(id => {
        const s = io.sockets.sockets.get(id);
        return { id, label: s?.data?.label || 'Camera' };
      });
      socket.emit(
        'existing-cameras',
        cameras.map((camera) => ({ id: camera.id, name: camera.label }))
      );
    }

    if (role === 'camera') {
      socket.to(roomId).emit('camera-joined', {
        id: socket.id,
        name: socket.data.label
      });
    }

    if (typeof callback === 'function') {
      callback({ ok: true });
    }
  });

  socket.on('signal', ({ target, payload, data }) => {
    const signalPayload = payload || data;
    if (!target || !signalPayload) return;
    io.to(target).emit('signal', {
      from: socket.id,
      data: signalPayload
    });
  });

  socket.on('leave-room', removeSocketFromRoom);

  socket.on('disconnect', () => {
    removeSocketFromRoom();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
