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
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const emailEnabled = Boolean(SENDGRID_API_KEY && EMAIL_FROM);

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
  if (!smsEnabled) {
    throw new Error("SMS is not configured on the server.");
  }

  const normalizedTo = normalizePhone(to);
  if (!/^\+\d{10,15}$/.test(normalizedTo)) {
    throw new Error("Destination phone is invalid. Use country code (E.164).");
  }

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

  const payloadJson = await response.json();
  return {
    sid: payloadJson.sid || "",
    status: payloadJson.status || "queued"
  };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function sendMovementEmail(to, roomId, cameraName, occurredAtIso) {
  if (!emailEnabled) {
    throw new Error("Email is not configured on the server.");
  }

  const normalizedTo = normalizeEmail(to);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedTo)) {
    throw new Error("Destination email is invalid.");
  }

  const occurredAt = new Date(occurredAtIso).toLocaleString();
  const payload = {
    personalizations: [{ to: [{ email: normalizedTo }] }],
    from: { email: EMAIL_FROM },
    subject: `Camdeck movement alert for room ${roomId}`,
    content: [
      {
        type: "text/plain",
        value: `Movement detected in room ${roomId} on ${cameraName} at ${occurredAt}.`
      }
    ]
  };

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`SendGrid API ${response.status}: ${responseText}`);
  }

  return { status: "accepted" };
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
      const occurredAt = new Date(now).toISOString();
      io.to(viewerSocketId).emit("movement-alert", {
        cameraId: key,
        cameraName: cameraName || room.cameraNames.get(key) || "Camera feed",
        contact,
        at: occurredAt
      });

      if (type === "phone") {
        sendMovementSms(contact, roomId, cameraName || room.cameraNames.get(key) || "Camera feed")
          .then((result) => {
            io.to(viewerSocketId).emit("notification-delivery", {
              channel: "sms",
              status: "accepted",
              detail: `Provider status: ${result.status}${result.sid ? ` (sid: ${result.sid})` : ""}`
            });
          })
          .catch((err) => {
            console.error("Failed to send movement SMS:", err.message);
            io.to(viewerSocketId).emit("notification-delivery", {
              channel: "sms",
              status: "failed",
              error: err.message
            });
          });
      }

      if (type === "email") {
        sendMovementEmail(
          contact,
          roomId,
          cameraName || room.cameraNames.get(key) || "Camera feed",
          occurredAt
        )
          .then(() => {
            io.to(viewerSocketId).emit("notification-delivery", {
              channel: "email",
              status: "accepted",
              detail: "Accepted by email provider."
            });
          })
          .catch((err) => {
            console.error("Failed to send movement email:", err.message);
            io.to(viewerSocketId).emit("notification-delivery", {
              channel: "email",
              status: "failed",
              error: err.message
            });
          });
      }
    });
  });

  socket.on("send-test-alert", () => {
    const roomId = socket.data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    const occurredAt = new Date().toISOString();

    room.subscribers.forEach(({ contact, type }, viewerSocketId) => {
      io.to(viewerSocketId).emit("movement-alert", {
        cameraId: "test",
        cameraName: "Test alert",
        contact,
        at: occurredAt
      });

      if (type === "phone") {
        sendMovementSms(contact, roomId, "Test alert")
          .then((result) => {
            io.to(viewerSocketId).emit("notification-delivery", {
              channel: "sms",
              status: "accepted",
              detail: `Provider status: ${result.status}${result.sid ? ` (sid: ${result.sid})` : ""}`
            });
          })
          .catch((err) => {
            io.to(viewerSocketId).emit("notification-delivery", {
              channel: "sms",
              status: "failed",
              error: err.message
            });
          });
      }

      if (type === "email") {
        sendMovementEmail(contact, roomId, "Test alert", occurredAt)
          .then(() => {
            io.to(viewerSocketId).emit("notification-delivery", {
              channel: "email",
              status: "accepted",
              detail: "Accepted by email provider."
            });
          })
          .catch((err) => {
            io.to(viewerSocketId).emit("notification-delivery", {
              channel: "email",
              status: "failed",
              error: err.message
            });
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
