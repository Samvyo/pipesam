const express = require('express');
const pino = require('pino');
const logger = pino({ level: 'info' });
const https = require('https'); 
const fs = require('fs');  
const WebSocket = require('ws');
const path = require('path');   

const app = express();  
const cors = require("cors");
app.use(cors());        

const jwt = require("jsonwebtoken");


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
const sslOptions = {
  key:  fs.readFileSync(path.join(__dirname, '../certs/key.pem')),
  cert: fs.readFileSync(path.join(__dirname, '../certs/cert.pem')),
};

// Create HTTPS server
const server = https.createServer(sslOptions, app);

// Attach WebSocket
const wss = new WebSocket.Server({ noServer: true });

// Listen
server.listen(3000, '0.0.0.0', () => {
  console.log("Server running on http://0.0.0.0:3000");
});
class Room {
  constructor(roomId) {
    this.roomId = roomId;
    this.peers = new Map();
    this.sessions = new Map();
    this.messages = [];
    this.recentlyDisconnected = new Map(); // track recent disconnects
    this.muteStates = new Map(); 
    this.screenSharers = {}; 
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
    // track recent disconnect
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
    const client = this.peers.get(targetPeerId);
 
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    } else {
      logger.warn({ targetPeerId }, 'sendTo: peer not found or not open');
    }
  }
}

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Room(roomId));
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

wss.on('connection', (ws, req) => {
  logger.info("New socket connected");

  ws.user = req.user; // already verified

  console.log("✅ Auth success:", ws.user.username);


  ws.on('message', (raw) => {
  console.log("Incoming message:", raw.toString()); 

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
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
      
      const room = getRoom(roomId);

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
      // 🔥 SCREEN SHARE START
      if (data.type === "screen-share-start") {
        const room = getRoom(ws.roomId);
        if (!room) return;

        room.screenSharers = room.screenSharers || {};
        room.screenSharers[data.from] = true;

        room.broadcast({
          type: "screen-share-start",
          from: data.from
        }, data.from);
      }
      // 🔥 SCREEN SHARE STOP
      if (data.type === "screen-share-stop") {
        const room = getRoom(ws.roomId);
        if (!room) return;

        if (room.screenSharers) {
          delete room.screenSharers[data.from];
        }

        room.broadcast({
          type: "screen-share-stop",
          from: data.from
        }, data.from);
      }

      if (!isRecovering) {
        room.broadcast(
          { type: 'peer-joined', payload: peerId },
          peerId
        );
      } else {
        logger.info({ peerId, event: 'session-recovered' });
      }
    }

    // hello message
    else if (data.type === 'hello') {
      const room = getRoom(ws.roomId);
      if (!room) return;

      room.broadcast({
        type: 'hello',
        payload: ws.peerId
      }, ws.peerId);
    }

    else if (data.type === 'mute-status') {
      const room = getRoom(ws.roomId);
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
      const room = getRoom(ws.roomId);
      if (!room) return;

      const existing = room.muteStates.get(ws.peerId) || {};
      room.muteStates.set(ws.peerId, { ...existing, videoOff: data.videoOff });

      room.broadcast({
        type: 'video-status',
        from: ws.peerId,
        videoOff: data.videoOff
      }, ws.peerId);
    }

    // 🔥 SCREEN SHARE SIGNALING (ADD THIS)
    else if (data.type === 'screen-share-start' || data.type === 'screen-share-stop') {
      const room = getRoom(ws.roomId);
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
     
    // signaling messages
    else if (['offer', 'answer', 'candidate'].includes(data.type)) {
      const room = getRoom(ws.roomId);
      if (!room) return;
 
      const { to } = data;
 
      if (!to) {
        logger.warn({ type: data.type }, 'no "to" field on signalling message, broadcasting');
        room.broadcast(data, ws.peerId);
        return;
      }
 
      // forward the message to the specific peer and attach who sent it
      room.sendTo(to, {
        ...data,
        from: ws.peerId   // receiver needs to know who this came from
      });
 
      logger.info({ event: data.type, from: ws.peerId, to });
    }
  });


  ws.on('close', () => {
    const rId = ws.roomId;
    const pId = ws.peerId;

    if (!rId || !pId) return;

    logger.info({ peerId: pId }, "Socket closed (waiting for recovery)");

    setTimeout(() => {
      const room = rooms.get(rId);
      if (!room) return;

      if (room.isCurrentSocket(pId, ws)) {
        room.removePeer(pId);

        room.broadcast(
          { type: 'peer-left', payload: pId },
          pId
        );

        logger.info({ event: 'permanent-disconnect', peerId: pId });
      } else {
        logger.info({ event: 'recovered-session', peerId: pId });
      }
    }, 5000); // grace period
  });
});

console.log("Server running on ws://localhost:3000");