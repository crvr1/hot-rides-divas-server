/**
 * Per-wallet purchase ledger (cars + upgrades) with on-chain tx verification.
 * Durable JSON file under DATA_DIR (Render persistent disk) or ./data.
 *
 * Env:
 *   DATA_DIR          — directory for ownership.json (default: ./data)
 *   MERCHANT_WALLET   — expected SOL recipient (default: BK55…P4m8)
 *   SOLANA_RPC_URL    — JSON-RPC URL (alias SOLANA_RPC; default: public mainnet)
 *   MOCK_VERIFY      — when '1', accept mock signatures for local tests
 *   SESSION_SECRET    — HMAC secret for session tokens
 *   BOSS_CAR_ID       — default boss-car
 *   BOSS_PRICE_SOL    — default 1
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'ownership.json');
const MERCHANT = process.env.MERCHANT_WALLET || 'BK55uDsiq2BNpmNC2CSa6GzPwr9dYzMvSbou5RNFP4m8';
const RPC = process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const MOCK_VERIFY = process.env.MOCK_VERIFY === '1' || process.env.MOCK_VERIFY === 'true';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const BOSS_CAR_ID = process.env.BOSS_CAR_ID || 'boss-car';
const BOSS_PRICE_SOL = Number(process.env.BOSS_PRICE_SOL || 1);
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Catalog of claimable items → minimum lamports + kind */
const PET_KITTEN_ID = process.env.PET_KITTEN_ID || 'pet_kitten';
const PET_KITTEN_PRICE_SOL = Number(process.env.PET_KITTEN_PRICE_SOL || 0.5);

const CATALOG = {
  car: {
    'boss-car': { minLamports: Math.round(BOSS_PRICE_SOL * LAMPORTS_PER_SOL), label: 'BOSS CAR' },
    'strada': { minLamports: Math.round(0.05 * LAMPORTS_PER_SOL), label: 'Strada' },
    'vortex': { minLamports: Math.round(0.1 * LAMPORTS_PER_SOL), label: 'Vortex' },
    'falco': { minLamports: Math.round(0.1 * LAMPORTS_PER_SOL), label: 'Falco' },
    'apex': { minLamports: Math.round(0.25 * LAMPORTS_PER_SOL), label: 'Apex Extreme' }
  },
  pet: {
    'pet_kitten': { minLamports: Math.round(PET_KITTEN_PRICE_SOL * LAMPORTS_PER_SOL), label: 'KITTEN' }
  },
  upgrade: {
    // level costs match garage PRICES.upgrades
    engine: { levels: { 1: 0.005, 2: 0.01, 3: 0.025, 4: 0.05, 5: 0.1 } },
    turbo: { levels: { 1: 0.005, 2: 0.01, 3: 0.025, 4: 0.05, 5: 0.1 } },
    tires: { levels: { 1: 0.005, 2: 0.01, 3: 0.025, 4: 0.05, 5: 0.1 } },
    brakes: { levels: { 1: 0.005, 2: 0.01, 3: 0.025, 4: 0.05, 5: 0.1 } },
    suspension: { levels: { 1: 0.005, 2: 0.01, 3: 0.025, 4: 0.05, 5: 0.1 } }
  }
};

const nonces = new Map(); // wallet -> { nonce, exp }
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

let diskOk = true;
let diskWarned = false;

function warnDisk(err) {
  diskOk = false;
  if (!diskWarned) {
    diskWarned = true;
    console.warn(
      '[ownership] WARNING: no persistent disk (fallback to in-memory ledger).',
      'Purchases will NOT survive restarts. Mount a Render disk at DATA_DIR or /var/data.',
      err && err.message ? err.message : err || ''
    );
  }
}

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Probe write access (Render free tier has no persistent disk)
    const probe = path.join(DATA_DIR, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    try { fs.unlinkSync(probe); } catch (_) {}
    diskOk = true;
  } catch (e) {
    warnDisk(e);
  }
}

function defaultStore() {
  return { version: 1, wallets: {}, usedSignatures: {} };
}

function loadStore() {
  ensureDir();
  if (!diskOk) return defaultStore();
  try {
    if (!fs.existsSync(STORE_PATH)) return defaultStore();
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (!j.wallets) j.wallets = {};
    if (!j.usedSignatures) j.usedSignatures = {};
    return j;
  } catch (e) {
    console.error('[ownership] load failed, starting empty:', e.message);
    warnDisk(e);
    return defaultStore();
  }
}

function saveStore(store) {
  if (!diskOk) return; // in-memory only
  try {
    ensureDir();
    if (!diskOk) return;
    const tmp = STORE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    warnDisk(e);
  }
}

let store = loadStore();

function walletRec(wallet) {
  if (!store.wallets[wallet]) {
    store.wallets[wallet] = {
      cars: ['starter'],
      pets: [],
      equippedPet: null,
      upgrades: { engine: 0, turbo: 0, tires: 0, brakes: 0, suspension: 0 },
      txs: {}
    };
  }
  const w = store.wallets[wallet];
  if (!w.cars.includes('starter')) w.cars.push('starter');
  if (!Array.isArray(w.pets)) w.pets = [];
  if (w.equippedPet === undefined) w.equippedPet = null;
  if (w.equippedPet && !w.pets.includes(w.equippedPet)) w.equippedPet = null;
  if (!Array.isArray(w.cosmetics)) w.cosmetics = [];
  if (!w.hrdUpgrades) w.hrdUpgrades = {};
  return w;
}

function purchasesOf(wallet) {
  const w = walletRec(wallet);
  return {
    wallet,
    cars: w.cars.slice(),
    pets: (w.pets || []).slice(),
    equippedPet: w.equippedPet || null,
    ownsBoss: w.cars.includes(BOSS_CAR_ID),
    ownsPetKitten: (w.pets || []).includes(PET_KITTEN_ID),
    cosmetics: (w.cosmetics || []).slice(),
    hrdUpgrades: Object.assign({}, w.hrdUpgrades || {}),
    txCount: Object.keys(w.txs).length
  };
}

// --- base58 (Solana pubkeys / sigs) ---
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const val = B58.indexOf(str[i]);
    if (val < 0) throw new Error('Invalid base58');
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

function ed25519Verify(messageBuf, sigBuf, pubkeyBuf) {
  if (pubkeyBuf.length !== 32 || sigBuf.length !== 64) return false;
  // SPKI DER prefix for raw Ed25519 public key
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([prefix, pubkeyBuf]),
      format: 'der',
      type: 'spki'
    });
    return crypto.verify(null, messageBuf, key, sigBuf);
  } catch (_) {
    return false;
  }
}

function issueNonce(wallet) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + 5 * 60 * 1000;
  nonces.set(wallet, { nonce, exp });
  const message =
    `Hot Rides Divas login\nWallet: ${wallet}\nNonce: ${nonce}\nExpires: ${new Date(exp).toISOString()}`;
  return { nonce, exp, message };
}

function makeSession(wallet) {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ w: wallet, exp }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return { token: payload + '.' + sig, exp };
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expect);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.w || !data.exp || Date.now() > data.exp) return null;
    return data.w;
  } catch (_) {
    return null;
  }
}

function login(wallet, signatureB58OrB64, message) {
  const entry = nonces.get(wallet);
  if (!entry || Date.now() > entry.exp) throw new Error('Nonce expired — request a new one');
  if (!message || !message.includes(entry.nonce) || !message.includes(wallet)) {
    throw new Error('Message does not match issued nonce');
  }
  let sigBuf;
  try {
    sigBuf = b58decode(signatureB58OrB64);
  } catch (_) {
    sigBuf = Buffer.from(signatureB58OrB64, 'base64');
  }
  const pub = b58decode(wallet);
  const msgBuf = Buffer.from(message, 'utf8');
  if (!ed25519Verify(msgBuf, sigBuf, pub)) {
    throw new Error('Invalid wallet signature');
  }
  nonces.delete(wallet);
  const session = makeSession(wallet);
  return { ...session, purchases: purchasesOf(wallet) };
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return j.result;
}

/**
 * Verify a confirmed SystemProgram transfer from `wallet` → MERCHANT for >= minLamports.
 */
async function verifyTransfer(signature, wallet, minLamports) {
  if (MOCK_VERIFY && typeof signature === 'string' && signature.startsWith('mock:')) {
    if (store.usedSignatures[signature]) {
      const owner = store.usedSignatures[signature];
      if (owner !== wallet) throw new Error('Transaction already claimed by another wallet');
      return { already: true, lamports: minLamports };
    }
    return { already: false, lamports: minLamports, mock: true };
  }
  if (store.usedSignatures[signature]) {
    const owner = store.usedSignatures[signature];
    if (owner !== wallet) throw new Error('Transaction already claimed by another wallet');
    return { already: true };
  }
  let tx = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    tx = await rpc('getTransaction', [
      signature,
      { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
    ]);
    if (tx) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!tx) throw new Error('Transaction not found on-chain yet — retry in a few seconds');
  if (tx.meta && tx.meta.err) throw new Error('Transaction failed on-chain');

  const message = tx.transaction && tx.transaction.message;
  if (!message) throw new Error('Malformed transaction');
  const accountKeys = (message.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const fromIdx = accountKeys.indexOf(wallet);
  const toIdx = accountKeys.indexOf(MERCHANT);
  if (fromIdx < 0) throw new Error('Signed-in wallet is not the transaction fee payer / signer');
  if (toIdx < 0) throw new Error('Merchant wallet is not a transaction account');

  // Prefer balance delta (robust across instruction layouts)
  const pre = tx.meta && tx.meta.preBalances;
  const post = tx.meta && tx.meta.postBalances;
  if (!pre || !post || pre[toIdx] == null || post[toIdx] == null) {
    throw new Error('Missing balance metadata');
  }
  const credited = post[toIdx] - pre[toIdx];
  if (credited < minLamports) {
    throw new Error(`Insufficient transfer: got ${credited} lamports, need >= ${minLamports}`);
  }
  // Debit from payer (allow fees)
  const debited = pre[fromIdx] - post[fromIdx];
  if (debited < minLamports) {
    throw new Error('Payer did not fund the transfer');
  }
  return { credited, already: false };
}

function claimCar(wallet, carId, signature) {
  const def = CATALOG.car[carId];
  if (!def) throw new Error('Unknown car');
  return verifyTransfer(signature, wallet, def.minLamports).then((v) => {
    const w = walletRec(wallet);
    if (v.already && w.cars.includes(carId)) {
      return purchasesOf(wallet);
    }
    if (!w.cars.includes(carId)) w.cars.push(carId);
    w.txs[signature] = { kind: 'car', id: carId, amountSol: def.minLamports / LAMPORTS_PER_SOL, at: Date.now() };
    store.usedSignatures[signature] = wallet;
    saveStore(store);
    return purchasesOf(wallet);
  });
}

function claimUpgrade(wallet, upgradeId, level, signature) {
  const def = CATALOG.upgrade[upgradeId];
  if (!def) throw new Error('Unknown upgrade');
  const lvl = Number(level);
  const sol = def.levels[lvl];
  if (sol == null) throw new Error('Invalid upgrade level');
  const minLamports = Math.round(sol * LAMPORTS_PER_SOL);
  return verifyTransfer(signature, wallet, minLamports).then((v) => {
    const w = walletRec(wallet);
    if (v.already && (w.upgrades[upgradeId] || 0) >= lvl) {
      return purchasesOf(wallet);
    }
    w.upgrades[upgradeId] = Math.max(w.upgrades[upgradeId] || 0, lvl);
    w.txs[signature] = { kind: 'upgrade', id: upgradeId, level: lvl, amountSol: sol, at: Date.now() };
    store.usedSignatures[signature] = wallet;
    saveStore(store);
    return purchasesOf(wallet);
  });
}


function claimPet(wallet, petId, signature) {
  const def = CATALOG.pet && CATALOG.pet[petId];
  if (!def) throw new Error('Unknown pet');
  return verifyTransfer(signature, wallet, def.minLamports).then((v) => {
    const w = walletRec(wallet);
    if (v.already && w.pets.includes(petId)) {
      return purchasesOf(wallet);
    }
    if (!w.pets.includes(petId)) w.pets.push(petId);
    if (!w.equippedPet) w.equippedPet = petId;
    w.txs[signature] = { kind: 'pet', id: petId, amountSol: def.minLamports / LAMPORTS_PER_SOL, at: Date.now() };
    store.usedSignatures[signature] = wallet;
    saveStore(store);
    return purchasesOf(wallet);
  });
}

function setEquippedPet(wallet, petId) {
  const w = walletRec(wallet);
  if (!petId) {
    w.equippedPet = null;
  } else {
    if (!w.pets.includes(petId)) throw new Error('Pet not owned');
    w.equippedPet = petId;
  }
  saveStore(store);
  return purchasesOf(wallet);
}

function ownsPet(wallet, petId) {
  if (!wallet) return false;
  return walletRec(wallet).pets.includes(petId);
}

function ownsCar(wallet, carId) {
  if (!wallet) return carId === 'starter';
  return walletRec(wallet).cars.includes(carId);
}

function storageInfo() {
  return {
    dataDir: DATA_DIR,
    diskOk,
    persistent: diskOk,
    storePath: STORE_PATH,
    exists: fs.existsSync(STORE_PATH),
    merchant: MERCHANT,
    bossCarId: BOSS_CAR_ID,
    bossPriceSol: BOSS_PRICE_SOL,
    petKittenId: PET_KITTEN_ID,
    petKittenPriceSol: PET_KITTEN_PRICE_SOL,
    walletCount: Object.keys(store.wallets).length
  };
}


const HRD_MINT = process.env.HRD_MINT || 'EPkpr81p71DZYypxrFqZh69x1s2mNkHm4Jy8UGPLpump';
const HRD_DECIMALS = Number(process.env.HRD_DECIMALS || 6);
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** $HRD catalog — amounts in whole tokens (ui). Cosmetics / upgrades only. */
const HRD_CATALOG = {
  cosmetic: {
    paint_lava: { hrd: 150000, label: 'Lava Reactive Paint' },
    paint_volt: { hrd: 150000, label: 'Volt Reactive Paint' },
    aura_lightning: { hrd: 100000, label: 'Anime Lightning Aura' },
    aura_fireworks: { hrd: 100000, label: 'Fireworks Aura' },
    aura_neon: { hrd: 100000, label: 'Neon Light Trails' },
    trail_sakura: { hrd: 75000, label: 'Sakura Trail' }
  },
  upgrade: {
    Engine_Stage_1: { hrd: 50000, applies: { engine: 1 } },
    Engine_Stage_2: { hrd: 120000, applies: { engine: 2 } },
    Tires_Drift_Spec: { hrd: 80000, applies: { tires: 1 } },
    Spoiler_Carbon_V2: { hrd: 60000, applies: { suspension: 1 } },
    N2O_Bottle: { hrd: 90000, applies: { turbo: 1 } },
    Brake_Kit_Pro: { hrd: 70000, applies: { brakes: 1 } }
  },
  prizeEntry: { hrd: 25000, label: 'Cosmetic Cup Entry' }
};

/**
 * Verify Token-2022 transferChecked of $HRD from wallet → treasury (MERCHANT).
 * Uses token balance deltas on parsed tx when available; falls back to pre/post token balances.
 */
async function verifyHrdTransfer(signature, wallet, minRawAmount) {
  if (MOCK_VERIFY && typeof signature === 'string' && signature.startsWith('mock:')) {
    if (store.usedSignatures[signature]) {
      const owner = store.usedSignatures[signature];
      if (owner !== wallet) throw new Error('Transaction already claimed by another wallet');
      return { already: true, credited: minRawAmount };
    }
    return { already: false, credited: minRawAmount, mock: true };
  }
  if (store.usedSignatures[signature]) {
    const owner = store.usedSignatures[signature];
    if (owner !== wallet) throw new Error('Transaction already claimed by another wallet');
    return { already: true };
  }
  let tx = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    tx = await rpc('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
    ]);
    if (tx) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!tx) throw new Error('Transaction not found on-chain yet — retry in a few seconds');
  if (tx.meta && tx.meta.err) throw new Error('Transaction failed on-chain');

  // Prefer token balance deltas (works for SPL Token and Token-2022 ATAs)

  // Token-2022 ATAs: pre/postTokenBalances include mint+owner for TokenzQd… accounts.
  // Prefer owner-matched treasury delta; already handled above via amountFor(MERCHANT).
  const pre = (tx.meta && tx.meta.preTokenBalances) || [];
  const post = (tx.meta && tx.meta.postTokenBalances) || [];
  function amountFor(list, owner) {
    let n = 0n;
    for (const b of list) {
      if (b.mint !== HRD_MINT) continue;
      if (b.owner && b.owner !== owner) continue;
      const a = b.uiTokenAmount && b.uiTokenAmount.amount;
      if (a != null) n += BigInt(a);
    }
    return n;
  }
  const preT = amountFor(pre, MERCHANT);
  const postT = amountFor(post, MERCHANT);
  let credited = postT - preT;
  // If owner field missing, sum any HRD mint increase
  if (credited <= 0n) {
    const sum = (list) => list.filter((b) => b.mint === HRD_MINT).reduce((a, b) => a + BigInt((b.uiTokenAmount && b.uiTokenAmount.amount) || 0), 0n);
    credited = sum(post) - sum(pre);
  }
  if (credited < BigInt(minRawAmount)) {
    throw new Error(`Insufficient $HRD transfer: got ${credited}, need >= ${minRawAmount}`);
  }
  // Ensure fee payer / signer is wallet
  const message = tx.transaction && tx.transaction.message;
  const accountKeys = (message.accountKeys || []).map((k) => (typeof k === 'string' ? k : (k.pubkey || k)));
  if (accountKeys[0] && accountKeys[0] !== wallet && !accountKeys.includes(wallet)) {
    throw new Error('Signed-in wallet is not a transaction signer');
  }
  return { credited: Number(credited), already: false };
}

function claimHrdCosmetic(wallet, cosmeticId, signature) {
  const def = HRD_CATALOG.cosmetic[cosmeticId];
  if (!def) throw new Error('Unknown cosmetic');
  const raw = Math.round(def.hrd * Math.pow(10, HRD_DECIMALS));
  return verifyHrdTransfer(signature, wallet, raw).then((v) => {
    const w = walletRec(wallet);
    if (v.already && w.cosmetics.includes(cosmeticId)) return purchasesOf(wallet);
    if (!w.cosmetics.includes(cosmeticId)) w.cosmetics.push(cosmeticId);
    w.txs[signature] = { kind: 'hrd-cosmetic', id: cosmeticId, amountHrd: def.hrd, at: Date.now() };
    store.usedSignatures[signature] = wallet;
    saveStore(store);
    return purchasesOf(wallet);
  });
}

function claimHrdUpgrade(wallet, upgradeId, signature) {
  const def = HRD_CATALOG.upgrade[upgradeId];
  if (!def) throw new Error('Unknown $HRD upgrade');
  const raw = Math.round(def.hrd * Math.pow(10, HRD_DECIMALS));
  return verifyHrdTransfer(signature, wallet, raw).then((v) => {
    const w = walletRec(wallet);
    if (v.already && w.hrdUpgrades[upgradeId]) return purchasesOf(wallet);
    w.hrdUpgrades[upgradeId] = true;
    Object.keys(def.applies || {}).forEach((k) => {
      w.upgrades[k] = Math.max(w.upgrades[k] || 0, def.applies[k]);
    });
    w.txs[signature] = { kind: 'hrd-upgrade', id: upgradeId, amountHrd: def.hrd, at: Date.now() };
    store.usedSignatures[signature] = wallet;
    saveStore(store);
    return purchasesOf(wallet);
  });
}

function claimHrdPrizeEntry(wallet, signature) {
  const def = HRD_CATALOG.prizeEntry;
  const raw = Math.round(def.hrd * Math.pow(10, HRD_DECIMALS));
  return verifyHrdTransfer(signature, wallet, raw).then((v) => {
    const w = walletRec(wallet);
    w.txs[signature] = { kind: 'hrd-prize-entry', amountHrd: def.hrd, at: Date.now() };
    if (!v.already) store.usedSignatures[signature] = wallet;
    saveStore(store);
    return purchasesOf(wallet);
  });
}


module.exports = {
  BOSS_CAR_ID,
  PET_KITTEN_ID,
  issueNonce,
  login,
  verifySession,
  purchasesOf,
  claimCar,
  claimUpgrade,
  claimPet,
  setEquippedPet,
  ownsCar,
  ownsPet,
  storageInfo,
  CATALOG,
  HRD_CATALOG,
  HRD_MINT,
  claimHrdCosmetic,
  claimHrdUpgrade,
  claimHrdPrizeEntry,
  reload() { store = loadStore(); }
};
