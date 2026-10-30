/**
 * Hot Rides Divas — multiplayer WebSocket relay (authoritative-lite)
 * -----------------------------------------------------------------
 * Rooms (5-char codes), lobby, synchronized race start, pose relay,
 * finish order, host migration, cleanup, basic validation + rate limits.
 *
 * Env: PORT (Render sets this). Health: GET / and GET /health → 200.
 */
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const MAX_PLAYERS = 7;
const CODE_LEN = 5;
/** Unambiguous alphabet (no I/O/0/1). */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_IDLE_MS = 30 * 60 * 1000;
const STATE_MIN_MS = 45; // ~22 Hz max from client
const MSG_MAX_BYTES = 4096;
const MSG_BURST = 40; // messages per second soft cap
const RACE_LAPS = 3;
const COUNTDOWN_MS = 3500;

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<import('ws').WebSocket, Client>} */
const clients = new Map();

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

function makeCode() {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) {
    code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  }
  return code;
}

function uniqueCode() {
  for (let i = 0; i < 40; i++) {
    const c = makeCode();
    if (!rooms.has(c)) return c;
  }
  return makeCode() + CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
}

function clampStr(s, max) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, max);
}

function now() {
  return Date.now();
}

/**
 * @typedef {object} Player
 * @property {string} id
 * @property {string} name
 * @property {string} driverId
 * @property {boolean} ready
 * @property {boolean} finished
 * @property {number|null} finishPlace
 * @property {number|null} finishTime
 * @property {import('ws').WebSocket|null} ws
 */

/**
 * @typedef {object} Room
 * @property {string} code
 * @property {string} hostId
 * @property {Map<string, Player>} players
 * @property {'lobby'|'countdown'|'racing'|'results'} phase
 * @property {boolean} fillAI
 * @property {number} slots
 * @property {number} raceLaps
 * @property {number|null} startAt
 * @property {number} createdAt
 * @property {number} lastActive
 * @property {number} raceStartWall
 * @property {Array<{id:string,name:string,driverId:string,place:number,time:number}>} results
 */

/**
 * @typedef {object} Client
 * @property {string} id
 * @property {import('ws').WebSocket} ws
 * @property {string|null} roomCode
 * @property {number} lastStateAt
 * @property {number} msgWindowStart
 * @property {number} msgWindowCount
 */

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
    players,
    serverNow: now()
  };
}

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (_) {}
}

function broadcast(room, obj, exceptId) {
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

function touch(room) {
  room.lastActive = now();
}

function ensureHost(room) {
  if (room.players.has(room.hostId)) return;
  const first = room.players.values().next().value;
  if (!first) return;
  room.hostId = first.id;
  broadcast(room, { type: 'hostChanged', hostId: room.hostId, serverNow: now() });
}

function destroyRoom(code) {
  rooms.delete(code);
}

function leaveRoom(client, reason) {
  if (!client.roomCode) return;
  const room = rooms.get(client.roomCode);
  client.roomCode = null;
  if (!room) return;
  const player = room.players.get(client.id);
  room.players.delete(client.id);
  touch(room);
  if (room.players.size === 0) {
    destroyRoom(room.code);
    return;
  }
  ensureHost(room);
  broadcast(room, {
    type: 'playerLeft',
    id: client.id,
    reason: reason || 'left',
    hostId: room.hostId,
    serverNow: now()
  });
  broadcast(room, lobbyPayload(room));
  // If racing and all remaining humans finished, close race
  if (room.phase === 'racing') maybeEndRace(room);
}

function maybeEndRace(room) {
  const humans = [...room.players.values()];
  if (humans.length === 0) return;
  const allDone = humans.every((p) => p.finished);
  if (!allDone) return;
  finalizeResults(room);
}

function finalizeResults(room) {
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
  // Append DNFs
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
  broadcast(room, {
    type: 'raceResults',
    results: ordered,
    serverNow: now()
  });
  broadcast(room, lobbyPayload(room));
}

function rateOk(client) {
  const t = now();
  if (t - client.msgWindowStart > 1000) {
    client.msgWindowStart = t;
    client.msgWindowCount = 0;
  }
  client.msgWindowCount++;
  return client.msgWindowCount <= MSG_BURST;
}

function handleMessage(client, data) {
  if (!rateOk(client)) {
    send(client.ws, { type: 'error', message: 'Slow down — too many messages.' });
    return;
  }
  let msg;
  try {
    msg = JSON.parse(data);
  } catch (_) {
    send(client.ws, { type: 'error', message: 'Invalid JSON.' });
    return;
  }
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    send(client.ws, { type: 'error', message: 'Bad message.' });
    return;
  }

  switch (msg.type) {
    case 'ping':
      send(client.ws, { type: 'pong', t: msg.t, serverNow: now() });
      break;
    case 'create':
      onCreate(client, msg);
      break;
    case 'join':
      onJoin(client, msg);
      break;
    case 'setName':
      onSetName(client, msg);
      break;
    case 'setDriver':
      onSetDriver(client, msg);
      break;
    case 'setReady':
      onSetReady(client, msg);
      break;
    case 'setFillAI':
      onSetFillAI(client, msg);
      break;
    case 'setSlots':
      onSetSlots(client, msg);
      break;
    case 'startRace':
      onStartRace(client);
      break;
    case 'state':
      onState(client, msg);
      break;
    case 'finish':
      onFinish(client, msg);
      break;
    case 'rematch':
      onRematch(client);
      break;
    case 'leave':
      leaveRoom(client, 'leave');
      send(client.ws, { type: 'left', serverNow: now() });
      break;
    default:
      send(client.ws, { type: 'error', message: 'Unknown type: ' + msg.type });
  }
}

function onCreate(client, msg) {
  leaveRoom(client, 'recreate');
  const code = uniqueCode();
  const name = clampStr(msg.name, 16) || 'Diva';
  const driverId = clampStr(msg.driverId, 16) || 'bitty';
  /** @type {Room} */
  const room = {
    code,
    hostId: client.id,
    players: new Map(),
    phase: 'lobby',
    fillAI: true,
    slots: 4,
    raceLaps: RACE_LAPS,
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
  rooms.set(code, room);
  client.roomCode = code;
  send(client.ws, {
    type: 'welcome',
    id: client.id,
    code,
    isHost: true,
    serverNow: now()
  });
  send(client.ws, lobbyPayload(room));
}

function onJoin(client, msg) {
  const code = clampStr(msg.code, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const room = rooms.get(code);
  if (!room) {
    send(client.ws, { type: 'error', message: 'Room not found. Check the code.' });
    return;
  }
  if (room.phase !== 'lobby' && room.phase !== 'results') {
    send(client.ws, { type: 'error', message: 'Race already in progress.' });
    return;
  }
  if (room.players.size >= MAX_PLAYERS) {
    send(client.ws, { type: 'error', message: 'Room is full (max ' + MAX_PLAYERS + ').' });
    return;
  }
  leaveRoom(client, 'rejoin');
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
    // Joining mid-results drops room back toward lobby for rematch flow
    room.phase = 'lobby';
    for (const p of room.players.values()) {
      p.ready = false;
      p.finished = false;
      p.finishPlace = null;
      p.finishTime = null;
    }
  }
  touch(room);
  send(client.ws, {
    type: 'welcome',
    id: client.id,
    code,
    isHost: room.hostId === client.id,
    serverNow: now()
  });
  broadcast(room, lobbyPayload(room));
}

function roomOf(client) {
  if (!client.roomCode) return null;
  return rooms.get(client.roomCode) || null;
}

function playerOf(client) {
  const room = roomOf(client);
  if (!room) return null;
  return room.players.get(client.id) || null;
}

function onSetName(client, msg) {
  const room = roomOf(client);
  const p = playerOf(client);
  if (!room || !p) return;
  if (room.phase !== 'lobby') return;
  p.name = clampStr(msg.name, 16) || p.name;
  touch(room);
  broadcast(room, lobbyPayload(room));
}

function onSetDriver(client, msg) {
  const room = roomOf(client);
  const p = playerOf(client);
  if (!room || !p) return;
  if (room.phase !== 'lobby') return;
  p.driverId = clampStr(msg.driverId, 16) || p.driverId;
  touch(room);
  broadcast(room, lobbyPayload(room));
}

function onSetReady(client, msg) {
  const room = roomOf(client);
  const p = playerOf(client);
  if (!room || !p) return;
  if (room.phase !== 'lobby') return;
  p.ready = !!msg.ready;
  touch(room);
  broadcast(room, lobbyPayload(room));
}

function onSetFillAI(client, msg) {
  const room = roomOf(client);
  if (!room || room.hostId !== client.id) return;
  if (room.phase !== 'lobby') return;
  room.fillAI = !!msg.fillAI;
  touch(room);
  broadcast(room, lobbyPayload(room));
}

function onSetSlots(client, msg) {
  const room = roomOf(client);
  if (!room || room.hostId !== client.id) return;
  if (room.phase !== 'lobby') return;
  let n = Number(msg.slots);
  if (!Number.isFinite(n)) return;
  n = Math.max(2, Math.min(MAX_PLAYERS, Math.round(n)));
  room.slots = n;
  touch(room);
  broadcast(room, lobbyPayload(room));
}

function onStartRace(client) {
  const room = roomOf(client);
  if (!room || room.hostId !== client.id) {
    send(client.ws, { type: 'error', message: 'Only the host can start.' });
    return;
  }
  if (room.phase !== 'lobby') {
    send(client.ws, { type: 'error', message: 'Not in lobby.' });
    return;
  }
  if (room.players.size < 1) {
    send(client.ws, { type: 'error', message: 'Need at least one player.' });
    return;
  }
  // Soft ready check: host may start even if others aren't ready (feels better for friends)
  for (const p of room.players.values()) {
    p.finished = false;
    p.finishPlace = null;
    p.finishTime = null;
  }
  room.results = [];
  room.phase = 'countdown';
  room.startAt = now() + COUNTDOWN_MS;
  room.raceStartWall = room.startAt;
  touch(room);
  const roster = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    driverId: p.driverId
  }));
  broadcast(room, {
    type: 'raceStart',
    startAt: room.startAt,
    serverNow: now(),
    raceLaps: room.raceLaps,
    fillAI: room.fillAI,
    slots: room.slots,
    players: roster
  });
  // Flip to racing when countdown ends
  const code = room.code;
  const startAt = room.startAt;
  setTimeout(() => {
    const r = rooms.get(code);
    if (!r || r.startAt !== startAt) return;
    if (r.phase === 'countdown') {
      r.phase = 'racing';
      broadcast(r, { type: 'raceGo', serverNow: now() });
    }
  }, COUNTDOWN_MS + 50);
}

function onState(client, msg) {
  const room = roomOf(client);
  if (!room) return;
  if (room.phase !== 'racing' && room.phase !== 'countdown') return;
  const t = now();
  if (t - client.lastStateAt < STATE_MIN_MS) return;
  client.lastStateAt = t;
  // Validate numeric fields lightly
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
  touch(room);
  broadcast(room, payload, client.id);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp01(v) {
  if (v == null) return 0;
  return Math.max(0, Math.min(1, v));
}

function onFinish(client, msg) {
  const room = roomOf(client);
  const p = playerOf(client);
  if (!room || !p) return;
  if (room.phase !== 'racing' && room.phase !== 'countdown') return;
  if (p.finished) return;
  p.finished = true;
  const finishedCount = [...room.players.values()].filter((x) => x.finished).length;
  p.finishPlace = finishedCount;
  const elapsed = room.raceStartWall ? now() - room.raceStartWall : null;
  p.finishTime = typeof msg.time === 'number' ? msg.time : elapsed;
  touch(room);
  broadcast(room, {
    type: 'playerFinished',
    id: p.id,
    place: p.finishPlace,
    time: p.finishTime,
    serverNow: now()
  });
  maybeEndRace(room);
  // Safety: end after 90s even if some never finish
  const code = room.code;
  setTimeout(() => {
    const r = rooms.get(code);
    if (r && r.phase === 'racing') finalizeResults(r);
  }, 90000);
}

function onRematch(client) {
  const room = roomOf(client);
  if (!room || room.hostId !== client.id) {
    send(client.ws, { type: 'error', message: 'Only the host can rematch.' });
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
  touch(room);
  broadcast(room, { type: 'rematch', serverNow: now() });
  broadcast(room, lobbyPayload(room));
}

// --- HTTP + WS ---
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/health')) {
    const body = JSON.stringify({
      ok: true,
      service: 'hot-rides-divas-server',
      rooms: rooms.size,
      clients: clients.size,
      ts: now()
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const client = {
    id: uid(),
    ws,
    roomCode: null,
    lastStateAt: 0,
    msgWindowStart: now(),
    msgWindowCount: 0
  };
  clients.set(ws, client);
  send(ws, { type: 'hello', id: client.id, serverNow: now(), maxPlayers: MAX_PLAYERS });

  ws.on('message', (buf) => {
    if (buf.length > MSG_MAX_BYTES) {
      send(ws, { type: 'error', message: 'Message too large.' });
      return;
    }
    handleMessage(client, buf.toString('utf8'));
  });

  ws.on('close', () => {
    leaveRoom(client, 'disconnect');
    clients.delete(ws);
  });

  ws.on('error', () => {
    try {
      ws.close();
    } catch (_) {}
  });
});

// Idle room cleanup
setInterval(() => {
  const t = now();
  for (const [code, room] of rooms) {
    if (t - room.lastActive > ROOM_IDLE_MS) {
      for (const p of room.players.values()) {
        send(p.ws, { type: 'error', message: 'Room closed due to inactivity.' });
        try {
          p.ws && p.ws.close();
        } catch (_) {}
      }
      destroyRoom(code);
    }
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`[hot-rides-divas-server] listening on :${PORT}`);
});
