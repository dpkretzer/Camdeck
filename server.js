const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const { Server } = require('socket.io');

const publicDir = path.join(__dirname, 'public');

const ROLE = Object.freeze({
  CAMERA: 'camera',
  VIEWER: 'viewer'
});

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];

function getSecurityConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const allowedOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const normalizedAllowedOrigins = isProduction
    ? [...new Set(allowedOrigins)]
    : [...new Set([...allowedOrigins, ...DEFAULT_DEV_ORIGINS])];

  const appSecret = (env.SESSION_SECRET || env.APP_SECRET || '').trim();
  const roomCodeLength = parsePositiveInt(env.ROOM_CODE_LENGTH, 6, 4, 12);
  const accessKeyLength = parsePositiveInt(env.ACCESS_KEY_LENGTH, 32, 16, 64);
  const joinRateLimitWindowMs = parsePositiveInt(env.JOIN_RATE_LIMIT_WINDOW_MS, 60_000, 10_000, 300_000);
  const joinRateLimitMax = parsePositiveInt(env.JOIN_RATE_LIMIT_MAX, 20, 5, 1000);
  const accessKeyTtlMs = parsePositiveInt(env.ACCESS_KEY_TTL_MS, 0, 0, 86_400_000);

  if (isProduction) {
    if (!appSecret || appSecret.length < 24) {
      throw new Error('SESSION_SECRET or APP_SECRET must be set and at least 24 chars in production.');
    }
    if (normalizedAllowedOrigins.length === 0) {
      throw new Error('ALLOWED_ORIGINS is required in production.');
    }
  }

  return {
    isProduction,
    appSecret,
    allowedOrigins: normalizedAllowedOrigins,
    roomCodeLength,
    accessKeyLength,
    joinRateLimitWindowMs,
    joinRateLimitMax,
    accessKeyTtlMs,
    maxBodySize: '16kb'
  };
}

function parsePositiveInt(raw, fallback, min, max) {
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function securityHeadersMiddleware(config) {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
    if (config.isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "connect-src 'self' ws: wss:",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "media-src 'self' blob:"
    ].join('; ');
    res.setHeader('Content-Security-Policy', csp);
    next();
  };
}

function createHttpRateLimiter(windowMs, max) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const state = hits.get(key);
    if (!state || state.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    state.count += 1;
    if (state.count > max) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };
}

function createAllowedOriginChecker(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return (origin, callback) => {
    if (!origin || allowed.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin not allowed'));
  };
}

function createLogger() {
  return {
    info: (event, data = {}) => console.log(JSON.stringify({ level: 'info', event, ...data })),
    warn: (event, data = {}) => console.warn(JSON.stringify({ level: 'warn', event, ...data })),
    error: (event, data = {}) => console.error(JSON.stringify({ level: 'error', event, ...data }))
  };
}

function generateToken(byteLength = 18) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function createRoomNumber(length) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

function sanitizeName(value, fallback = 'Participant') {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return cleaned || fallback;
}

function maskSecret(value, keep = 4) {
  if (!value || typeof value !== 'string') return undefined;
  if (value.length <= keep) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.max(0, value.length - keep))}${value.slice(-keep)}`;
}

function normalizeRoomId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRoomCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function isValidRoomNumber(value) {
  return /^[A-Z0-9_-]{4,24}$/.test(value);
}

function normalizeAccessKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRole(value) {
  const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return role === ROLE.CAMERA || role === ROLE.VIEWER ? role : '';
}

function parseRoomCode(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) return { roomNumber: '', accessKey: '' };
  const [roomPart, accessPart] = value.split(':');
  return {
    roomNumber: (roomPart || '').trim().toUpperCase(),
    accessKey: normalizeAccessKey(accessPart || '')
  };
}

function validateHandshakeAuth(rawAuth) {
  if (!rawAuth || typeof rawAuth !== 'object') {
    return { ok: false, error: 'Invalid credentials' };
  }

  const normalized = {
    roomId: normalizeRoomId(rawAuth.roomId),
    roomCode: typeof rawAuth.roomCode === 'string' ? rawAuth.roomCode.trim() : '',
    accessKey: normalizeAccessKey(rawAuth.accessKey),
    role: normalizeRole(rawAuth.role),
    name: sanitizeName(rawAuth.name || '', 'Participant')
  };

  if (!normalized.role) return { ok: false, error: 'Invalid credentials' };
  if (normalized.roomId.length > 128 || normalized.roomCode.length > 256 || normalized.accessKey.length > 256) {
    return { ok: false, error: 'Invalid credentials' };
  }

  return { ok: true, data: normalized };
}
function createJoinThrottle(windowMs, maxAttempts) {
  const attemptsByKey = new Map();

  function getState(key, now = Date.now()) {
    const existing = attemptsByKey.get(key);
    if (!existing || existing.resetAt <= now) {
      const state = { attempts: 0, resetAt: now + windowMs, blockedUntil: 0 };
      attemptsByKey.set(key, state);
      return state;
    }
    return existing;
  }

  function registerFailure(key) {
    const now = Date.now();
    const state = getState(key, now);
    state.attempts += 1;
    if (state.attempts > maxAttempts) {
      const penaltyMs = Math.min(10_000, 500 * (state.attempts - maxAttempts));
      state.blockedUntil = now + penaltyMs;
    }
    return state;
  }

  function canAttempt(key) {
    const now = Date.now();
    const state = getState(key, now);
    return {
      allowed: state.blockedUntil <= now,
      retryAfterMs: Math.max(0, state.blockedUntil - now),
      remaining: Math.max(0, maxAttempts - state.attempts)
    };
  }

  function clear(key) {
    attemptsByKey.delete(key);
  }

  return { registerFailure, canAttempt, clear };
}

function createRoomSafetyAgent() {
  function summarizeRoom(room) {
    const cameraCount = room.cameras?.size || 0;
    const viewerCount = room.viewers?.size || 0;
    const memberCount = room.members?.size || 0;
    const recordingActive = room.recording?.active === true;
    const alerts = [];
    if (cameraCount === 0) alerts.push('No active cameras');
    if (recordingActive && cameraCount === 0) alerts.push('Recording is active without a camera');
    return {
      roomId: room.id,
      roomNumber: room.roomNumber,
      memberCount,
      cameraCount,
      viewerCount,
      recordingActive,
      status: alerts.length > 0 ? 'attention' : 'healthy',
      alerts
    };
  }

  function summarizeRooms(rooms) {
    return [...rooms.values()].map((room) => summarizeRoom(room));
  }

  return { summarizeRoom, summarizeRooms };
}

function createAppAndServer(config = getSecurityConfig()) {
  const logger = createLogger();
  const app = express();
  const server = http.createServer(app);
  const originChecker = createAllowedOriginChecker(config.allowedOrigins);

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(securityHeadersMiddleware(config));
  app.use(cors({ origin: originChecker, credentials: true }));
  app.use(express.json({ limit: config.maxBodySize, strict: true }));
  app.use(express.urlencoded({ extended: false, limit: config.maxBodySize }));

  const httpLimiter = createHttpRateLimiter(config.joinRateLimitWindowMs, Math.max(10, config.joinRateLimitMax));
  app.use(express.static(publicDir));

  app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(publicDir, 'favicon.ico'), (err) => {
      if (err) res.status(204).end();
    });
  });

  app.get('/', httpLimiter, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.get('/viewer', httpLimiter, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  const io = new Server(server, {
    cors: {
      origin: originChecker,
      credentials: true,
      methods: ['GET', 'POST']
    }
  });

  io.engine.on('connection_error', (err) => {
    console.error('Engine connection error:', err.message, err.code);
  });

  const rooms = new Map();
  const roomByAccessKey = new Map();
  const roomByNumber = new Map();
  const participantBySocketId = new Map();
  const joinThrottleByIp = createJoinThrottle(config.joinRateLimitWindowMs, config.joinRateLimitMax);
  const joinThrottleByRoom = createJoinThrottle(config.joinRateLimitWindowMs, Math.max(3, Math.floor(config.joinRateLimitMax / 2)));

  const roomSafetyAgent = createRoomSafetyAgent();

  app.get('/api/agent/rooms', (req, res) => {
    const roomSummaries = roomSafetyAgent.summarizeRooms(rooms);
    const healthyCount = roomSummaries.filter((room) => room.status === 'healthy').length;
    res.json({
      generatedAt: new Date().toISOString(),
      roomCount: roomSummaries.length,
      healthyCount,
      attentionCount: roomSummaries.length - healthyCount,
      rooms: roomSummaries
    });
  });

  function createRoom(requestedRoomNumber = '') {
    const roomId = `r_${generateToken(16)}`;
    let roomNumber = normalizeRoomCode(requestedRoomNumber);
    if (!isValidRoomNumber(roomNumber) || roomByNumber.has(roomNumber)) {
      roomNumber = createRoomNumber(config.roomCodeLength);
      while (roomByNumber.has(roomNumber)) {
        roomNumber = createRoomNumber(config.roomCodeLength);
      }
    }

    const accessKey = `k_${generateToken(Math.ceil(config.accessKeyLength / 1.4))}`;
    const room = {
      id: roomId,
      roomNumber,
      accessKey,
      accessKeyCreatedAt: Date.now(),
      accessKeyExpiresAt: config.accessKeyTtlMs > 0 ? Date.now() + config.accessKeyTtlMs : null,
      members: new Set(),
      cameras: new Set(),
      viewers: new Set(),
      recording: { active: false, startedBy: null, startedAt: null }
    };

    rooms.set(room.id, room);
    roomByNumber.set(room.roomNumber, room.id);
    roomByAccessKey.set(room.accessKey, room.id);
    return room;
  }

  function isAccessKeyValid(room, accessKey) {
    if (!room || !accessKey) return false;
    if (room.accessKey !== accessKey) return false;
    if (room.accessKeyExpiresAt && Date.now() > room.accessKeyExpiresAt) return false;
    return true;
  }

  function cleanupRoomIfEmpty(room) {
    if (!room || room.members.size > 0) return;
    rooms.delete(room.id);
    roomByNumber.delete(room.roomNumber);
    roomByAccessKey.delete(room.accessKey);
  }

  function roomCameraList(room) {
    return [...room.members]
      .map((socketId) => participantBySocketId.get(socketId))
      .filter((participant) => participant?.role === ROLE.CAMERA)
      .map((participant) => ({
        id: participant.participantId,
        name: participant.label,
        videoEnabled: participant.videoEnabled !== false
      }));
  }

  function viewerSocketIds(room) {
    return [...room.members].filter((socketId) => participantBySocketId.get(socketId)?.role === ROLE.VIEWER);
  }

  function emitToViewers(room, event, payload) {
    viewerSocketIds(room).forEach((socketId) => io.to(socketId).emit(event, payload));
  }

  function getParticipant(socket) {
    return participantBySocketId.get(socket.id) || null;
  }

  function requireSession(socket, { roles, callback }) {
    const participant = getParticipant(socket);
    if (!participant) {
      callback?.({ ok: false, error: 'Unauthorized' });
      return null;
    }

    const room = rooms.get(participant.roomId);
    if (!room || !room.members.has(socket.id)) {
      participantBySocketId.delete(socket.id);
      callback?.({ ok: false, error: 'Unauthorized' });
      return null;
    }

    if (roles && !roles.includes(participant.role)) {
      logger.warn('socket.role_denied', { socketId: socket.id, role: participant.role, expected: roles });
      callback?.({ ok: false, error: 'Forbidden' });
      return null;
    }

    return { participant, room };
  }

  function removeSocketFromRoom(socket, reason = 'leave') {
    const participant = participantBySocketId.get(socket.id);
    if (!participant) return;
    const room = rooms.get(participant.roomId);

    if (room) {
      room.members.delete(socket.id);
      room.cameras.delete(participant.participantId);
      room.viewers.delete(participant.participantId);
      if (participant.role === ROLE.CAMERA) {
        emitToViewers(room, 'camera-left', { id: participant.participantId });
      }
      socket.leave(room.id);
      cleanupRoomIfEmpty(room);
    }

    participantBySocketId.delete(socket.id);
    logger.info('socket.cleanup', { socketId: socket.id, participantId: participant.participantId, reason });
  }

  io.use((socket, next) => {
    const result = validateHandshakeAuth(socket.handshake.auth);
    if (!result.ok) {
      logger.warn('socket.handshake_rejected', { socketId: socket.id, ip: socket.handshake.address });
      next(new Error('Invalid credentials'));
      return;
    }
    socket.data.handshakeAuth = result.data;
    next();
  });

  io.on('connection', (socket) => {
    logger.info('socket.connected', { socketId: socket.id, ip: socket.handshake.address });

    socket.on('authorize-room', ({ roomCode } = {}, callback) => {
      const parsed = parseRoomCode(roomCode);
      const roomNumber = parsed.roomNumber;
      const accessKey = normalizeAccessKey(parsed.accessKey);
      const ipKey = socket.handshake.address || 'unknown';

      const ipCheck = joinThrottleByIp.canAttempt(ipKey);
      if (!ipCheck.allowed) {
        callback?.({ ok: false, error: 'Invalid credentials' });
        return;
      }

      if (!roomNumber && !accessKey) {
        callback?.({ ok: false, error: 'Please enter a random room code.' });
        return;
      }

      if (roomNumber && !isValidRoomNumber(roomNumber)) {
        callback?.({ ok: false, error: 'Room code must be 4-24 chars (A-Z, 0-9, _, -).' });
        return;
      }

      let roomIdByNumber = roomByNumber.get(roomNumber);
      let room = roomIdByNumber ? rooms.get(roomIdByNumber) : null;

      if (roomNumber && !accessKey && !room) {
        room = createRoom(roomNumber);
        socket.data.authorizedRoomId = room.id;
        callback?.({ ok: true, created: true, roomNumber: room.roomNumber, roomId: room.id, accessKey: room.accessKey, roomCode: `${room.roomNumber}:${room.accessKey}` });
        return;
      }

      if (roomNumber && !accessKey && room) {
        socket.data.authorizedRoomId = room.id;
        callback?.({ ok: true, created: false, roomNumber: room.roomNumber, roomId: room.id, accessKey: room.accessKey, roomCode: `${room.roomNumber}:${room.accessKey}` });
        return;
      }

      roomIdByNumber = roomByNumber.get(roomNumber);
      room = roomIdByNumber ? rooms.get(roomIdByNumber) : null;
      if (!room || !isAccessKeyValid(room, accessKey)) {
        joinThrottleByIp.registerFailure(ipKey);
        joinThrottleByRoom.registerFailure(roomNumber || 'unknown');
        logger.warn('socket.authorize_failed', { socketId: socket.id, ip: ipKey, roomNumber, accessKey: maskSecret(accessKey) });
        callback?.({ ok: false, error: 'Invalid credentials' });
        return;
      }

      socket.data.authorizedRoomId = room.id;
      joinThrottleByIp.clear(ipKey);
      joinThrottleByRoom.clear(room.roomNumber);
      callback?.({ ok: true, created: false, roomNumber: room.roomNumber, roomId: room.id, accessKey: room.accessKey, roomCode: `${room.roomNumber}:${room.accessKey}` });
    });

    socket.on('join-room', (payload, callback) => {
      try {
        console.log('join-room payload:', payload);
        if (!payload || typeof payload !== 'object') {
          callback?.({ ok: false, error: 'Invalid payload' });
          return;
        }

        const { role, name, label, videoEnabled } = payload;
        const normalizedRole = normalizeRole(role || socket.data.handshakeAuth?.role);
        const authRoomId = socket.data.authorizedRoomId;
        const ipKey = socket.handshake.address || 'unknown';

        const ipCheck = joinThrottleByIp.canAttempt(ipKey);
        if (!ipCheck.allowed) {
          callback?.({ ok: false, error: 'Invalid credentials' });
          return;
        }

        const room = rooms.get(authRoomId);
        if (!room) {
          joinThrottleByIp.registerFailure(ipKey);
          callback?.({ ok: false, error: 'Invalid credentials' });
          return;
        }

        const roomCheck = joinThrottleByRoom.canAttempt(room.roomNumber);
        if (!roomCheck.allowed) {
          callback?.({ ok: false, error: 'Invalid credentials' });
          return;
        }

        if (!normalizedRole) {
          joinThrottleByIp.registerFailure(ipKey);
          callback?.({ ok: false, error: 'Invalid credentials' });
          return;
        }

        removeSocketFromRoom(socket, 'rejoin');

        const participantId = `p_${generateToken(12)}`;
        const member = {
          socketId: socket.id,
          participantId,
          role: normalizedRole,
          roomId: room.id,
          label: sanitizeName(label || name, normalizedRole === ROLE.CAMERA ? 'Camera feed' : 'Viewer'),
          videoEnabled: normalizedRole === ROLE.CAMERA ? videoEnabled !== false : undefined
        };

        participantBySocketId.set(socket.id, member);
        room.members.add(socket.id);
        if (normalizedRole === ROLE.CAMERA) room.cameras.add(participantId);
        if (normalizedRole === ROLE.VIEWER) room.viewers.add(participantId);
        socket.join(room.id);
        joinThrottleByIp.clear(ipKey);

        socket.emit('session-authorized', {
          roomNumber: room.roomNumber,
          roomId: room.id,
          participantId,
          role: normalizedRole,
          accessKey: room.accessKey,
          roomCode: `${room.roomNumber}:${room.accessKey}`
        });

        if (normalizedRole === ROLE.VIEWER) {
          socket.emit('existing-cameras', roomCameraList(room));
        }

        if (normalizedRole === ROLE.CAMERA) {
          emitToViewers(room, 'camera-joined', {
            id: participantId,
            name: member.label,
            videoEnabled: member.videoEnabled !== false
          });
        }

        logger.info('socket.join_success', { socketId: socket.id, roomId: room.id, roomNumber: room.roomNumber, role: normalizedRole });
        callback?.({ ok: true, room: { id: room.id, roomNumber: room.roomNumber } });
      } catch (err) {
        console.error('join-room error:', err);
        callback?.({ ok: false, error: 'Server error' });
      }
    });

    socket.on('signal', ({ target, payload, data } = {}) => {
      const context = requireSession(socket, { roles: [ROLE.CAMERA, ROLE.VIEWER] });
      if (!context) return;
      const signalPayload = payload || data;
      if (!target || typeof target !== 'string' || !signalPayload) return;

      const recipientSocketId = [...context.room.members].find((socketId) => {
        const p = participantBySocketId.get(socketId);
        return p?.participantId === target;
      });

      if (!recipientSocketId) return;
      io.to(recipientSocketId).emit('signal', { from: context.participant.participantId, data: signalPayload });
    });

    socket.on('camera-video-state', ({ enabled } = {}, callback) => {
      const context = requireSession(socket, { roles: [ROLE.CAMERA], callback });
      if (!context) return;
      context.participant.videoEnabled = enabled !== false;
      emitToViewers(context.room, 'camera-video-state', { id: context.participant.participantId, enabled: context.participant.videoEnabled });
      callback?.({ ok: true });
    });

    socket.on('viewer-camera-video-toggle', ({ targetCameraId, enabled } = {}, callback) => {
      const context = requireSession(socket, { roles: [ROLE.VIEWER], callback });
      if (!context) return;
      if (typeof targetCameraId !== 'string' || targetCameraId.length > 64) {
        callback?.({ ok: false, error: 'Invalid request' });
        return;
      }

      const recipientSocketId = [...context.room.members].find((socketId) => {
        const p = participantBySocketId.get(socketId);
        return p?.participantId === targetCameraId && p.role === ROLE.CAMERA;
      });

      if (!recipientSocketId) {
        callback?.({ ok: false, error: 'Invalid request' });
        return;
      }

      io.to(recipientSocketId).emit('camera-video-command', {
        enabled: enabled !== false,
        requestedBy: context.participant.label
      });
      callback?.({ ok: true });
    });

    socket.on('recording-start', (payload = {}, callback) => {
      const context = requireSession(socket, { roles: [ROLE.CAMERA], callback });
      if (!context) return;
      context.room.recording = {
        active: true,
        startedBy: context.participant.participantId,
        startedAt: Date.now()
      };
      logger.info('recording.start', {
        roomId: context.room.id,
        roomNumber: context.room.roomNumber,
        participantId: context.participant.participantId,
        metadata: typeof payload?.metadata === 'string' ? sanitizeName(payload.metadata, '') : undefined
      });
      callback?.({ ok: true });
    });

    socket.on('recording-stop', (callback) => {
      const context = requireSession(socket, { roles: [ROLE.CAMERA], callback });
      if (!context) return;
      context.room.recording = { active: false, startedBy: null, startedAt: null };
      logger.info('recording.stop', {
        roomId: context.room.id,
        roomNumber: context.room.roomNumber,
        participantId: context.participant.participantId
      });
      callback?.({ ok: true });
    });

    socket.on('leave-room', () => removeSocketFromRoom(socket, 'leave-room'));
    socket.on('disconnect', () => {
      logger.info('socket.disconnected', { socketId: socket.id });
      removeSocketFromRoom(socket, 'disconnect');
      delete socket.data.authorizedRoomId;
    });
  });

  return { app, server, io, config };
}

if (require.main === module) {
  const config = getSecurityConfig();
  const { server } = createAppAndServer(config);
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log('Server running on port', port);
    console.log(`Server running on http://localhost:${port}`);
  });
}

module.exports = {
  createAppAndServer,
  getSecurityConfig,
  validateHandshakeAuth,
  parseRoomCode,
  sanitizeName,
  createJoinThrottle,
  createRoomSafetyAgent
};
