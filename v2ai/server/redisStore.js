// server/redisStore.js
const Redis = require('ioredis');

const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',  // docker service name
  port: process.env.REDIS_PORT || 6379,
  retryStrategy: (times) => Math.min(times * 100, 3000), // reconnect backoff
  lazyConnect: false,
});

redis.on('connect',  () => console.log('✅ Redis connected'));
redis.on('error',   (e) => console.error('❌ Redis error:', e.message));

// ─── KEY SCHEMA ───────────────────────────────────────────────
// room:{roomId}:peers       → Set of peerIds
// room:{roomId}:producers   → Hash  producerId → JSON{peerId, kind}
// room:{roomId}:mute        → Hash  peerId     → JSON{muted, videoOff}
// room:{roomId}:messages    → List  of JSON chat messages (capped at 200)
// room:{roomId}:meta        → Hash  createdAt, workerIndex
// All keys expire after 2 hours of no activity (TTL refreshed on each write)

const ROOM_TTL = 60 * 60 * 2; // 2 hours in seconds

function roomKey(roomId, suffix) {
  return `room:${roomId}:${suffix}`;
}

// ─── PEERS ────────────────────────────────────────────────────

async function addPeer(roomId, peerId) {
  const key = roomKey(roomId, 'peers');
  await redis.sadd(key, peerId);
  await redis.expire(key, ROOM_TTL);
}

async function removePeer(roomId, peerId) {
  await redis.srem(roomKey(roomId, 'peers'), peerId);
}

async function getPeers(roomId) {
  return redis.smembers(roomKey(roomId, 'peers')); // returns string[]
}

// ─── MUTE / VIDEO STATE ───────────────────────────────────────

async function setMuteState(roomId, peerId, state) {
  // state = { muted: bool, videoOff: bool }
  const key = roomKey(roomId, 'mute');
  await redis.hset(key, peerId, JSON.stringify(state));
  await redis.expire(key, ROOM_TTL);
}

async function getMuteStates(roomId) {
  const raw = await redis.hgetall(roomKey(roomId, 'mute')); // { peerId: jsonString }
  const result = {};
  for (const [peerId, val] of Object.entries(raw || {})) {
    try { result[peerId] = JSON.parse(val); } catch {}
  }
  return result;
}

async function removeMuteState(roomId, peerId) {
  await redis.hdel(roomKey(roomId, 'mute'), peerId);
}

// ─── PRODUCERS ───────────────────────────────────────────────

async function addProducer(roomId, producerId, peerId, kind) {
  const key = roomKey(roomId, 'producers');
  await redis.hset(key, producerId, JSON.stringify({ peerId, kind }));
  await redis.expire(key, ROOM_TTL);
}

async function removeProducersByPeer(roomId, peerId) {
  const key = roomKey(roomId, 'producers');
  const all = await redis.hgetall(key); // { producerId: jsonString }
  for (const [producerId, val] of Object.entries(all || {})) {
    try {
      const entry = JSON.parse(val);
      if (entry.peerId === peerId) await redis.hdel(key, producerId);
    } catch {}
  }
}

async function getProducers(roomId) {
  const raw = await redis.hgetall(roomKey(roomId, 'producers'));
  const result = {};
  for (const [producerId, val] of Object.entries(raw || {})) {
    try { result[producerId] = JSON.parse(val); } catch {}
  }
  return result; // { producerId: { peerId, kind } }
}

// ─── MESSAGES (chat history) ──────────────────────────────────

async function pushMessage(roomId, message) {
  const key = roomKey(roomId, 'messages');
  await redis.rpush(key, JSON.stringify(message));
  await redis.ltrim(key, -200, -1); // keep last 200 messages only
  await redis.expire(key, ROOM_TTL);
}

async function getMessages(roomId) {
  const raw = await redis.lrange(roomKey(roomId, 'messages'), 0, -1);
  return raw.map(m => { try { return JSON.parse(m); } catch { return null; } }).filter(Boolean);
}

// ─── ROOM META ────────────────────────────────────────────────

async function setRoomMeta(roomId, meta) {
  // meta = { createdAt, workerIndex }
  const key = roomKey(roomId, 'meta');
  await redis.hset(key, 'data', JSON.stringify(meta));
  await redis.expire(key, ROOM_TTL);
}

async function getRoomMeta(roomId) {
  const raw = await redis.hget(roomKey(roomId, 'meta'), 'data');
  try { return JSON.parse(raw); } catch { return null; }
}

// ─── FULL ROOM STATE (for state-sync on join) ─────────────────

async function getRoomState(roomId) {
  const [peers, muteStates, producers, messages] = await Promise.all([
    getPeers(roomId),
    getMuteStates(roomId),
    getProducers(roomId),
    getMessages(roomId),
  ]);
  return { peers, muteStates, producers, messages };
}

// ─── CLEANUP (when room is deleted) ──────────────────────────

async function setScreenSharer(roomId, peerId, active) {
  const key = roomKey(roomId, 'screensharers');
  if (active) {
    await redis.sadd(key, peerId);
  } else {
    await redis.srem(key, peerId);
  }
  await redis.expire(key, ROOM_TTL);
}

async function getScreenSharers(roomId) {
  return redis.smembers(roomKey(roomId, 'screensharers'));
}

async function getAllRoomIds() {
  const keys = await redis.keys('room:*:meta');
  return keys.map(k => k.split(':')[1]);
}

async function deleteRoom(roomId) {
  const keys = [
    roomKey(roomId, 'peers'),
    roomKey(roomId, 'mute'),
    roomKey(roomId, 'producers'),
    roomKey(roomId, 'messages'),
    roomKey(roomId, 'meta'),
    roomKey(roomId, 'screensharers'),
  ];
  if (keys.length) await redis.del(...keys);
  console.log(`🗑  Redis: cleaned room ${roomId}`);
}

async function clearPeers(roomId) {
  // Atomically wipe peer list and producer list for a room.
  // Called on server startup — mediasoup state is gone, these are stale.
  await redis.del(roomKey(roomId, 'peers'));
  await redis.del(roomKey(roomId, 'producers'));
  console.log(`🧹 Redis: cleared stale peers+producers for room ${roomId}`);
}


module.exports = {
  redis,              // raw client (for admin inspection)
  addPeer,
  removePeer,
  getPeers,
  setMuteState,
  getMuteStates,
  removeMuteState,
  addProducer,
  removeProducersByPeer,
  getProducers,
  pushMessage,
  getMessages,
  setRoomMeta,
  getRoomMeta,
  getRoomState,
  deleteRoom,
  setScreenSharer,
  getScreenSharers,
  getAllRoomIds,
  clearPeers,  
};