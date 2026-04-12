const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateHandshakeAuth,
  parseRoomCode,
  sanitizeName,
  createJoinThrottle,
  getSecurityConfig,
  createRoomSafetyAgent
} = require('../server');

test('rejects missing handshake auth payload', () => {
  const result = validateHandshakeAuth(undefined);
  assert.equal(result.ok, false);
});

test('rejects malformed role in handshake', () => {
  const result = validateHandshakeAuth({ role: 'admin', roomId: '', roomCode: '', accessKey: '', name: 'x' });
  assert.equal(result.ok, false);
});

test('accepts valid handshake payload and sanitizes name', () => {
  const result = validateHandshakeAuth({ role: 'camera', roomId: ' r_1 ', roomCode: 'abc', accessKey: 'k_1', name: '<script>Cam</script>' });
  assert.equal(result.ok, true);
  assert.equal(result.data.role, 'camera');
  assert.ok(!result.data.name.includes('<'));
});

test('room code parser normalizes room number and access key', () => {
  const parsed = parseRoomCode('ab12:k_Secret');
  assert.equal(parsed.roomNumber, 'AB12');
  assert.equal(parsed.accessKey, 'k_Secret');
});

test('join throttle blocks after max attempts and can recover', async () => {
  const throttle = createJoinThrottle(50, 1);
  const key = 'ip:1';

  let check = throttle.canAttempt(key);
  assert.equal(check.allowed, true);

  throttle.registerFailure(key);
  throttle.registerFailure(key);
  check = throttle.canAttempt(key);
  assert.equal(check.allowed, false);

  await new Promise((resolve) => setTimeout(resolve, 600));
  check = throttle.canAttempt(key);
  assert.equal(check.allowed, true);
});

test('production config fails without secret', () => {
  assert.throws(() => getSecurityConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://app.example.com' }));
});

test('sanitizeName trims and strips dangerous chars', () => {
  assert.equal(sanitizeName('  <b>Cam   1</b>  ', 'x'), 'bCam 1/b');
});

test('room safety agent marks unhealthy room states', () => {
  const agent = createRoomSafetyAgent();
  const room = {
    id: 'r_1',
    roomNumber: 'ABCD',
    members: new Set(['a', 'b']),
    cameras: new Set(),
    viewers: new Set(['v_1', 'v_2']),
    recording: { active: false }
  };

  const summary = agent.summarizeRoom(room);
  assert.equal(summary.status, 'attention');
  assert.equal(summary.cameraCount, 0);
  assert.equal(summary.viewerCount, 2);
  assert.ok(summary.alerts.length > 0);
});
