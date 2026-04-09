const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
const smsEnabled = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);

app.use(express.static(path.join(__dirname)));

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      cameras: new Set(),
      viewers: new Set(),
      cameraNames: new Map(),
      subscribers: new Map(),
      lastMovementAtByCamera: new Map()
    });
  }
  return rooms.get(roomId);
}

function normalizePhone(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) {
    return `+${trimmed.slice(1).replace(/\D+/g, "")}`;
  }
  return `+1${trimmed.replace(/\D+/g, "")}`;
}

async function sendMovementSms(to, roomId, cameraName) {
  if (!smsEnabled) return false;

  const normalizedTo = normalizePhone(to);
  if (!/^\+\d{10,15}$/.test(normalizedTo)) return false;

  const body = `Camdeck alert: movement detected in room ${roomId} on ${cameraName}.`;
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const payload = new URLSearchParams({
    To: normalizedTo,
    From: TWILIO_FROM_NUMBER,
    Body: body
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: payload
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Twilio API ${response.status}: ${responseText}`);
  }

  return true;
}

function removeSocketFromRoom(socket) {
  const { roomId, role } = socket.data || {};
  if (!roomId || !role || !rooms.has(roomId)) return;

  const room = rooms.get(roomId);

  if (role === "camera") {
    room.cameras.delete(socket.id);
    room.cameraNames.delete(socket.id);
    socket.to(roomId).emit("camera-left", { id: socket.id });
  }

  if (role === "viewer") {
    room.viewers.delete(socket.id);
    room.subscribers.delete(socket.id);
  }

  if (room.cameras.size === 0 && room.viewers.size === 0) {
    rooms.delete(roomId);
  }

  socket.leave(roomId);
  delete socket.data.roomId;
  delete socket.data.role;
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, role, name, notificationIdentity }, callback = () => {}) => {
    if (!roomId || !role) {
      callback({ ok: false, error: "Missing room or role" });
      return;
    }

    if (!["camera", "viewer"].includes(role)) {
      callback({ ok: false, error: "Invalid role" });
      return;
    }

    removeSocketFromRoom(socket);

    socket.data.roomId = roomId;
    socket.data.role = role;
    socket.join(roomId);

    const room = getRoom(roomId);

    if (role === "camera") {
      room.cameras.add(socket.id);
      const displayName = typeof name === "string" ? name.trim().slice(0, 24) : "";
      room.cameraNames.set(socket.id, displayName || `Camera ${room.cameras.size}`);
      socket.to(roomId).emit("camera-joined", {
        id: socket.id,
        name: room.cameraNames.get(socket.id)
      });
    }

    if (role === "viewer") {
      room.viewers.add(socket.id);
      if (notificationIdentity && notificationIdentity.value) {
        const contact = String(notificationIdentity.value).trim().slice(0, 128);
        const type = notificationIdentity.type === "phone" ? "phone" : "email";
        room.subscribers.set(socket.id, { type, contact });
      }
      socket.emit(
        "existing-cameras",
        [...room.cameras].map((id) => ({ id, name: room.cameraNames.get(id) || "Camera feed" }))
      );
    }

    callback({ ok: true });
  });

  socket.on("leave-room", () => {
    removeSocketFromRoom(socket);
  });

  socket.on("signal", ({ target, data }) => {
    io.to(target).emit("signal", {
      from: socket.id,
      data
    });
  });

  socket.on("motion-event", ({ cameraId, cameraName }) => {
    const roomId = socket.data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    const key = cameraId || socket.id;
    const now = Date.now();
    const last = room.lastMovementAtByCamera.get(key) || 0;
    if (now - last < 8000) return;
    room.lastMovementAtByCamera.set(key, now);

    room.subscribers.forEach(({ contact, type }, viewerSocketId) => {
      io.to(viewerSocketId).emit("movement-alert", {
        cameraId: key,
        cameraName: cameraName || room.cameraNames.get(key) || "Camera feed",
        contact,
        at: new Date(now).toISOString()
      });

      if (type === "phone") {
        sendMovementSms(contact, roomId, cameraName || room.cameraNames.get(key) || "Camera feed").catch((err) => {
          console.error("Failed to send movement SMS:", err.message);
        });
      }
    });
  });

  socket.on("disconnect", () => {
    removeSocketFromRoom(socket);
  });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`Server running on ${HOST}:${PORT}`);
});
