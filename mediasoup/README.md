# Mediasoup Video Calling App

Single-node real-time multi-user video calling app built with WebRTC, mediasoup SFU, Node.js, WebSocket, and React. Supports video/audio calls, screen sharing, in-call chat, Redis persistence, Prometheus metrics, and Grafana monitoring.

---

# Features

- 👥 Multi-user video conferencing
- 🎤 Mute / Unmute
- 📷 Camera On / Off
- 🖥 Screen Sharing
- 💬 In-call Chat using WebRTC DataChannel (DataProducer/DataConsumer)
- 🔴 Client-side Recording 
- 📶 Connection Quality Indicator
  - 🟢 Good
  - 🟡 Average
  - 🔴 Poor
- 🔐 JWT Authentication
- 📊 Prometheus + Grafana Monitoring
- 🧠 mediasoup SFU Architecture (Workers, Routers, Transports, Producers, Consumers)
- 🚦 Per-peer signaling rate limiting
- 🛑 Graceful shutdown handling (SIGTERM )

# Architecture

```text
                   +----------------------+
                   |  Prometheus/Grafana |
                   |      Monitoring     |
                   +----------+----------+
                              |
                              v

+----------------+    WebSocket Signaling    +----------------------+
|  React Client  | <-----------------------> |  Node.js Signaling   |
|   WebRTC UI    |                           |        Server        |
+--------+-------+                           +----------+-----------+
         |                                              |
         |                                              |
         | RTP / Media Streams                          | Redis
         v                                              v
                 +----------------------------------+
                 |          mediasoup SFU           |
                 |   Workers / Routers / Transports |
                 +----------------+-----------------+
                                  ^
                                  |
                           TURN/STUN Relay
                                  |
                        +---------+---------+
                        |      coturn       |
                        +-------------------+
```
# SFU vs Full-Mesh

**Full-Mesh:** Every participant sends media directly to every other participant.

**SFU:** Clients send media once to the SFU server, and the SFU forwards streams to other participants.

| Feature          | Full-Mesh  | SFU         |
| ---------------- | -----------| ------------ |
| Upload Streams   | Multiple   | Single       |
| Scalability      | Poor       | High         |
| Client CPU Usage | High       | Low          |
| Bandwidth Usage  | High       | Optimized    |
| Best For         | Small Rooms| Large Rooms  |
```

# Project Structure

```text
/mediasoup
├── certs
├── client
├── server
├── shared
├── docker-compose.yml
├── prometheus.yml
├── package.json
└── README.md
```

---

# ⚡ Quick Start

```bash
cd mediasoup
docker compose up --build
```

Open:

```text
https://localhost:5173
```

---

# Authentication

Generate token:

```text
https://localhost:3000/token?username=yourname&roomId=room1
```

Copy the token and paste it in the UI.

---

# Tech Stack

- Frontend: React + Vite
- Backend: Node.js + ws
- Media Server: mediasoup SFU
- Realtime: WebRTC
- TURN/STUN: coturn
- Persistence: Redis
- Monitoring: Prometheus + Grafana
- Containerization: Docker + Docker Compose