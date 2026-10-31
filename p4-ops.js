/**
 * Phase 4 ops: live_config, kill-switch, telemetry, daily bonus / TotD,
 * ghosts, driving analytics. Secrets only from env (ADMIN_PASSWORD, SESSION_SECRET).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = path.join(__dirname, 'live_config.json');
const CONFIG_OVERRIDE = path.join(DATA_DIR, 'live_config.override.json');
const TELEMETRY_LOG = path.join(DATA_DIR, 'telemetry.jsonl');
const GHOST_DIR = path.join(DATA_DIR, 'ghosts');
const ANALYTICS_DIR = path.join(DATA_DIR, 'analytics');
const DAILY_PATH = path.join(DATA_DIR, 'daily.json');

function ensureDirs() {
  for (const d of [DATA_DIR, GHOST_DIR, ANALYTICS_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }
}

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonSafe(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

let liveConfig = {
  version: 1,
  maintenance: false,
  maintenanceMessage: 'Upgrading the race engines. Back in a few minutes with better circuits',
  asphaltFriction: 1.0,
  nitroPower: 1.0,
  mapTuning: {},
  dailyBonusCoins: 250,
  dailyBonusStyleMult: 1.5,
  trackOfTheDayPool: ['miami-neon', 'sunshine-speedway', 'neon-kyoto'],
  ghostMaxBytes: 48000,
  telemetryEnabled: true
};

function reloadLiveConfig() {
  ensureDirs();
  const base = readJsonSafe(CONFIG_PATH, {});
  const over = readJsonSafe(CONFIG_OVERRIDE, {});
  liveConfig = Object.assign({}, liveConfig, base, over);
  return liveConfig;
}

function getLiveConfig() {
  return liveConfig;
}

function setMaintenance(on, message) {
  liveConfig.maintenance = !!on;
  if (message) liveConfig.maintenanceMessage = String(message).slice(0, 240);
  writeJsonSafe(CONFIG_OVERRIDE, {
    maintenance: liveConfig.maintenance,
    maintenanceMessage: liveConfig.maintenanceMessage
  });
  return liveConfig;
}

function adminPasswordOk(provided) {
  const expect = process.env.ADMIN_PASSWORD;
  if (!expect || typeof expect !== 'string' || !expect.length) {
    return { ok: false, reason: 'ADMIN_PASSWORD not set on server' };
  }
  if (typeof provided !== 'string' || !provided.length) {
    return { ok: false, reason: 'password required' };
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expect);
  if (a.length !== b.length) {
    // timing-safe length pad compare
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return { ok: false, reason: 'unauthorized' };
  }
  const match = crypto.timingSafeEqual(a, b);
  return match ? { ok: true } : { ok: false, reason: 'unauthorized' };
}

/** Simple IP rate limit for admin */
const adminHits = new Map();
function adminRateOk(ip) {
  const t = Date.now();
  const row = adminHits.get(ip) || { t, n: 0 };
  if (t - row.t > 60_000) { row.t = t; row.n = 0; }
  row.n++;
  adminHits.set(ip, row);
  return row.n <= 20;
}

const telemetryHits = new Map();
function telemetryRateOk(ip) {
  const t = Date.now();
  const row = telemetryHits.get(ip) || { t, n: 0 };
  if (t - row.t > 60_000) { row.t = t; row.n = 0; }
  row.n++;
  telemetryHits.set(ip, row);
  return row.n <= 30;
}

function appendTelemetry(entry, ip) {
  if (!liveConfig.telemetryEnabled) return { ok: false, reason: 'disabled' };
  if (!telemetryRateOk(ip || 'x')) return { ok: false, reason: 'rate' };
  ensureDirs();
  const line = JSON.stringify({
    ts: Date.now(),
    message: String(entry.message || '').slice(0, 500),
    file: String(entry.file || '').slice(0, 200),
    line: Number(entry.line) || 0,
    col: Number(entry.col) || 0,
    stack: String(entry.stack || '').slice(0, 1500),
    ua: String(entry.ua || '').slice(0, 200),
    map: String(entry.map || '').slice(0, 64)
  }) + '\n';
  try {
    fs.appendFileSync(TELEMETRY_LOG, line);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function utcDayKey(d) {
  const x = d || new Date();
  return x.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

function pickTrackOfTheDay(dayKey) {
  const pool = liveConfig.trackOfTheDayPool || ['miami-neon'];
  let h = 0;
  for (let i = 0; i < dayKey.length; i++) h = (h * 31 + dayKey.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

function getDailyState() {
  ensureDirs();
  const day = utcDayKey();
  let st = readJsonSafe(DAILY_PATH, null);
  if (!st || st.day !== day) {
    st = {
      day,
      trackOfTheDay: pickTrackOfTheDay(day),
      claimed: {} // wallet -> true
    };
    writeJsonSafe(DAILY_PATH, st);
  }
  return st;
}

function claimDailyBonus(wallet) {
  const w = String(wallet || '').slice(0, 64);
  if (w.length < 32) return { ok: false, error: 'wallet required' };
  const st = getDailyState();
  if (st.claimed[w]) {
    return {
      ok: true,
      already: true,
      coins: 0,
      styleMult: liveConfig.dailyBonusStyleMult || 1.5,
      trackOfTheDay: st.trackOfTheDay,
      day: st.day
    };
  }
  st.claimed[w] = Date.now();
  writeJsonSafe(DAILY_PATH, st);
  return {
    ok: true,
    already: false,
    coins: liveConfig.dailyBonusCoins || 250,
    styleMult: liveConfig.dailyBonusStyleMult || 1.5,
    trackOfTheDay: st.trackOfTheDay,
    day: st.day
  };
}

function ghostKey(mapId, walletOrAnon) {
  const safe = String(walletOrAnon || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'anon';
  const map = String(mapId || 'miami-neon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  return map + '__' + safe + '.bin';
}

function saveGhost(mapId, wallet, buffer, meta) {
  ensureDirs();
  const max = liveConfig.ghostMaxBytes || 48000;
  if (!Buffer.isBuffer(buffer) || buffer.length < 16 || buffer.length > max) {
    return { ok: false, error: 'ghost size' };
  }
  const key = ghostKey(mapId, wallet || 'anon');
  const fp = path.join(GHOST_DIR, key);
  const metaPath = fp + '.json';
  try {
    fs.writeFileSync(fp, buffer);
    writeJsonSafe(metaPath, Object.assign({ mapId, wallet: wallet || null, bytes: buffer.length, ts: Date.now() }, meta || {}));
    return { ok: true, key, bytes: buffer.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function loadGhost(mapId, wallet) {
  ensureDirs();
  const key = ghostKey(mapId, wallet || 'anon');
  const fp = path.join(GHOST_DIR, key);
  try {
    const buf = fs.readFileSync(fp);
    const meta = readJsonSafe(fp + '.json', {});
    return { ok: true, buffer: buf, meta };
  } catch (_) {
    // fallback: best ghost for map
    try {
      const files = fs.readdirSync(GHOST_DIR).filter((f) => f.startsWith(String(mapId).replace(/[^a-zA-Z0-9_-]/g, '')) && f.endsWith('.bin'));
      if (!files.length) return { ok: false, error: 'none' };
      files.sort();
      const buf = fs.readFileSync(path.join(GHOST_DIR, files[0]));
      const meta = readJsonSafe(path.join(GHOST_DIR, files[0] + '.json'), {});
      return { ok: true, buffer: buf, meta, key: files[0] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

function saveAnalytics(wallet, payload) {
  ensureDirs();
  const w = String(wallet || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'anon';
  const fp = path.join(ANALYTICS_DIR, w + '.jsonl');
  const line = JSON.stringify({
    ts: Date.now(),
    mapId: String(payload.mapId || '').slice(0, 64),
    sectors: Array.isArray(payload.sectors) ? payload.sectors.slice(0, 32) : [],
    bestMs: Number(payload.bestMs) || null
  }) + '\n';
  try {
    fs.appendFileSync(fp, line);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Quantize / delta helpers for pose relay */
function quantizeState(msg) {
  const out = {
    type: 'state',
    id: msg.id,
    t: msg.t,
    x: Math.round((msg.x || 0) * 100) / 100,
    y: Math.round((msg.y || 0) * 100) / 100,
    z: Math.round((msg.z || 0) * 100) / 100,
    yaw: Math.round((msg.yaw || 0) * 1000) / 1000,
    speed: Math.round((msg.speed || 0) * 10) / 10,
    steer: Math.round((msg.steer || 0) * 100) / 100,
    lap: msg.lap | 0,
    progress: Math.round((msg.progress || 0) * 1000) / 1000,
    nitro: !!msg.nitro,
    mapId: msg.mapId
  };
  return out;
}

function deltaState(prev, next) {
  if (!prev) return { full: true, state: next };
  const d = { type: 'stateDelta', id: next.id, t: next.t, seq: next.seq };
  let changed = 0;
  for (const k of ['x', 'y', 'z', 'yaw', 'speed', 'steer', 'lap', 'progress', 'nitro', 'mapId']) {
    if (prev[k] !== next[k]) { d[k] = next[k]; changed++; }
  }
  if (changed === 0) return { skip: true };
  // Periodic keyframe every ~1s
  if (!prev._kfAt || (next.t - prev._kfAt) > 1000) {
    return { full: true, state: next };
  }
  return { delta: d };
}

reloadLiveConfig();

module.exports = {
  reloadLiveConfig,
  getLiveConfig,
  setMaintenance,
  adminPasswordOk,
  adminRateOk,
  appendTelemetry,
  getDailyState,
  claimDailyBonus,
  saveGhost,
  loadGhost,
  saveAnalytics,
  quantizeState,
  deltaState,
  ensureDirs,
  DATA_DIR
};
