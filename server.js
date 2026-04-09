const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { cameras: new Set(), viewers: new Set() });
  }
  return rooms.get(roomId);
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, role }) => {
    if (!roomId || !role) return;

    socket.data.roomId = roomId;
    socket.data.role = role;
    socket.join(roomId);

    const room = getRoom(roomId);

    if (role === "camera") {
      room.cameras.add(socket.id);
      socket.to(roomId).emit("camera-joined", { id: socket.id });
    }

    if (role === "viewer") {
      room.viewers.add(socket.id);
      socket.emit("existing-cameras", [...room.cameras]);
    }
  });

  socket.on("signal", ({ target, data }) => {
    io.to(target).emit("signal", {
      from: socket.id,
      data
    });
  });

  socket.on("disconnect", () => {
    const { roomId, role } = socket.data || {};
    if (!roomId || !role || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);

    if (role === "camera") {
      room.cameras.delete(socket.id);
      socket.to(roomId).emit("camera-left", { id: socket.id });
    }

    if (role === "viewer") {
      room.viewers.delete(socket.id);
    }

    if (room.cameras.size === 0 && room.viewers.size === 0) {
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
