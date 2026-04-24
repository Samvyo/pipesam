# pipesam
The combined open source version of a pure mesh WebRTC + Mediasoup SFU + Pipecat AI bot capabilities to build next gen voice/video applications. 

# WebRTC Video Calling App

Real-time multi-user video calling app built with WebRTC, Node.js, WebSocket, and React.
Supports video/audio calls, screen sharing, chat, recording, and TURN-based connectivity.

---

# Features

* 👥 **Video Call (up to 4 users)**
  Join a room and connect with multiple users at the same time.

* 🎤 **Mute / Unmute**
  Turn your microphone on or off during the call.

* 📷 **Camera On / Off**
  Enable or disable your video anytime.

* 🖥 **Screen Sharing**
  Share your screen with other participants.
  You can stop sharing anytime.

* 💬 **In-call Chat**
  Send messages to other users during the call.

* 🔴 **Recording**
  Record the entire call (video + audio + screen).
  A `.webm` file will be downloaded when you stop recording.

* 📶 **Connection Quality Indicator**
  Each user shows a quality badge:

  * 🟢 **Green** → Good connection
  * 🟡 **Yellow** → Average connection
  * 🔴 **Red** → Poor connection

* 🔐 **Authentication (JWT-based)**
  Users must have a valid token to join a room.

---

## Architecture

Browser (React UI)
        │
        │ WebSocket (JWT Auth)
        ▼
Node.js Signalling Server (ws + pino)
        │
        │ SDP + ICE
        ▼
   WebRTC P2P Mesh
        │
        ▼
   TURN Server (coturn) 

# Project Structure

```id="z3r1w8"
/server   → Node.js signalling server
/client   → React (Vite) frontend
/shared   → common utilities
```

---

# ⚡ Quick Start

```bash id="n3l7o1"
docker compose up --build
```

Open:

```id="x4s2p9"
http://localhost:5173
```

---

# Authentication 

Before joining a room, you need a token.

### 🔹 Option 1 — Using browser

Call this API in browser:

```id="7o2v1k"
http://localhost:3000/token?username=yourname&roomId=room1
```

Copy the token and paste it in the UI.

---

### 🔹 Option 2 — Using Postman

1. Open Postman
2. Make a GET request:

```id="x9p2k3"
http://localhost:3000/token?username=yourname&roomId=room1
```

3. Copy the token from response
4. Paste it in the app

---

# How the call works

1. Enter username, roomId, and token
2. Click **Join**
3. You will:

   * see your video
   * see other users when they join
   * hear audio

# Tech Stack

* Frontend: React + Vite
* Backend: Node.js + ws
* Realtime: WebRTC
* TURN: coturn
* Logging: pino
* Containerization: Docker


