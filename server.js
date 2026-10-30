/**
 * Hot Rides Divas — Module 1 multiplayer server
 * ---------------------------------------------
 * Purpose: HTTP (Express) + legacy raw-WebSocket race relay (100% compatible with
 *          js/net.js) + socket.io /lobby namespace for matchmaking & lobbies.
 * Main functions:
 *   - Legacy WS: create/join rooms, lobby, raceStart/raceGo, state relay, finish,
 *     rematch, host migration, rate limits (same message types as prior index.js).
 *   - socket.io /lobby: findMatch, lobby player list (car/driver), host map pick,
 *     ready, 5s countdown, leave/disconnect cleanup, host migration, time:ping.
 *   - HTTP: GET /, GET /health, GET /live_config.json, POST /telemetry,
 *     POST /admin/maintenance (ADMIN_PASSWORD), CORS for GitHub Pages origin.
 *   - Ownership: GET /auth/nonce, POST /auth/login, GET /owned, GET /session/me,
 *     POST /purchase/claim (car|upgrade|pet), POST /purchase/equip — Solana-verified.
 * Connections: loaded by index.js; clients use wss://… (legacy) or /socket.io/
 *              (new lobbies). Tunables served to game clients without rebuild.
 * Env: PORT, ADMIN_PASSWORD (optional; maintenance disabled if unset).
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const ownership = require('./ownership');
const { Server: SocketIOServer } = require('socket.io');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 8080;
const PAGES_ORIGIN = 'https://crvr1.github.io';

/** Legacy WS (net.js) keeps max 7; socket.io lobbies allow up to 8. */
const LEGACY_MAX_PLAYERS = 7;
const IO_MAX_PLAYERS = 8;
const CODE_LEN = 5;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_IDLE_MS = 30 * 60 * 1000;
const STATE_MIN_MS = 45;
const MSG_MAX_BYTES = 4096;
const MSG_BURST = 40;
const RACE_LAPS = 3;
const LEGACY_COUNTDOWN_MS = 3500;
const IO_COUNTDOWN_MS = 5000;
const FIND_MATCH_MS = 10_000;
const TELEMETRY_MAX_BYTES = 4096;
const ADMIN_RATE_WINDOW_MS = 60_000;
const ADMIN_RATE_MAX = 10;
const IO_MSG_BURST = 40;

/** Soft speed sanity ceiling (m/s) — hook for later anti-cheat modules. */
const MAX_REASONABLE_SPEED = 95;

const ALLOWED_MAPS = Object.freeze([
  'miami-neon',
  'sunshine-speedway',
  'neon-kyoto',
  'black-eclipse',
  'volcanic-caldera',
  'random'
]);

const LIVE_CONFIG_DEFAULTS = Object.freeze({
  asphaltFriction: 1.0,
  n2oPower: 1.0,
  driftAssist: 1.0,
  aiAggression: 1.0,
  trackOfTheDay: 'miami-neon',
  styleMultiplier: 1.0,
  maxSpeedScale: 1.0
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function uid() {
  return crypto.randomBytes(6).toString('hex');
}

function now() {
  return Date.now();
}

function makeCode() {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) {
    code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  }
  return code;
}

function clampStr(s, max) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, max);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp01(v) {
  if (v == null) return 0;
  return Math.max(0, Math.min(1, v));
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still compare to keep timing flatter when lengths differ.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Server speed sanity hook — returns false if claimed speed is absurd.
 * Used by legacy state relay and ready for Module 5 anti-cheat.
 */
function speedSanityOk(speed) {
  if (speed == null) return true;
  const s = Number(speed);
  if (!Number.isFinite(s)) return false;
  if (s < 0) return false;
  return s <= MAX_REASONABLE_SPEED * 1.25;
}

// ---------------------------------------------------------------------------
// Live config + maintenance state
// ---------------------------------------------------------------------------
let maintenanceMode = false;
let liveConfig = { ...LIVE_CONFIG_DEFAULTS };

function getLiveConfigPublic() {
  return {
    asphaltFriction: clampNumber(liveConfig.asphaltFriction, 0.5, 1.5, 1),
    n2oPower: clampNumber(liveConfig.n2oPower, 0.5, 2.0, 1),
    driftAssist: clampNumber(liveConfig.driftAssist, 0, 2, 1),
    aiAggression: clampNumber(liveConfig.aiAggression, 0.25, 2, 1),
    trackOfTheDay: ALLOWED_MAPS.includes(liveConfig.trackOfTheDay)
      ? liveConfig.trackOfTheDay
      : 'miami-neon',
    styleMultiplier: clampNumber(liveConfig.styleMultiplier, 0.5, 3, 1),
    maxSpeedScale: clampNumber(liveConfig.maxSpeedScale, 0.5, 1.5, 1),
    maintenance: maintenanceMode,
    serverNow: now()
  };
}

// ---------------------------------------------------------------------------
// Rate-limit helpers (per key)
// ---------------------------------------------------------------------------
function createRateLimiter(windowMs, max) {
  /** @type {Map<string, { start:number, count:number }>} */
  const buckets = new Map();
  return function allow(key) {
    const t = now();
    let b = buckets.get(key);
    if (!b || t - b.start > windowMs) {
      b = { start: t, count: 0 };
      buckets.set(key, b);
    }
    b.count++;
    return b.count <= max;
  };
}

const adminRateOk = createRateLimiter(ADMIN_RATE_WINDOW_MS, ADMIN_RATE_MAX);
const telemetryRateOk = createRateLimiter(60_000, 20);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(
  cors({
    origin: [PAGES_ORIGIN, /\.github\.io$/, /^http:\/\/localhost(?::\d+)?$/],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Password']
  })
);
app.use(express.json({ limit: '8kb' }));

app.get(['/', '/health'], (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'hot-rides-divas-server',
    version: '1.1.0',
    module: 1,
    rooms: legacyRooms.size + ioRooms.size,
    legacyRooms: legacyRooms.size,
    ioRooms: ioRooms.size,
    clients: legacyClients.size,
    ioClients: io.engine ? io.engine.clientsCount : 0,
    maintenance: maintenanceMode,
    ownership: ownership.storageInfo(),
    ts: now()
  });
});

app.get('/live_config.json', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(getLiveConfigPublic());
});

app.post('/telemetry', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!telemetryRateOk(ip)) {
    res.status(429).json({ ok: false, error: 'rate_limited' });
    return;
  }
  const body = req.body;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'bad_body' });
    return;
  }
  const raw = JSON.stringify(body);
  if (raw.length > TELEMETRY_MAX_BYTES) {
    res.status(413).json({ ok: false, error: 'too_large' });
    return;
  }
  const report = {
    message: clampStr(String(body.message || ''), 500),
    file: clampStr(String(body.file || ''), 200),
    line: num(body.line),
    col: num(body.col),
    stack: clampStr(String(body.stack || ''), 1500),
    ua: clampStr(String(body.ua || body.userAgent || ''), 200),
    map: clampStr(String(body.map || ''), 64),
    ts: now()
  };
  console.log('[telemetry]', JSON.stringify(report));
  res.status(204).end();
});

app.post('/admin/maintenance', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!adminRateOk(ip)) {
    res.status(429).json({ ok: false, error: 'rate_limited' });
    return;
  }
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    res.status(503).json({
      ok: false,
      error: 'admin_disabled',
      message: 'ADMIN_PASSWORD is not set; maintenance endpoint disabled.'
    });
    return;
  }
  const provided =
    (req.headers['x-admin-password'] && String(req.headers['x-admin-password'])) ||
    (req.body && typeof req.body.password === 'string' && req.body.password) ||
    '';
  if (!timingSafeEqualStr(provided, expected)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  const active =
    req.body && typeof req.body.active === 'boolean'
      ? req.body.active
      : true;
  maintenanceMode = active;
  const flag = {
    type: 'maintenance',
    active: maintenanceMode,
    message: maintenanceMode
      ? 'Upgrading the race engines. Back in a few minutes with better circuits'
      : 'Maintenance ended — lobbies open again.',
    serverNow: now()
  };
  // Broadcast to legacy WS clients
  for (const client of legacyClients.values()) {
    sendLegacy(client.ws, flag);
  }
  // Broadcast to socket.io lobby namespace
  io.of('/lobby').emit('maintenance', flag);
  console.log('[admin] maintenanceMode=', maintenanceMode);
  res.status(200).json({ ok: true, maintenance: maintenanceMode });
});

// ---------------------------------------------------------------------------
// Wallet ownership / purchase verification (Phantom sign-in + on-chain SOL)
// Boss car 1 SOL, upgrades, pet_kitten 0.5 SOL → MERCHANT_WALLET
// ---------------------------------------------------------------------------
function bearerToken(req, body) {
  const h = req.headers && req.headers.authorization;
  if (typeof h === 'string' && /^Bearer\s+/i.test(h)) {
    return h.replace(/^Bearer\s+/i, '').trim();
  }
  if (body && typeof body.token === 'string') return body.token;
  return '';
}

app.get('/auth/nonce', (req, res) => {
  try {
    const wallet = clampStr(String(req.query.wallet || ''), 64);
    if (wallet.length < 32) {
      res.status(400).json({ error: 'wallet required' });
      return;
    }
    res.status(200).json(ownership.issueNonce(wallet));
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

app.post('/auth/login', (req, res) => {
  try {
    const body = req.body || {};
    const wallet = clampStr(String(body.wallet || ''), 64);
    if (!wallet || !body.signature || !body.message) {
      res.status(400).json({ error: 'wallet, signature, message required' });
      return;
    }
    res.status(200).json(ownership.login(wallet, body.signature, body.message));
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

app.get('/owned', (req, res) => {
  try {
    const wallet = clampStr(String(req.query.wallet || ''), 64);
    if (wallet.length < 32) {
      res.status(400).json({ error: 'wallet required' });
      return;
    }
    res.status(200).json(ownership.purchasesOf(wallet));
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

app.get('/session/me', (req, res) => {
  try {
    const wallet = ownership.verifySession(bearerToken(req));
    if (!wallet) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }
    res.status(200).json({ wallet, purchases: ownership.purchasesOf(wallet) });
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

app.post('/purchase/claim', async (req, res) => {
  try {
    const body = req.body || {};
    const wallet =
      ownership.verifySession(bearerToken(req, body)) ||
      clampStr(String(body.wallet || ''), 64);
    if (!wallet) {
      res.status(401).json({ error: 'login required' });
      return;
    }
    if (!body.signature) {
      res.status(400).json({ error: 'signature required' });
      return;
    }
    let purchases;
    if (body.kind === 'car') {
      purchases = await ownership.claimCar(wallet, body.id, body.signature);
    } else if (body.kind === 'upgrade') {
      purchases = await ownership.claimUpgrade(wallet, body.id, body.level, body.signature);
    } else if (body.kind === 'pet') {
      purchases = await ownership.claimPet(wallet, body.id, body.signature);
    } else {
      res.status(400).json({ error: 'kind must be car, upgrade, or pet' });
      return;
    }
    res.status(200).json({ ok: true, purchases });
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

app.post('/purchase/equip', (req, res) => {
  try {
    const body = req.body || {};
    const wallet =
      ownership.verifySession(bearerToken(req, body)) ||
      clampStr(String(body.wallet || ''), 64);
    if (!wallet) {
      res.status(401).json({ error: 'login required' });
      return;
    }
    const petId =
      body.petId == null || body.petId === ''
        ? null
        : clampStr(String(body.petId), 32);
    const purchases = ownership.setEquippedPet(wallet, petId);
    res.status(200).json({ ok: true, purchases });
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

// ---------------------------------------------------------------------------
// HTTP server + dual upgrade routing (legacy ws vs socket.io)
// ---------------------------------------------------------------------------
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  path: '/socket.io/',
  cors: {
    origin: [PAGES_ORIGIN, /\.github\.io$/, /^http:\/\/localhost(?::\d+)?$/],
    methods: ['GET', 'POST']
  },
  // We claim non-/socket.io/ upgrades for the legacy ws relay ourselves.
  destroyUpgrade: false,
  allowEIO3: false
});

/** Legacy WebSocket server — noServer so we can filter /socket.io/ upgrades. */
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '/').split('?')[0];
  // socket.io handles its own upgrades via Engine.IO attached to `server`.
  // Only hand non-/socket.io/ upgrades to the legacy ws relay.
  if (pathname.startsWith('/socket.io')) {
    // Engine.IO already listens on the same server for /socket.io/ — do nothing.
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ===========================================================================
// LEGACY WebSocket protocol (bit-for-bit compatible with prior index.js / net.js)
// ===========================================================================
/** @type {Map<string, object>} */
const legacyRooms = new Map();
/** @type {Map<import('ws').WebSocket, object>} */
const legacyClients = new Map();

function uniqueLegacyCode() {
  for (let i = 0; i < 40; i++) {
    const c = makeCode();
    if (!legacyRooms.has(c) && !ioRooms.has(c)) return c;
  }
  return makeCode() + CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
}

function sendLegacy(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (_) {}
}

function broadcastLegacy(room, obj, exceptId) {
  const raw = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (exceptId && p.id === exceptId) continue;
    if (p.ws && p.ws.readyState === 1) {
      try {
        p.ws.send(raw);
      } catch (_) {}
    }
  }
}

function lobbyPayload(room) {
  const players = [];
  for (const p of room.players.values()) {
    players.push({
      id: p.id,
      name: p.name,
      driverId: p.driverId,
      ready: !!p.ready,
      finished: !!p.finished
    });
  }
  return {
    type: 'lobby',
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    fillAI: room.fillAI,
    slots: room.slots,
    raceLaps: room.raceLaps,
    mapId: room.mapId || 'miami-neon',
    players,
    serverNow: now()
  };
}

function touchLegacy(room) {
  room.lastActive = now();
}

function ensureLegacyHost(room) {
  if (room.players.has(room.hostId)) return;
  const first = room.players.values().next().value;
  if (!first) return;
  room.hostId = first.id;
  broadcastLegacy(room, { type: 'hostChanged', hostId: room.hostId, serverNow: now() });
}

function destroyLegacyRoom(code) {
  legacyRooms.delete(code);
}

function leaveLegacyRoom(client, reason) {
  if (!client.roomCode) return;
  const room = legacyRooms.get(client.roomCode);
  client.roomCode = null;
  if (!room) return;
  room.players.delete(client.id);
  touchLegacy(room);
  if (room.players.size === 0) {
    destroyLegacyRoom(room.code);
    return;
  }
  ensureLegacyHost(room);
  broadcastLegacy(room, {
    type: 'playerLeft',
    id: client.id,
    reason: reason || 'left',
    hostId: room.hostId,
    serverNow: now()
  });
  broadcastLegacy(room, lobbyPayload(room));
  if (room.phase === 'racing') maybeEndLegacyRace(room);
}

function maybeEndLegacyRace(room) {
  const humans = [...room.players.values()];
  if (humans.length === 0) return;
  if (!humans.every((p) => p.finished)) return;
  finalizeLegacyResults(room);
}

function finalizeLegacyResults(room) {
  if (room.phase === 'results') return;
  room.phase = 'results';
  const ordered = [...room.players.values()]
    .filter((p) => p.finished && p.finishPlace != null)
    .sort((a, b) => a.finishPlace - b.finishPlace)
    .map((p) => ({
      id: p.id,
      name: p.name,
      driverId: p.driverId,
      place: p.finishPlace,
      time: p.finishTime
    }));
  let place = ordered.length + 1;
  for (const p of room.players.values()) {
    if (p.finished) continue;
    ordered.push({
      id: p.id,
      name: p.name,
      driverId: p.driverId,
      place: place++,
      time: null
    });
  }
  room.results = ordered;
  broadcastLegacy(room, { type: 'raceResults', results: ordered, serverNow: now() });
  broadcastLegacy(room, lobbyPayload(room));
}

function legacyRateOk(client) {
  const t = now();
  if (t - client.msgWindowStart > 1000) {
    client.msgWindowStart = t;
    client.msgWindowCount = 0;
  }
  client.msgWindowCount++;
  return client.msgWindowCount <= MSG_BURST;
}

function handleLegacyMessage(client, data) {
  if (!legacyRateOk(client)) {
    sendLegacy(client.ws, { type: 'error', message: 'Slow down — too many messages.' });
    return;
  }
  let msg;
  try {
    msg = JSON.parse(data);
  } catch (_) {
    sendLegacy(client.ws, { type: 'error', message: 'Invalid JSON.' });
    return;
  }
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    sendLegacy(client.ws, { type: 'error', message: 'Bad message.' });
    return;
  }

  switch (msg.type) {
    case 'ping':
      sendLegacy(client.ws, { type: 'pong', t: msg.t, serverNow: now() });
      break;
    case 'create':
      onLegacyCreate(client, msg);
      break;
    case 'join':
      onLegacyJoin(client, msg);
      break;
    case 'setName':
      onLegacySetName(client, msg);
      break;
    case 'setDriver':
      onLegacySetDriver(client, msg);
      break;
    case 'setReady':
      onLegacySetReady(client, msg);
      break;
    case 'setFillAI':
      onLegacySetFillAI(client, msg);
      break;
    case 'setSlots':
      onLegacySetSlots(client, msg);
      break;
    case 'setMap':
      onLegacySetMap(client, msg);
      break;
    case 'startRace':
      onLegacyStartRace(client);
      break;
    case 'state':
      onLegacyState(client, msg);
      break;
    case 'finish':
      onLegacyFinish(client, msg);
      break;
    case 'rematch':
      onLegacyRematch(client);
      break;
    case 'leave':
      leaveLegacyRoom(client, 'leave');
      sendLegacy(client.ws, { type: 'left', serverNow: now() });
      break;
    default:
      sendLegacy(client.ws, { type: 'error', message: 'Unknown type: ' + msg.type });
  }
}

function onLegacyCreate(client, msg) {
  if (maintenanceMode) {
    sendLegacy(client.ws, {
      type: 'error',
      message: 'Upgrading the race engines. Back in a few minutes with better circuits',
      maintenance: true
    });
    return;
  }
  leaveLegacyRoom(client, 'recreate');
  const code = uniqueLegacyCode();
  const name = clampStr(msg.name, 16) || 'Diva';
  const driverId = clampStr(msg.driverId, 16) || 'bitty';
  const room = {
    code,
    hostId: client.id,
    players: new Map(),
    phase: 'lobby',
    fillAI: true,
    slots: 4,
    raceLaps: RACE_LAPS,
    mapId: 'miami-neon',
    startAt: null,
    createdAt: now(),
    lastActive: now(),
    raceStartWall: 0,
    results: []
  };
  const player = {
    id: client.id,
    name,
    driverId,
    ready: false,
    finished: false,
    finishPlace: null,
    finishTime: null,
    ws: client.ws
  };
  room.players.set(client.id, player);
  legacyRooms.set(code, room);
  client.roomCode = code;
  sendLegacy(client.ws, {
    type: 'welcome',
    id: client.id,
    code,
    isHost: true,
    serverNow: now()
  });
  sendLegacy(client.ws, lobbyPayload(room));
}

function onLegacyJoin(client, msg) {
  if (maintenanceMode) {
    sendLegacy(client.ws, {
      type: 'error',
      message: 'Upgrading the race engines. Back in a few minutes with better circuits',
      maintenance: true
    });
    return;
  }
  const code = clampStr(msg.code, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const room = legacyRooms.get(code);
  if (!room) {
    sendLegacy(client.ws, { type: 'error', message: 'Room not found. Check the code.' });
    return;
  }
  if (room.phase !== 'lobby' && room.phase !== 'results') {
    sendLegacy(client.ws, { type: 'error', message: 'Race already in progress.' });
    return;
  }
  if (room.players.size >= LEGACY_MAX_PLAYERS) {
    sendLegacy(client.ws, {
      type: 'error',
      message: 'Room is full (max ' + LEGACY_MAX_PLAYERS + ').'
    });
    return;
  }
  leaveLegacyRoom(client, 'rejoin');
  const name = clampStr(msg.name, 16) || 'Diva';
  const driverId = clampStr(msg.driverId, 16) || 'bitty';
  const player = {
    id: client.id,
    name,
    driverId,
    ready: false,
    finished: false,
    finishPlace: null,
    finishTime: null,
    ws: client.ws
  };
  room.players.set(client.id, player);
  client.roomCode = code;
  if (room.phase === 'results') {
    room.phase = 'lobby';
    for (const p of room.players.values()) {
      p.ready = false;
      p.finished = false;
      p.finishPlace = null;
      p.finishTime = null;
    }
  }
  touchLegacy(room);
  sendLegacy(client.ws, {
    type: 'welcome',
    id: client.id,
    code,
    isHost: room.hostId === client.id,
    serverNow: now()
  });
  broadcastLegacy(room, lobbyPayload(room));
}

function roomOfLegacy(client) {
  if (!client.roomCode) return null;
  return legacyRooms.get(client.roomCode) || null;
}

function playerOfLegacy(client) {
  const room = roomOfLegacy(client);
  if (!room) return null;
  return room.players.get(client.id) || null;
}

function onLegacySetName(client, msg) {
  const room = roomOfLegacy(client);
  const p = playerOfLegacy(client);
  if (!room || !p) return;
  if (room.phase !== 'lobby') return;
  p.name = clampStr(msg.name, 16) || p.name;
  touchLegacy(room);
  broadcastLegacy(room, lobbyPayload(room));
}

function onLegacySetDriver(client, msg) {
  const room = roomOfLegacy(client);
  const p = playerOfLegacy(client);
  if (!room || !p) return;
  if (room.phase !== 'lobby') return;
  p.driverId = clampStr(msg.driverId, 16) || p.driverId;
  touchLegacy(room);
  broadcastLegacy(room, lobbyPayload(room));
}

function onLegacySetReady(client, msg) {
  const room = roomOfLegacy(client);
  const p = playerOfLegacy(client);
  if (!room || !p) return;
  if (room.phase !== 'lobby') return;
  p.ready = !!msg.ready;
  touchLegacy(room);
  broadcastLegacy(room, lobbyPayload(room));
}

function onLegacySetFillAI(client, msg) {
  const room = roomOfLegacy(client);
  if (!room || room.hostId !== client.id) return;
  if (room.phase !== 'lobby') return;
  room.fillAI = !!msg.fillAI;
  touchLegacy(room);
  broadcastLegacy(room, lobbyPayload(room));
}

function onLegacySetSlots(client, msg) {
  const room = roomOfLegacy(client);
  if (!room || room.hostId !== client.id) return;
  if (room.phase !== 'lobby') return;
  let n = Number(msg.slots);
  if (!Number.isFinite(n)) return;
  n = Math.max(2, Math.min(LEGACY_MAX_PLAYERS, Math.round(n)));
  room.slots = n;
  touchLegacy(room);
  broadcastLegacy(room, lobbyPayload(room));
}


function onLegacySetMap(client, msg) {
  const room = (typeof roomOfLegacy === 'function' ? roomOfLegacy(client) : roomOf(client));
  if (!room || room.hostId !== client.id) {
    (typeof sendLegacy === 'function' ? sendLegacy : send)(client.ws, { type: 'error', message: 'Only the host can pick the map.' });
    return;
  }
  if (room.phase !== 'lobby' && room.phase !== 'results') {
    (typeof sendLegacy === 'function' ? sendLegacy : send)(client.ws, { type: 'error', message: 'Cannot change map now.' });
    return;
  }
  const mapId = clampStr(msg.mapId, 64);
  if (!ALLOWED_MAPS.includes(mapId)) {
    (typeof sendLegacy === 'function' ? sendLegacy : send)(client.ws, { type: 'error', message: 'Unknown map.' });
    return;
  }
  room.mapId = mapId;
  if (typeof touchLegacy === 'function') touchLegacy(room); else if (typeof touch === 'function') touch(room);
  const payload = lobbyPayload(room);
  if (typeof broadcastLegacy === 'function') broadcastLegacy(room, payload);
  else broadcast(room, payload);
}

function onLegacyStartRace(client) {
  const room = roomOfLegacy(client);
  if (!room || room.hostId !== client.id) {
    sendLegacy(client.ws, { type: 'error', message: 'Only the host can start.' });
    return;
  }
  if (room.phase !== 'lobby') {
    sendLegacy(client.ws, { type: 'error', message: 'Not in lobby.' });
    return;
  }
  if (room.players.size < 1) {
    sendLegacy(client.ws, { type: 'error', message: 'Need at least one player.' });
    return;
  }
  for (const p of room.players.values()) {
    p.finished = false;
    p.finishPlace = null;
    p.finishTime = null;
  }
  room.results = [];
  room.phase = 'countdown';
  room.startAt = now() + LEGACY_COUNTDOWN_MS;
  room.raceStartWall = room.startAt;
  touchLegacy(room);
  const roster = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    driverId: p.driverId
  }));
  broadcastLegacy(room, {
    type: 'raceStart',
    startAt: room.startAt,
    serverNow: now(),
    raceLaps: room.raceLaps,
    fillAI: room.fillAI,
    slots: room.slots,
    mapId: room.mapId || 'miami-neon',
    players: roster
  });
  const code = room.code;
  const startAt = room.startAt;
  setTimeout(() => {
    const r = legacyRooms.get(code);
    if (!r || r.startAt !== startAt) return;
    if (r.phase === 'countdown') {
      r.phase = 'racing';
      broadcastLegacy(r, { type: 'raceGo', serverNow: now() });
    }
  }, LEGACY_COUNTDOWN_MS + 50);
}

function onLegacyState(client, msg) {
  const room = roomOfLegacy(client);
  if (!room) return;
  if (room.phase !== 'racing' && room.phase !== 'countdown') return;
  const t = now();
  if (t - client.lastStateAt < STATE_MIN_MS) return;
  client.lastStateAt = t;
  if (!speedSanityOk(msg.speed)) return;
  const payload = {
    type: 'state',
    id: client.id,
    t: typeof msg.t === 'number' ? msg.t : t,
    x: num(msg.x),
    y: num(msg.y),
    z: num(msg.z),
    yaw: num(msg.yaw),
    speed: num(msg.speed),
    steer: num(msg.steer),
    lap: Math.max(0, Math.min(99, Math.floor(num(msg.lap)) || 0)),
    progress: clamp01(num(msg.progress)),
    finished: !!msg.finished,
    serverNow: t
  };
  if (payload.x == null || payload.z == null || payload.yaw == null) return;
  touchLegacy(room);
  broadcastLegacy(room, payload, client.id);
}

function onLegacyFinish(client, msg) {
  const room = roomOfLegacy(client);
  const p = playerOfLegacy(client);
  if (!room || !p) return;
  if (room.phase !== 'racing' && room.phase !== 'countdown') return;
  if (p.finished) return;
  p.finished = true;
  const finishedCount = [...room.players.values()].filter((x) => x.finished).length;
  p.finishPlace = finishedCount;
  const elapsed = room.raceStartWall ? now() - room.raceStartWall : null;
  p.finishTime = typeof msg.time === 'number' ? msg.time : elapsed;
  touchLegacy(room);
  broadcastLegacy(room, {
    type: 'playerFinished',
    id: p.id,
    place: p.finishPlace,
    time: p.finishTime,
    serverNow: now()
  });
  maybeEndLegacyRace(room);
  const code = room.code;
  setTimeout(() => {
    const r = legacyRooms.get(code);
    if (r && r.phase === 'racing') finalizeLegacyResults(r);
  }, 90000);
}

function onLegacyRematch(client) {
  const room = roomOfLegacy(client);
  if (!room || room.hostId !== client.id) {
    sendLegacy(client.ws, { type: 'error', message: 'Only the host can rematch.' });
    return;
  }
  room.phase = 'lobby';
  room.startAt = null;
  room.results = [];
  for (const p of room.players.values()) {
    p.ready = false;
    p.finished = false;
    p.finishPlace = null;
    p.finishTime = null;
  }
  touchLegacy(room);
  broadcastLegacy(room, { type: 'rematch', serverNow: now() });
  broadcastLegacy(room, lobbyPayload(room));
}

wss.on('connection', (ws) => {
  const client = {
    id: uid(),
    ws,
    roomCode: null,
    lastStateAt: 0,
    msgWindowStart: now(),
    msgWindowCount: 0
  };
  legacyClients.set(ws, client);
  sendLegacy(ws, {
    type: 'hello',
    id: client.id,
    serverNow: now(),
    maxPlayers: LEGACY_MAX_PLAYERS
  });

  ws.on('message', (buf) => {
    if (buf.length > MSG_MAX_BYTES) {
      sendLegacy(ws, { type: 'error', message: 'Message too large.' });
      return;
    }
    handleLegacyMessage(client, buf.toString('utf8'));
  });

  ws.on('close', () => {
    leaveLegacyRoom(client, 'disconnect');
    legacyClients.delete(ws);
  });

  ws.on('error', () => {
    try {
      ws.close();
    } catch (_) {}
  });
});

// ===========================================================================
// socket.io /lobby — matchmaking + lobby for coming modules
// ===========================================================================
/** @type {Map<string, IoRoom>} */
const ioRooms = new Map();
/** @type {Map<string, IoSeeker>} */
const matchQueue = new Map();

/**
 * @typedef {object} IoPlayer
 * @property {string} id
 * @property {string} name
 * @property {string} carId
 * @property {string} driverId
 * @property {boolean} ready
 * @property {string} socketId
 */

/**
 * @typedef {object} IoRoom
 * @property {string} id
 * @property {string} hostId
 * @property {Map<string, IoPlayer>} players
 * @property {string} mapId
 * @property {'lobby'|'countdown'|'racing'} phase
 * @property {number|null} countdownEndsAt
 * @property {number} createdAt
 * @property {number} lastActive
 * @property {ReturnType<typeof setTimeout>|null} countdownTimer
 */

/**
 * @typedef {object} IoSeeker
 * @property {string} socketId
 * @property {string} name
 * @property {string} carId
 * @property {string} driverId
 * @property {number} startedAt
 * @property {ReturnType<typeof setTimeout>} timer
 */

function uniqueIoRoomId() {
  for (let i = 0; i < 40; i++) {
    const c = makeCode();
    if (!ioRooms.has(c) && !legacyRooms.has(c)) return c;
  }
  return makeCode() + CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
}

function ioLobbyPayload(room) {
  const players = [];
  for (const p of room.players.values()) {
    players.push({
      id: p.id,
      name: p.name,
      carId: p.carId,
      driverId: p.driverId,
      ready: !!p.ready,
      isHost: p.id === room.hostId
    });
  }
  return {
    roomId: room.id,
    hostId: room.hostId,
    mapId: room.mapId,
    phase: room.phase,
    countdownEndsAt: room.countdownEndsAt,
    maxPlayers: IO_MAX_PLAYERS,
    players,
    serverNow: now()
  };
}

function emitLobbyUpdate(room) {
  io.of('/lobby').to(room.id).emit('lobby:update', ioLobbyPayload(room));
}

function destroyIoRoom(id) {
  const room = ioRooms.get(id);
  if (!room) return;
  if (room.countdownTimer) {
    clearTimeout(room.countdownTimer);
    room.countdownTimer = null;
  }
  ioRooms.delete(id);
}

function ensureIoHost(room) {
  if (room.players.has(room.hostId)) return;
  const first = room.players.values().next().value;
  if (!first) return;
  room.hostId = first.id;
  io.of('/lobby').to(room.id).emit('host:changed', {
    hostId: room.hostId,
    serverNow: now()
  });
}

function leaveIoRoom(socket, reason) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = ioRooms.get(roomId);
  socket.data.roomId = null;
  socket.leave(roomId);
  if (!room) return;
  const playerId = socket.data.playerId;
  room.players.delete(playerId);
  room.lastActive = now();
  if (room.players.size === 0) {
    destroyIoRoom(roomId);
    return;
  }
  ensureIoHost(room);
  io.of('/lobby').to(roomId).emit('player:left', {
    id: playerId,
    reason: reason || 'left',
    hostId: room.hostId,
    serverNow: now()
  });
  // Cancel countdown if someone leaves mid-countdown
  if (room.phase === 'countdown') {
    room.phase = 'lobby';
    room.countdownEndsAt = null;
    if (room.countdownTimer) {
      clearTimeout(room.countdownTimer);
      room.countdownTimer = null;
    }
    for (const p of room.players.values()) p.ready = false;
  }
  emitLobbyUpdate(room);
}

function createIoRoom(hostPlayer) {
  const id = uniqueIoRoomId();
  /** @type {IoRoom} */
  const room = {
    id,
    hostId: hostPlayer.id,
    players: new Map([[hostPlayer.id, hostPlayer]]),
    mapId: 'miami-neon',
    phase: 'lobby',
    countdownEndsAt: null,
    createdAt: now(),
    lastActive: now(),
    countdownTimer: null
  };
  ioRooms.set(id, room);
  return room;
}

function findOpenIoRoom() {
  for (const room of ioRooms.values()) {
    if (room.phase !== 'lobby') continue;
    if (room.players.size >= IO_MAX_PLAYERS) continue;
    return room;
  }
  return null;
}

function cancelMatchSearch(socketId) {
  const seeker = matchQueue.get(socketId);
  if (!seeker) return;
  clearTimeout(seeker.timer);
  matchQueue.delete(socketId);
}

function placeSocketInRoom(socket, room, player) {
  socket.data.roomId = room.id;
  socket.data.playerId = player.id;
  socket.join(room.id);
  room.players.set(player.id, player);
  room.lastActive = now();
  socket.emit('matchmaking', {
    status: 'matched',
    roomId: room.id,
    isHost: room.hostId === player.id,
    serverNow: now()
  });
  emitLobbyUpdate(room);
}

function startIoCountdown(room) {
  if (room.phase !== 'lobby') return;
  if (room.players.size < 1) return;
  room.phase = 'countdown';
  room.countdownEndsAt = now() + IO_COUNTDOWN_MS;
  room.lastActive = now();
  io.of('/lobby').to(room.id).emit('countdown', {
    startAt: room.countdownEndsAt,
    durationMs: IO_COUNTDOWN_MS,
    serverNow: now(),
    mapId: room.mapId,
    players: ioLobbyPayload(room).players
  });
  emitLobbyUpdate(room);
  if (room.countdownTimer) clearTimeout(room.countdownTimer);
  const endsAt = room.countdownEndsAt;
  const roomId = room.id;
  room.countdownTimer = setTimeout(() => {
    const r = ioRooms.get(roomId);
    if (!r || r.countdownEndsAt !== endsAt) return;
    if (r.phase === 'countdown') {
      r.phase = 'racing';
      r.countdownTimer = null;
      io.of('/lobby').to(roomId).emit('race:go', {
        mapId: r.mapId,
        serverNow: now(),
        players: ioLobbyPayload(r).players
      });
      emitLobbyUpdate(r);
    }
  }, IO_COUNTDOWN_MS + 50);
}

function ioRateOk(socket) {
  const t = now();
  if (!socket.data.msgWindowStart || t - socket.data.msgWindowStart > 1000) {
    socket.data.msgWindowStart = t;
    socket.data.msgWindowCount = 0;
  }
  socket.data.msgWindowCount++;
  return socket.data.msgWindowCount <= IO_MSG_BURST;
}

const lobbyNsp = io.of('/lobby');

lobbyNsp.on('connection', (socket) => {
  socket.data.playerId = uid();
  socket.data.roomId = null;
  socket.data.msgWindowStart = now();
  socket.data.msgWindowCount = 0;

  socket.emit('hello', {
    id: socket.data.playerId,
    serverNow: now(),
    maxPlayers: IO_MAX_PLAYERS,
    maintenance: maintenanceMode
  });

  if (maintenanceMode) {
    socket.emit('maintenance', {
      active: true,
      message: 'Upgrading the race engines. Back in a few minutes with better circuits',
      serverNow: now()
    });
  }

  socket.on('time:ping', (payload) => {
    if (!ioRateOk(socket)) return;
    const t = payload && typeof payload.t === 'number' ? payload.t : null;
    socket.emit('time:pong', { t, serverNow: now() });
  });

  socket.on('findMatch', (payload) => {
    if (!ioRateOk(socket)) {
      socket.emit('error', { message: 'Slow down — too many messages.' });
      return;
    }
    if (maintenanceMode) {
      socket.emit('matchmaking', {
        status: 'maintenance',
        message: 'Upgrading the race engines. Back in a few minutes with better circuits',
        serverNow: now()
      });
      return;
    }
    if (socket.data.roomId) {
      socket.emit('error', { message: 'Already in a room. Leave first.' });
      return;
    }
    cancelMatchSearch(socket.id);

    const name = clampStr(payload && payload.name, 16) || 'Diva';
    const carId = clampStr(payload && payload.carId, 32) || 'default';
    const driverId = clampStr(payload && payload.driverId, 16) || 'bitty';

    // Prefer an existing open lobby
    const open = findOpenIoRoom();
    if (open) {
      const player = {
        id: socket.data.playerId,
        name,
        carId,
        driverId,
        ready: false,
        socketId: socket.id
      };
      placeSocketInRoom(socket, open, player);
      return;
    }

    // Also try pairing with another seeker immediately
    for (const [otherId, seeker] of matchQueue) {
      if (otherId === socket.id) continue;
      const otherSock = lobbyNsp.sockets.get(otherId);
      if (!otherSock || otherSock.data.roomId) {
        cancelMatchSearch(otherId);
        continue;
      }
      cancelMatchSearch(otherId);
      const hostPlayer = {
        id: otherSock.data.playerId,
        name: seeker.name,
        carId: seeker.carId,
        driverId: seeker.driverId,
        ready: false,
        socketId: otherId
      };
      const room = createIoRoom(hostPlayer);
      placeSocketInRoom(otherSock, room, hostPlayer);
      const joiner = {
        id: socket.data.playerId,
        name,
        carId,
        driverId,
        ready: false,
        socketId: socket.id
      };
      placeSocketInRoom(socket, room, joiner);
      return;
    }

    // Enter queue; after 10s create room and become host
    const timer = setTimeout(() => {
      matchQueue.delete(socket.id);
      if (socket.data.roomId) return;
      if (maintenanceMode) {
        socket.emit('matchmaking', {
          status: 'maintenance',
          message: 'Upgrading the race engines. Back in a few minutes with better circuits',
          serverNow: now()
        });
        return;
      }
      // One last check for an open room or another seeker
      const lateOpen = findOpenIoRoom();
      if (lateOpen) {
        const player = {
          id: socket.data.playerId,
          name,
          carId,
          driverId,
          ready: false,
          socketId: socket.id
        };
        placeSocketInRoom(socket, lateOpen, player);
        return;
      }
      const hostPlayer = {
        id: socket.data.playerId,
        name,
        carId,
        driverId,
        ready: false,
        socketId: socket.id
      };
      const room = createIoRoom(hostPlayer);
      placeSocketInRoom(socket, room, hostPlayer);
      socket.emit('matchmaking', {
        status: 'timeout',
        roomId: room.id,
        isHost: true,
        message: 'No match found — you are the host.',
        serverNow: now()
      });
    }, FIND_MATCH_MS);

    matchQueue.set(socket.id, {
      socketId: socket.id,
      name,
      carId,
      driverId,
      startedAt: now(),
      timer
    });
    socket.emit('matchmaking', {
      status: 'searching',
      timeoutMs: FIND_MATCH_MS,
      serverNow: now()
    });
  });

  socket.on('cancelFind', () => {
    if (!ioRateOk(socket)) return;
    cancelMatchSearch(socket.id);
    socket.emit('matchmaking', { status: 'cancelled', serverNow: now() });
  });

  socket.on('setCar', (payload) => {
    if (!ioRateOk(socket)) return;
    const room = ioRooms.get(socket.data.roomId);
    if (!room || room.phase !== 'lobby') return;
    const p = room.players.get(socket.data.playerId);
    if (!p) return;
    p.carId = clampStr(payload && payload.carId, 32) || p.carId;
    room.lastActive = now();
    emitLobbyUpdate(room);
  });

  socket.on('setDriver', (payload) => {
    if (!ioRateOk(socket)) return;
    const room = ioRooms.get(socket.data.roomId);
    if (!room || room.phase !== 'lobby') return;
    const p = room.players.get(socket.data.playerId);
    if (!p) return;
    p.driverId = clampStr(payload && payload.driverId, 16) || p.driverId;
    room.lastActive = now();
    emitLobbyUpdate(room);
  });

  socket.on('setMap', (payload) => {
    if (!ioRateOk(socket)) return;
    const room = ioRooms.get(socket.data.roomId);
    if (!room || room.phase !== 'lobby') return;
    if (room.hostId !== socket.data.playerId) {
      socket.emit('error', { message: 'Only the host can pick the map.' });
      return;
    }
    const mapId = clampStr(payload && payload.mapId, 64);
    if (!ALLOWED_MAPS.includes(mapId)) {
      socket.emit('error', { message: 'Unknown map.' });
      return;
    }
    room.mapId = mapId;
    room.lastActive = now();
    emitLobbyUpdate(room);
  });

  socket.on('setReady', (payload) => {
    if (!ioRateOk(socket)) return;
    const room = ioRooms.get(socket.data.roomId);
    if (!room || room.phase !== 'lobby') return;
    const p = room.players.get(socket.data.playerId);
    if (!p) return;
    p.ready = !!(payload && payload.ready);
    room.lastActive = now();
    emitLobbyUpdate(room);
    // Auto-start when every player is ready and host is present
    const allReady =
      room.players.size >= 1 && [...room.players.values()].every((x) => x.ready);
    if (allReady && room.hostId === socket.data.playerId) {
      startIoCountdown(room);
    }
  });

  socket.on('startCountdown', () => {
    if (!ioRateOk(socket)) return;
    const room = ioRooms.get(socket.data.roomId);
    if (!room) return;
    if (room.hostId !== socket.data.playerId) {
      socket.emit('error', { message: 'Only the host can start the countdown.' });
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('error', { message: 'Not in lobby.' });
      return;
    }
    startIoCountdown(room);
  });

  socket.on('leave', () => {
    if (!ioRateOk(socket)) return;
    cancelMatchSearch(socket.id);
    leaveIoRoom(socket, 'leave');
    socket.emit('left', { serverNow: now() });
  });

  socket.on('disconnect', () => {
    cancelMatchSearch(socket.id);
    leaveIoRoom(socket, 'disconnect');
  });
});

// ---------------------------------------------------------------------------
// Idle cleanup
// ---------------------------------------------------------------------------
const idleInterval = setInterval(() => {
  const t = now();
  for (const [code, room] of legacyRooms) {
    if (t - room.lastActive > ROOM_IDLE_MS) {
      for (const p of room.players.values()) {
        sendLegacy(p.ws, { type: 'error', message: 'Room closed due to inactivity.' });
        try {
          p.ws && p.ws.close();
        } catch (_) {}
      }
      destroyLegacyRoom(code);
    }
  }
  for (const [id, room] of ioRooms) {
    if (t - room.lastActive > ROOM_IDLE_MS) {
      io.of('/lobby').to(id).emit('error', { message: 'Room closed due to inactivity.' });
      for (const p of room.players.values()) {
        const s = lobbyNsp.sockets.get(p.socketId);
        if (s) {
          s.data.roomId = null;
          s.leave(id);
        }
      }
      destroyIoRoom(id);
    }
  }
}, 60_000);
if (typeof idleInterval.unref === 'function') idleInterval.unref();

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[hot-rides-divas-server] ${signal} — shutting down`);
  maintenanceMode = true;
  const flag = {
    type: 'maintenance',
    active: true,
    message: 'Server restarting — reconnect in a moment.',
    serverNow: now()
  };
  for (const client of legacyClients.values()) {
    sendLegacy(client.ws, flag);
    try {
      client.ws.close();
    } catch (_) {}
  }
  io.of('/lobby').emit('maintenance', flag);
  clearInterval(idleInterval);
  for (const seeker of matchQueue.values()) clearTimeout(seeker.timer);
  matchQueue.clear();

  const force = setTimeout(() => {
    console.log('[hot-rides-divas-server] force exit');
    process.exit(0);
  }, 8000);
  if (typeof force.unref === 'function') force.unref();

  io.close(() => {
    server.close(() => {
      console.log('[hot-rides-divas-server] closed');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`[hot-rides-divas-server] Module 1 listening on :${PORT}`);
  console.log(`[hot-rides-divas-server] legacy ws + socket.io /lobby ready`);
});

module.exports = {
  app,
  server,
  io,
  wss,
  speedSanityOk,
  getLiveConfigPublic,
  // test hooks
  _state: {
    get maintenanceMode() {
      return maintenanceMode;
    },
    set maintenanceMode(v) {
      maintenanceMode = !!v;
    },
    legacyRooms,
    ioRooms,
    matchQueue,
    legacyClients
  }
};
