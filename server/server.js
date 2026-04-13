const WebSocket = require('ws');
const pino = require('pino');

const logger = pino({ level: 'info' });
const wss = new WebSocket.Server({ port: 3000 });

class Room {
  constructor(roomId) {
    this.roomId = roomId;
    this.peers = new Map();
    this.sessions = new Map();
    this.messages = [];
    this.recentlyDisconnected = new Map(); // track recent disconnects
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
}

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Room(roomId));
  }
  return rooms.get(roomId);
}

wss.on('connection', (ws) => {
  logger.info("New socket connected");

  ws.on('message', (raw) => {
  console.log("Incoming message:", raw.toString()); // ✅ ADD THIS

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

    // join room
    if (data.type === 'join-room') {
      const { roomId, peerId } = data.payload;
      logger.info({ event: 'join-room', peerId, roomId });
      
      const room = getRoom(roomId);

      ws.roomId = roomId;
      ws.peerId = peerId;

      const isRecovering = room.addPeer(peerId, ws);

      ws.send(JSON.stringify({
        type: 'state-sync',
        payload: {
          peers: room.listPeers(),
          messages: room.messages,
          status: isRecovering ? 'recovered' : 'new'
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

    // hello message
    else if (data.type === 'hello') {
      const room = getRoom(ws.roomId);
      if (!room) return;

      room.broadcast({
        type: 'hello',
        payload: ws.peerId
      }, ws.peerId);
    }

    else if (['offer', 'answer','candidate'].includes(data.type)) {
      const room = getRoom(ws.roomId);
      if (!room) return;

      room.broadcast(data, ws.peerId);
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