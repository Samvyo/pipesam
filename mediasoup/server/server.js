const express = require('express');
const pino = require('pino');
const logger = pino({ level: 'info' });
const https = require('https'); 
const fs = require('fs');  
const WebSocket = require('ws');
const path = require('path');  
const { spawn } = require('child_process'); 

const app = express();  
const cors = require("cors");
app.use(cors()); 
app.use(express.json());      

const jwt = require("jsonwebtoken");

const mediasoup = require("mediasoup");
const workers = new Map();
// let plainTransportPort = 42000;

const JWT_SECRET = "mysecretkey"; // use env later
// Serve client folder (correct path)
app.use(express.static(path.join(__dirname, '../client')));

// Root route
app.get("/token", (req, res) => {
  const { username,roomId } = req.query;

  if (!username || !roomId) {
    return res.status(400).json({ error: "username and roomIdrequired" });
  }

  const token = jwt.sign(
    { 
      username, 
      roomId: String(roomId)  
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token });
});

app.get('/admin/consumers', (req, res) => {
  const result = [];
  for (const [roomId, room] of rooms) {
    if (!room.consumers) continue;
    for (const [consumerId, consumer] of room.consumers) {
      result.push({
        roomId,
        consumerId,
        consumingPeerId: consumer.appData?.consumingPeerId || 'unknown',
        producerPeerId:  consumer.appData?.peerId          || 'unknown',
        kind:            consumer.kind,
        preferredLayers: consumer.preferredLayers || null,
        currentLayers:   consumer.currentLayers   || null,
        score:           consumer.score           || null,
      });
    }
  }
  res.json(result);
});

app.post('/admin/set-layers', async (req, res) => {
  const { roomId, consumerId, spatialLayer, temporalLayer } = req.body;
  if (!roomId || !consumerId || spatialLayer === undefined)
    return res.status(400).json({ error: 'roomId, consumerId and spatialLayer required' });

  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const consumer = room.consumers?.get(consumerId);
  if (!consumer) return res.status(404).json({ error: 'Consumer not found' });
  if (consumer.kind !== 'video')
    return res.status(400).json({ error: 'Only video consumers have simulcast layers' });

  await consumer.setPreferredLayers({
    spatialLayer:  Number(spatialLayer),
    temporalLayer: temporalLayer !== undefined ? Number(temporalLayer) : Number(spatialLayer)
  });

  res.json({ ok: true, consumerId, spatialLayer, temporalLayer });
});

// server/index.js — after POST /admin/set-layers

app.post('/admin/start-recording', async (req, res) => {
  const { roomId, producerId } = req.body;
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  try {
    await startRecording(room, producerId);
    res.json({ ok: true });
  } catch (e) {
    // ← NOW Postman shows the actual error instead of crashing silently
    res.status(400).json({ error: e.message });
  }
});

app.post('/admin/stop-recording', (req, res) => {
  const { roomId } = req.body;
  const room = rooms.get(roomId);
  if (!room?.ffmpegProcess) return res.status(404).json({ error: 'No recording' });

  room.ffmpegProcess.kill('SIGINT');
  room.ffmpegProcess = null;

  try { room.recordingConsumer?.close(); } catch(e) {}
  room.recordingConsumer = null;

  try { room.recordingTransport?.close(); } catch(e) {}
  room.recordingTransport = null;

  // ── NEW: audio cleanup ──────────────────────────────────────────
  try { room.recordingAudioConsumer?.close(); } catch(e) {}
  room.recordingAudioConsumer = null;

  try { room.recordingAudioTransport?.close(); } catch(e) {}
  room.recordingAudioTransport = null;

  res.json({ ok: true });
});

// server/index.js — after GET /admin/consumers

app.get('/stats', async (req, res) => {
  const result = {};

  for (const [roomId, room] of rooms) {
    result[roomId] = {
      router: {},
      transports: [],
      consumers: [],
      producers: []
    };

    // ── Router stats ──────────────────────────────────────────────
    // router doesn't have a getStats() but we can expose its dump
    try {
      result[roomId].router = await room.router.dump();
    } catch (e) {
      result[roomId].router = { error: e.message };
    }

    // ── Transport stats ───────────────────────────────────────────
    for (const [peerId, peerData] of room.peersData) {
      for (const dir of ['sendTransport', 'recvTransport']) {
        const transport = peerData[dir];
        if (!transport) continue;
        try {
          const stats = await transport.getStats(); // returns array of stat objects
          result[roomId].transports.push({
            peerId,
            direction: dir,
            transportId: transport.id,
            stats
          });
        } catch (e) {}
      }
    }

    // ── Consumer stats ────────────────────────────────────────────
    if (room.consumers) {
      for (const [consumerId, consumer] of room.consumers) {
        try {
          const stats = await consumer.getStats();
          result[roomId].consumers.push({
            consumerId,
            kind: consumer.kind,
            producerPeerId:  consumer.appData?.peerId,
            consumingPeerId: consumer.appData?.consumingPeerId,
            currentLayers:   consumer.currentLayers,
            preferredLayers: consumer.preferredLayers,
            score:           consumer.score,
            stats
          });
        } catch (e) {}
      }
    }

    // ── Producer stats ────────────────────────────────────────────
    if (room.producers) {
      for (const [producerId, { producer, peerId }] of room.producers) {
        try {
          const stats = await producer.getStats();
          result[roomId].producers.push({
            producerId,
            peerId,
            kind: producer.kind,
            stats
          });
        } catch (e) {}
      }
    }
  }

  res.json(result);
});

const sslOptions = {
  key:  fs.readFileSync(path.join(__dirname, '../certs/key.pem')),
  cert: fs.readFileSync(path.join(__dirname, '../certs/cert.pem')),
};

// Create HTTPS server
const server = https.createServer(sslOptions, app);

// Attach WebSocket
const wss = new WebSocket.Server({ noServer: true });

// Listen
(async () => {
  await createWorker();
  server.listen(3000, '0.0.0.0', () => {
    console.log("Server running on http://0.0.0.0:3000");
  });
})();

async function createWorker() {
  const worker = await mediasoup.createWorker({
    logLevel: "warn",           // only show warnings, not debug spam
    rtcMinPort: 40000,          // port range for media traffic
    rtcMaxPort: 49999,
  });
  workers.set("worker-1", worker);
  console.log("Mediasoup Worker created");

  worker.on("died", () => {
    console.error("Worker died");
    process.exit(1);
  });
}


class Room {
  constructor(roomId) {
    this.roomId = roomId;
    this.peers = new Map();
    this.sessions = new Map();
    this.messages = [];
    this.recentlyDisconnected = new Map(); // track recent disconnects
    this.muteStates = new Map(); 
    this.screenSharers = {}; 
    this.router = null;
    this.peersData = new Map();
    
    this.dataProducers = new Map();
    this.dataConsumers = new Map();
    this.producers = new Map();
    this.peerProducers = new Map();
    this.consumers = new Map();
  }

  addPeer(peerId, ws) {
    const sessionId = Date.now() + '-' + Math.random();
    ws.sessionId = sessionId;
    let isRecovering = this.peers.has(peerId);

    // handle refresh recovery window
    const lastLeft = this.recentlyDisconnected.get(peerId);
    if (lastLeft && Date.now() - lastLeft < 10000) {
      isRecovering = true;
      this.recentlyDisconnected.delete(peerId);
    }

    this.peers.set(peerId, ws);
    this.sessions.set(peerId, sessionId);

    return isRecovering;
  }

  isCurrentSocket(peerId, ws) {
    return this.sessions.get(peerId) === ws.sessionId;
  }

  removePeer(peerId) {
    this.peers.delete(peerId);
    this.sessions.delete(peerId);
    this.muteStates.delete(peerId);
    delete this.screenSharers[peerId];

    // 🔥 CLEAN DATA PRODUCERS
    for (const [id, entry] of this.dataProducers) {
      if (entry.peerId === peerId) {
        this.dataProducers.delete(id);
      }
    }

    // 🔥 CLEAN DATA CONSUMERS
    for (const [id, consumer] of this.dataConsumers) {
      if (consumer.appData?.peerId === peerId) {
        this.dataConsumers.delete(id);
      }
    }

    this.recentlyDisconnected.set(peerId, Date.now());
  }

  listPeers() {
    return Array.from(this.peers.keys());
  }

  broadcast(message, senderPeerId) {
    this.messages.push(message);

    this.peers.forEach((client, peerId) => {
      if (peerId !== senderPeerId && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  }

  sendTo(targetPeerId, message) {
    const ws = this.peers.get(targetPeerId);
 
    if (!ws) {
      logger.warn({ targetPeerId }, 'sendTo: peer not found');
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      logger.warn({ targetPeerId }, 'sendTo: socket not open');
    }
  }
}

const rooms = new Map();

async function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    const room = new Room(roomId);

    // get the worker we created at startup
    const worker = workers.get("worker-1");

    // create router for this room
    // router needs to know which codecs (video/audio formats) it supports
    room.router = await worker.createRouter({
      mediaCodecs: [
        {
          kind: "audio",
          mimeType: "audio/opus",  // standard audio codec for WebRTC
          clockRate: 48000,        // 48kHz sample rate
          channels: 2              // stereo
        },
        {
          kind: "video",
          mimeType: "video/VP8",   // standard video codec for WebRTC
          clockRate: 90000         // standard video clock rate
        }
      ]
    });

    console.log(`✅ Router created for room: ${roomId}`);
    rooms.set(roomId, room);
  }
  return rooms.get(roomId);
}

server.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get('token');

    console.log("Upgrade request:", request.url);
    console.log("Token:", token);

    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    request.user = decoded;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });

  } catch (err) {
    console.log("Upgrade error:", err.message);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

// server/index.js — REPLACE your existing attachAdaptiveLayerSwitching

const SCORE_LOW_THRESHOLD  = 5;
const SCORE_HIGH_THRESHOLD = 8;
const UPGRADE_COOLDOWN_MS  = 8000;

function attachAdaptiveLayerSwitching(consumer, room) { 
  if (consumer.kind !== 'video') return;

  consumer._lastUpgrade = 0;
  consumer._audioPaused = false; // track our own pause state
  consumer._currentSpatialLayer = 0;

  consumer.on('score', async (scoreEvent) => {
    const score = scoreEvent.score;
    const current = consumer._currentSpatialLayer;

    // ── EXISTING: downgrade/upgrade spatial layer ──────────────────
    if (score < SCORE_LOW_THRESHOLD && current > 0) {
      const next = current - 1;
      try {
        await consumer.setPreferredLayers({ spatialLayer: next, temporalLayer: next });
        consumer._currentSpatialLayer = next;
        console.log(`📉 [adaptive] score=${score} → downgrade spatial ${current}→${next}`);
      } catch (e) { console.warn('adaptive downgrade failed:', e.message); }
    } else if (score >= SCORE_HIGH_THRESHOLD && current < 2) {
      const now = Date.now();
      if (now - consumer._lastUpgrade < UPGRADE_COOLDOWN_MS) return;
      const next = current + 1;
      try {
        await consumer.setPreferredLayers({ spatialLayer: next, temporalLayer: next });
        consumer._currentSpatialLayer = next; 
        consumer._lastUpgrade = now;
        console.log(`📈 [adaptive] score=${score} → upgrade spatial ${current}→${next}`);
      } catch (e) { console.warn('adaptive upgrade failed:', e.message); }
    }

    // ── NEW: audio-only fallback ───────────────────────────────────
    if (score < SCORE_LOW_THRESHOLD && !consumer._audioPaused) {
      try {
        await consumer.pause(); // pause THIS video consumer
        consumer._audioPaused = true;
        console.log(`🔇 [audio-fallback] score=${score} → video paused for consumer ${consumer.id}`);

        // Tell the browser this consumer is paused so it can show UI
        const consumingPeerId = consumer.appData?.consumingPeerId;
        const targetSocket = room?.peers.get(consumingPeerId);
        targetSocket?.send(JSON.stringify({
          type: 'video-paused',
          consumerId: consumer.id,
          reason: 'low-bandwidth'
        }));
      } catch (e) { console.warn('audio fallback pause failed:', e.message); }

    } else if (score >= SCORE_HIGH_THRESHOLD && consumer._audioPaused) {
      try {
        await consumer.resume(); // restore video when connection improves
        consumer._audioPaused = false;
        console.log(`▶️  [audio-fallback] score=${score} → video resumed for consumer ${consumer.id}`);

        const consumingPeerId = consumer.appData?.consumingPeerId;
        const targetSocket = room?.peers.get(consumingPeerId);
        targetSocket?.send(JSON.stringify({
          type: 'video-resumed',
          consumerId: consumer.id
        }));
      } catch (e) { console.warn('audio fallback resume failed:', e.message); }
    }
  });
}

async function startRecording(room, producerId) {
  // ── Full cleanup first ───────────────────────────────────────────
  if (room.recordingConsumer) {
    try { room.recordingConsumer.close(); } catch(e) {}
    room.recordingConsumer = null;
  }
  if (room.recordingAudioConsumer) {
    try { room.recordingAudioConsumer.close(); } catch(e) {}
    room.recordingAudioConsumer = null;
  }
  if (room.recordingTransport) {
    try { room.recordingTransport.close(); } catch(e) {}
    room.recordingTransport = null;
  }
  if (room.recordingAudioTransport) {
    try { room.recordingAudioTransport.close(); } catch(e) {}
    room.recordingAudioTransport = null;
  }
  if (room.ffmpegProcess) {
    room.ffmpegProcess.kill('SIGINT');
    await new Promise(r => setTimeout(r, 500));
    room.ffmpegProcess = null;
  }

  // ── Find video producer ──────────────────────────────────────────
  const videoProducerEntry = room.producers.get(producerId);
  if (!videoProducerEntry) {
    throw new Error(`Producer not found: ${producerId}`);
  }
  const videoProducer = videoProducerEntry.producer;
  const ownerPeerId   = videoProducerEntry.peerId;

  // ── Find matching audio producer from same peer ──────────────────
  let audioProducer = null;
  for (const [, entry] of room.producers) {
    if (entry.peerId === ownerPeerId && entry.kind === 'audio') {
      audioProducer = entry.producer;
      break;
    }
  }

  // ── VIDEO plain transport ────────────────────────────────────────
  const videoPlainTransport = await room.router.createPlainTransport({
    listenIp: { ip: '127.0.0.1' },
    rtcpMux:  true,
    comedia:  false,
  });

  const ffmpegVideoPort = Math.floor(Math.random() * 1000) + 50000;
  await videoPlainTransport.connect({ ip: '127.0.0.1', port: ffmpegVideoPort });

  const videoConsumer = await videoPlainTransport.consume({
    producerId:      videoProducer.id,
    rtpCapabilities: room.router.rtpCapabilities,
    paused:          true,
  });

  const videoPT   = videoConsumer.rtpParameters.codecs[0].payloadType;
  const videoSSRC = videoConsumer.rtpParameters.encodings[0].ssrc;

  // ── AUDIO plain transport (separate transport required) ──────────
  let audioPT, audioSSRC, ffmpegAudioPort, audioConsumer, audioPlainTransport;
  let hasAudio = false;

  if (audioProducer) {
    audioPlainTransport = await room.router.createPlainTransport({
      listenIp: { ip: '127.0.0.1' },
      rtcpMux:  true,
      comedia:  false,
    });

    ffmpegAudioPort = Math.floor(Math.random() * 1000) + 51000; // different range
    await audioPlainTransport.connect({ ip: '127.0.0.1', port: ffmpegAudioPort });

    audioConsumer = await audioPlainTransport.consume({
      producerId:      audioProducer.id,
      rtpCapabilities: room.router.rtpCapabilities,
      paused:          true,
    });

    audioPT   = audioConsumer.rtpParameters.codecs[0].payloadType;
    audioSSRC = audioConsumer.rtpParameters.encodings[0].ssrc;
    hasAudio  = true;

    console.log(`🎤 Audio consumer ready pt=${audioPT} ssrc=${audioSSRC} → ffmpeg port ${ffmpegAudioPort}`);
  } else {
    console.warn(`⚠️ No audio producer found for peer ${ownerPeerId} — recording video only`);
  }

  // ── Build SDP ────────────────────────────────────────────────────
  const sdpLines = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=mediasoup',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    // video
    `m=video ${ffmpegVideoPort} RTP/AVP ${videoPT}`,
    `a=rtpmap:${videoPT} VP8/90000`,
    `a=ssrc:${videoSSRC} cname:mediasoup`,
    'a=recvonly',
  ];

  if (hasAudio) {
    sdpLines.push(
      // audio
      `m=audio ${ffmpegAudioPort} RTP/AVP ${audioPT}`,
      `a=rtpmap:${audioPT} opus/48000/2`,
      `a=fmtp:${audioPT} minptime=10;useinbandfec=1`,
      `a=ssrc:${audioSSRC} cname:mediasoup`,
      'a=recvonly',
    );
  }

  sdpLines.push(''); // trailing newline
  const sdp = sdpLines.join('\r\n');

  const sdpPath  = `/tmp/rec-${room.roomId}-${Date.now()}.sdp`;
  const filename = `/app/recordings/recording-${room.roomId}-${Date.now()}.webm`;
  fs.writeFileSync(sdpPath, sdp);

  // ── Spawn ffmpeg ─────────────────────────────────────────────────
  // -map 0:v and -map 0:a select video and audio from the single SDP input.
  // If audio is present ffmpeg muxes both; if not it just records video.
  const ffmpegArgs = [
    '-protocol_whitelist', 'file,rtp,udp',
    '-i', sdpPath,
  ];

  if (hasAudio) {
    ffmpegArgs.push(
      '-map', '0:v',
      '-map', '0:a',
      '-c:v', 'copy',
      '-c:a', 'libopus',  // re-encode opus→opus for webm container
    );
  } else {
    ffmpegArgs.push('-c:v', 'copy');
  }

  ffmpegArgs.push('-f', 'webm', filename);

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  ffmpeg.stderr.on('data', d => console.log('[ffmpeg]', d.toString()));
  ffmpeg.on('close', code => console.log(`ffmpeg exited: ${code}, file: ${filename}`));

  // Give ffmpeg time to bind ports before mediasoup starts sending
  await new Promise(resolve => setTimeout(resolve, 1000));

  // ── Resume consumers (start RTP flow) ───────────────────────────
  await videoConsumer.resume();
  if (hasAudio) await audioConsumer.resume();

  console.log(`✅ Recording started (${hasAudio ? 'video+audio' : 'video only'}): ${filename}`);

  // ── Store on room for cleanup ────────────────────────────────────
  room.ffmpegProcess            = ffmpeg;
  room.recordingTransport       = videoPlainTransport;
  room.recordingConsumer        = videoConsumer;
  room.recordingAudioTransport  = audioPlainTransport || null;
  room.recordingAudioConsumer   = audioConsumer       || null;
}

wss.on('connection', (ws, req) => {
  logger.info("New socket connected");

  ws.user = req.user; // already verified

  console.log("✅ Auth success:", ws.user.username);


  ws.on('message', async (raw) => {
    console.log("Incoming message:", raw.toString()); 

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // ✅ NEW: HANDLE RTP CAPABILITIES FIRST
    // CURRENT (3 lines):

// REPLACE WITH:
if (data.type === 'rtp-capabilities') {
  ws.rtpCapabilities = data.rtpCapabilities;
  console.log(`✅ Stored rtpCapabilities for ${ws.peerId}`);

  // // Handle the race: if produce already ran before rtp-capabilities arrived,
  // // the reverse consumer block was skipped. Catch up now.
  // const room = rooms.get(ws.roomId);
  // if (!room) return;

  // const recvTransport = room.peersData.get(ws.peerId)?.recvTransport;
  // if (!recvTransport) return; // recv transport not ready yet, nothing to do

  // for (const [producerId, { producer, peerId: existingPeerId }] of room.producers) {
  //   if (existingPeerId === ws.peerId) continue; // skip own

  //   // Only create if not already consuming
  //   const alreadyConsuming = [...room.consumers.values()].some(
  //     c => c.producerId === producerId && c.appData?.consumingPeerId === ws.peerId
  //   );
  //   if (alreadyConsuming) continue;

  //   if (!room.router.canConsume({ producerId, rtpCapabilities: data.rtpCapabilities })) continue;

  //   const consumer = await recvTransport.consume({
  //     producerId,
  //     rtpCapabilities: data.rtpCapabilities,
  //     paused: true,
  //     appData: { peerId: existingPeerId, consumingPeerId: ws.peerId }
  //   });

  //   room.consumers.set(consumer.id, consumer);
  //   attachAdaptiveLayerSwitching(consumer, room);
  //   console.log(`✅ [rtp-cap catchup] consumer for [${ws.peerId}] ← [${existingPeerId}] kind=${consumer.kind}`);

  //   ws.send(JSON.stringify({
  //     type: 'new-consumer',
  //     params: {
  //       consumerId: consumer.id,
  //       producerId,
  //       kind: consumer.kind,
  //       rtpParameters: consumer.rtpParameters,
  //       producerPeerId: existingPeerId,
  //       appData: producer.appData || {}
  //     }
  //   }));
  // }
  return;
}

    // join room
    if (data.type === 'join-room') {
      if (data.payload?.roomId && data.payload.roomId !== ws.user.roomId) {
        console.log("❌ Room mismatch attempt");
        ws.close();
        return;
      }
      const roomId = ws.user.roomId;
      const peerId = ws.user.username;
      logger.info({ event: 'join-room', peerId, roomId });
      
      const room = await getRoom(roomId);

      ws.roomId = roomId;
      ws.peerId = peerId;

      const isRecovering = room.addPeer(peerId, ws);

      const fullStates = {};
      room.muteStates.forEach((state, pid) => {
        fullStates[pid] = typeof state === 'object' 
          ? state 
          : { muted: state }; 
      });

      ws.send(JSON.stringify({
        type: 'state-sync',
        payload: {
          peers: room.listPeers(),
          messages: room.messages,
          muteStates: fullStates,
          screenSharers: Object.keys(room.screenSharers || {})
        }
      }));

      if (!isRecovering) {
        room.broadcast(
          { type: 'peer-joined', payload: peerId },
          peerId
        );
      } else {
        logger.info({ peerId, event: 'session-recovered' });
      }
    }
    
    else if (data.type === 'create-transport') {
      const room = await getRoom(ws.roomId);
      if (!room?.router) {
        console.error("❌ No router found for room:", ws.roomId);
        return;
      }
      const direction = data.direction;

  // Create a WebRTC transport on the router
  // This is the tunnel between this peer and the server
      const transport = await room.router.createWebRtcTransport({
        listenIps: [{ 
          ip: "0.0.0.0",
          announcedIp: process.env.ANNOUNCED_IP || "192.168.29.231",// ← change to your laptop IP for phone testing
        }],
        enableUdp: true,   // faster, preferred
        enableTcp: true,   // fallback if UDP blocked
        preferUdp: true,
        //Data Channel
        enableSctp: true,
        numSctpStreams: { OS: 1024, MIS: 1024 }
      });

     // Store transport in room by peerId
      if (!room.peersData.has(ws.peerId)) {
        room.peersData.set(ws.peerId, {
          sendTransport: null,
          recvTransport: null
        });
      }

      const peer = room.peersData.get(ws.peerId);

      if (direction === 'send') {
        peer.sendTransport = transport;
      } else {
        peer.recvTransport = transport;
      }   

      console.log(`✅ [${direction}] transport for [${ws.peerId}] id=${transport.id}`);

      // ✅ Send transport details back to browser
      ws.send(JSON.stringify({
        type: 'transport-created',
        direction,
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,   // ICE credentials
          iceCandidates: transport.iceCandidates,   // server's IP/port
          dtlsParameters: transport.dtlsParameters, // encryption params
          sctpParameters: transport.sctpParameters,
          routerRtpCapabilities: room.router.rtpCapabilities // what codecs server supports
        }
      }));
    }
    // ✅ TRANSPORT CONNECT
    else if (data.type === 'connect-transport') {
      const room = await getRoom(ws.roomId);
      if (!room) return;

      const peer = room.peersData.get(ws.peerId);

      if (!peer) {
        console.error("❌ No peer data found:", ws.peerId);
        return;
      }

      const transport =
        data.direction === 'send'
          ? peer.sendTransport
          : peer.recvTransport;

      if (!transport) {
        console.error(`❌ No ${data.direction} transport for`, ws.peerId);
        return;
      }

      // ✅ Complete DTLS handshake
      await transport.connect({
        dtlsParameters: data.dtlsParameters
      });

      console.log(`✅ DTLS connected transportId=${data.transportId}`);

      ws.send(JSON.stringify({
        type: 'transport-connected',
        transportId: data.transportId,
        direction: data.direction 
      }));
    }
    
    else if (data.type === 'produce') {
      const room = await getRoom(ws.roomId);
      if (!room) return;

    // Get this peer's transport (created in 'create-transport')
      const transport = room.peersData.get(ws.peerId).sendTransport;
      if (!transport) {
        console.error("❌ No transport for peer:", ws.peerId);
        return;
      }

    // Create the Producer — this is what actually receives RTP from the browser
      const producer = await transport.produce({
        kind: data.kind,               // 'audio' or 'video'
        rtpParameters: data.rtpParameters,  // exact codec/SSRC info from browser
        appData: data.appData || { peerId: ws.peerId }
      });

      console.log(`✅ Producer created [${ws.peerId}] kind=${producer.kind} id=${producer.id}`);

    // Store producer on the room so other peers can consume it later (Day 8 next steps)
      if (!room.producers) room.producers = new Map();
      room.producers.set(producer.id, {
        producer,
        peerId: ws.peerId,   // who owns this producer
        kind: producer.kind,
      });

    // Also index by peerId for easy lookup
      if (!room.peerProducers) room.peerProducers = new Map();
      if (!room.peerProducers.has(ws.peerId)) room.peerProducers.set(ws.peerId, []);
      room.peerProducers.get(ws.peerId).push(producer);

    // Reply with the real producer ID — client's _produceCallback resolves with this
      ws.send(JSON.stringify({
        type: 'produced',
        id: producer.id,
        kind: producer.kind,
      }));
      // 🔥 create consumers for all other peers
      const peers = room.listPeers();

      for (const peerId of peers) {
        if (peerId === ws.peerId) continue;

        const targetSocket = room.peers.get(peerId);
        if (!targetSocket) continue;

        const recvTransport = room.peersData.get(peerId)?.recvTransport;
        if (!recvTransport) {
          console.warn(`⚠️ No recvTransport for ${peerId}`);
          continue;
        }

        const rtpCapabilities = targetSocket.rtpCapabilities;
        if (!rtpCapabilities) {
          console.warn(`⚠️ Missing rtpCapabilities for ${peerId}`);
          continue;
        }

        if (!room.router.canConsume({ producerId: producer.id, rtpCapabilities })) {
          console.warn(`⚠️ ${peerId} cannot consume ${producer.id}`);
          continue;
        }

        const consumer = await recvTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
          appData: { peerId: ws.peerId, consumingPeerId: peerId }
        });

        if (!room.consumers) room.consumers = new Map();
        room.consumers.set(consumer.id, consumer);
        attachAdaptiveLayerSwitching(consumer, room); 

        console.log(`✅ Consumer for [${peerId}] consuming [${ws.peerId}] kind=${consumer.kind}`);

        targetSocket.send(JSON.stringify({
          type: 'new-consumer',
          params: {
            consumerId: consumer.id,
            producerId: producer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            producerPeerId: ws.peerId,
            appData: producer.appData
          }
        }));
      }

      const newPeerRecvTransport = room.peersData.get(ws.peerId)?.recvTransport;
      const newPeerRtpCapabilities = ws.rtpCapabilities;

      if (newPeerRecvTransport && newPeerRtpCapabilities && room.producers) {
        for (const [existingProducerId, { peerId: existingPeerId }] of room.producers) {
          if (existingPeerId === ws.peerId) continue;        // skip own producers
          if (existingProducerId === producer.id) continue; // skip the one just created

          if (!room.consumers) room.consumers = new Map();
          const alreadyConsuming = [...room.consumers.values()].some(
            c => c.producerId === existingProducerId && 
                 c.appData?.peerId === existingPeerId &&
                 c.appData?.consumingPeerId === ws.peerId
          );

          if (alreadyConsuming) {
            console.log(`⏭ Already consuming ${existingProducerId} for ${ws.peerId}, skipping`);
            continue;
          }

          if (!room.router.canConsume({ producerId: existingProducerId, rtpCapabilities: newPeerRtpCapabilities })) {
            console.warn(`⚠️ ${ws.peerId} cannot consume ${existingProducerId}`);
            continue;
          }

          const reverseConsumer = await newPeerRecvTransport.consume({
            producerId: existingProducerId,
            rtpCapabilities: newPeerRtpCapabilities,
            paused: true,
            appData: { peerId: existingPeerId, consumingPeerId: ws.peerId }
          });

          room.consumers.set(reverseConsumer.id, reverseConsumer);
          attachAdaptiveLayerSwitching(reverseConsumer, room);
          console.log(`✅ [reverse] consumer for [${ws.peerId}] ← [${existingPeerId}] kind=${reverseConsumer.kind}`);

          ws.send(JSON.stringify({
            type: 'new-consumer',
            params: {
              consumerId: reverseConsumer.id,
              producerId: existingProducerId,
              kind: reverseConsumer.kind,
              rtpParameters: reverseConsumer.rtpParameters,
              producerPeerId: existingPeerId,
              appData: room.producers.get(existingProducerId)?.producer?.appData || {}
            }
          }));
        }
      }
    }
  
    else if (data.type === 'produce-data') {
      const room = await getRoom(ws.roomId);
      const transport = room.peersData.get(ws.peerId)?.sendTransport;

      if (!transport) {
        console.error("❌ No send transport for dataProducer");
        return;
      }

      const dataProducer = await transport.produceData({
        sctpStreamParameters: data.sctpStreamParameters,
        label: data.label
      });

      room.dataProducers.set(dataProducer.id, {
        dataProducer,
        peerId: ws.peerId
      });

      console.log(`💬 DataProducer created: ${dataProducer.id}`);

      ws.send(JSON.stringify({
        type: 'data-produced',
        id: dataProducer.id
      }));

      for (const peerId of room.listPeers()) {
        if (peerId === ws.peerId) continue;

        room.sendTo(peerId, {
          type: 'new-data-producer',
          dataProducerId: dataProducer.id,
          producerPeerId: ws.peerId
        });
      }
      for (const [existingId, { dataProducer: existingDp, peerId: existingPeerId }] of room.dataProducers) {
        if (existingPeerId === ws.peerId) continue;

        ws.send(JSON.stringify({
          type: 'new-data-producer',
          dataProducerId: existingId,
          producerPeerId: existingPeerId
        }));
      }
    }

    else if (data.type === 'consume-data') {
      const room = await getRoom(ws.roomId);
      const transport = room.peersData.get(ws.peerId)?.recvTransport;

      if (!transport) {
        console.error("❌ No recv transport for dataConsumer");
        return;
      }

      if (!room.dataProducers.has(data.dataProducerId)) {
      console.warn(`⚠️ consume-data: unknown dataProducerId ${data.dataProducerId} — skipping`);
      return;
    }

    let dataConsumer;
    try {
      dataConsumer = await transport.consumeData({
        dataProducerId: data.dataProducerId
      });
    } catch (e) {
      console.warn(`⚠️ consumeData failed for ${data.dataProducerId}:`, e.message);
      return;
    }

      room.dataConsumers.set(dataConsumer.id, dataConsumer);

      console.log(`💬 DataConsumer created: ${dataConsumer.id}`);

      ws.send(JSON.stringify({
        type: 'data-consumer-created',
        params: {
          id: dataConsumer.id,
          dataProducerId: data.dataProducerId,
          sctpStreamParameters: dataConsumer.sctpStreamParameters,
          label: dataConsumer.label
        }
      }));
    }
  
    // hello message
    else if (data.type === 'hello') {
      const room = await getRoom(ws.roomId);
      if (!room) return;

      room.broadcast({
        type: 'hello',
        payload: ws.peerId
      }, ws.peerId);
    }

    else if (data.type === 'mute-status') {
      const room = await getRoom(ws.roomId);
      if (!room) return;

      const existing = room.muteStates.get(ws.peerId) || {};
      room.muteStates.set(ws.peerId, { ...existing, muted: data.muted });

      room.broadcast({
        type: 'mute-status',
        from: ws.peerId,
        muted: data.muted
      }, ws.peerId);
    }

    else if (data.type === 'video-status') {
      const room = await getRoom(ws.roomId);
      if (!room) return;

      const existing = room.muteStates.get(ws.peerId) || {};
      room.muteStates.set(ws.peerId, { ...existing, videoOff: data.videoOff });

      room.broadcast({
        type: 'video-status',
        from: ws.peerId,
        videoOff: data.videoOff
      }, ws.peerId);
    }

    else if (data.type === 'resume-consumer') {
      const room = await getRoom(ws.roomId);
      if (!room) return;

      const consumer = room.consumers?.get(data.consumerId);
      if (!consumer) {
        console.warn("⚠️ resume-consumer: not found:", data.consumerId);
        return;
      }

      await consumer.resume();
      console.log(`▶️  Consumer resumed: ${data.consumerId}`);
    }


    // 🔥 SCREEN SHARE SIGNALING (ADD THIS)
    else if (data.type === 'screen-share-start' || data.type === 'screen-share-stop') {
      const room = await getRoom(ws.roomId);
      if (!room) return;

      console.log("=================================");
      console.log("[SERVER] Screen event:", data.type);
      console.log("[SERVER] From:", ws.peerId);
      console.log("[SERVER] Room:", ws.roomId);
      console.log("[SERVER] Peers in room:", room.listPeers());
      console.log("=================================");

      room.peers.forEach((client, peerId) => {
        console.log("Checking peer:", peerId);

        if (client.readyState === WebSocket.OPEN) {
          if (client !== ws) {
            console.log(`[SERVER] → sending ${data.type} to ${peerId}`);
            client.send(JSON.stringify({
              type: data.type,
              from: ws.peerId
            }));
          }
        }
      });
    }
    else if (data.type === 'start-recording') {
  const room = await getRoom(ws.roomId);
  if (!room) return;

  // const peers = room.listPeers();

  // // first peer in the list is the moderator
  // if (peers[0] !== ws.peerId) {
  //   ws.send(JSON.stringify({
  //     type: 'recording-error',
  //     message: 'Only the moderator can start recording'
  //   }));
  //   return;
  // }

  if (room.ffmpegProcess) {
    ws.send(JSON.stringify({
      type: 'recording-error',
      message: 'Recording is already active in this room'
    }));
    return;
  }

  // find this peer's video producerId from room.producers
  let videoProducerId = null;
  for (const [pid, entry] of room.producers) {
    if (entry.peerId === ws.peerId && entry.kind === 'video') {
      videoProducerId = pid;
      break;
    }
  }

  if (!videoProducerId) {
    ws.send(JSON.stringify({
      type: 'recording-error',
      message: 'No video producer found — make sure your camera is on'
    }));
    return;
  }

  try {
    await startRecording(room, videoProducerId);
    room.recordingStartedBy = ws.peerId;

    // tell every peer in the room recording has started
    room.peers.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'recording-started',
          startedBy: ws.peerId
        }));
      }
    });
  } catch (e) {
    ws.send(JSON.stringify({
      type: 'recording-error',
      message: e.message
    }));
  }
}

else if (data.type === 'stop-recording') {
  const room = await getRoom(ws.roomId);
  if (!room) return;

  // const peers = room.listPeers();

  if (room.recordingStartedBy && room.recordingStartedBy !== ws.peerId) {
    ws.send(JSON.stringify({
      type: 'recording-error',
      message: 'Only the peer who started recording can stop it'
    }));
    return;
  }

  if (!room.ffmpegProcess) {
    ws.send(JSON.stringify({
      type: 'recording-error',
      message: 'No recording is currently active'
    }));
    return;
  }

  room.ffmpegProcess.kill('SIGINT');
  room.ffmpegProcess = null;

  try { room.recordingConsumer?.close(); } catch(e) {}
  room.recordingConsumer = null;
  try { room.recordingTransport?.close(); } catch(e) {}
  room.recordingTransport = null;
  try { room.recordingAudioConsumer?.close(); } catch(e) {}
  room.recordingAudioConsumer = null;
  try { room.recordingAudioTransport?.close(); } catch(e) {}
  room.recordingAudioTransport = null;
  room.recordingStartedBy = null;

  room.peers.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'recording-stopped' }));
    }
  });
}   
  });


  ws.on('close', async () => {
    const rId = ws.roomId;
    const pId = ws.peerId;

    if (!rId || !pId) return;

    console.log(`❌ Peer disconnected: ${pId}`);

    const room = rooms.get(rId);
    if (!room) return;

    // 🔥 1. CLOSE PRODUCERS
    if (room.peerProducers?.has(pId)) {
      for (const producer of room.peerProducers.get(pId)) {
        try {
          producer.close();
          console.log(`🧹 Closed producer ${producer.id}`);
        } catch (e) {}
      }
      room.peerProducers.delete(pId);
    }

    // 🔥 2. CLOSE CONSUMERS
    if (room.consumers) {
      for (const [id, consumer] of room.consumers) {
        if (consumer.appData?.peerId === pId || consumer.appData?.consumingPeerId === pId) {
          try {
            consumer.close();
            console.log(`🧹 Closed consumer ${id}`);
          } catch (e) {}
          room.consumers.delete(id);
        }
      }
    }

    // 🔥 3. REMOVE PEER TRANSPORTS
    if (room.peersData.has(pId)) {
      const peerData = room.peersData.get(pId);

      peerData.sendTransport?.close();
      peerData.recvTransport?.close();

      room.peersData.delete(pId);
    }

    // 🔥 4. REMOVE FROM ROOM
    room.removePeer(pId);

    // 🔥 5. NOTIFY OTHERS
    room.broadcast(
      { type: 'peer-left', payload: pId },
      pId
    );

    console.log(`✅ Cleanup complete for ${pId}`);

    if (room.ffmpegProcess && room.listPeers().length === 0) {
      room.ffmpegProcess.kill('SIGINT');
      room.ffmpegProcess = null;
      try { room.recordingConsumer?.close(); } catch(e) {}
      room.recordingConsumer = null;
      try { room.recordingTransport?.close(); } catch(e) {}
      room.recordingTransport = null;
      try { room.recordingAudioConsumer?.close(); } catch(e) {}
      room.recordingAudioConsumer = null;
      try { room.recordingAudioTransport?.close(); } catch(e) {}
      room.recordingAudioTransport = null;
      room.recordingStartedBy = null; 
      console.log('🛑 Recording auto-stopped — room is empty');
    }
    
  });
});

console.log("Server running on ws://localhost:3000");