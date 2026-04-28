const WebSocket = require('ws');

const peerId = process.argv[2] || "user1";
const roomId = process.argv[3] || "room1";

let attempt = 0;

function connect() {
  const ws = new WebSocket(`ws://${window.location.hostname}:3000`);

  ws.on('open', () => {
    console.log(`Connected: ${peerId}`);
    attempt = 0;

    ws.send(JSON.stringify({
      type: 'join-room',
      payload: { roomId, peerId }
    }));
  });

  ws.on('message', (msg) => {
    console.log(`[${peerId}]`, msg.toString());
  });

  ws.on('close', () => {
    const delay = Math.min(1000 * 2 ** attempt, 10000);
    console.log(`Reconnect in ${delay}ms`);
    setTimeout(connect, delay);
    attempt++;
  });

  ws.on('error', () => {});
}

connect();