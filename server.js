const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// serve root files
app.use(express.static(__dirname));

// make / load index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = new Map();

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { cameras: new Set(), viewers: new Set() });
  }
  return rooms.get(roomId);
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, role, label }) => {
    if (!roomId || !role) return;
    socket.data.roomId = roomId;
    socket.data.role = role;
    socket.data.label = label || (role === 'camera' ? 'Tablet Camera' : 'Viewer');

    const room = ensureRoom(roomId);
    if (role === 'camera') room.cameras.add(socket.id);
    if (role === 'viewer') room.viewers.add(socket.id);

    socket.join(roomId);

    if (role === 'viewer') {
      const cameras = [...room.cameras].map(id => {
        const s = io.sockets.sockets.get(id);
        return { id, label: s?.data?.label || 'Camera' };
      });
      socket.emit('camera-list', cameras);
    }

    if (role === 'camera') {
      socket.to(roomId).emit('camera-added', {
        id: socket.id,
        label: socket.data.label
      });
    }
  });

  socket.on('signal', ({ target, payload }) => {
    if (!target || !payload) return;
    io.to(target).emit('signal', {
      from: socket.id,
      payload
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const role = socket.data.role;
    if (!roomId || !role || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if (role === 'camera') room.cameras.delete(socket.id);
    if (role === 'viewer') room.viewers.delete(socket.id);

    socket.to(roomId).emit('peer-left', { id: socket.id, role });

    if (room.cameras.size === 0 && room.viewers.size === 0) {
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
