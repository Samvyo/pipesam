import { Device } from 'mediasoup-client';
export default class Room {
  constructor(onStateChange) {
    this._notify = onStateChange; 
    this.ws               = null;
    this.peerId           = null;
    this.roomId           = null;
    this.peerConnections  = {};
    this.localStream      = null;
    this.peers            = new Set();
    this.peerStates       = {};
    this.statsCache       = {};
    this.dataChannels     = {};
    this.screenTrack      = null;
    this.canvas           = null;
    this.ctx              = null;
    this.mixedStream      = null;
    this.recorder         = null;
    this.recordedChunks   = [];
    this.recordingRAF     = null;
    this.audioCtx         = null;
    this.audioDest        = null;
    this.peerAudioSources = {};
    this.pendingCandidates= {};
    this.isMakingOffer    = {};
    this.screenSharers    = {};
    this._connectQueue    = Promise.resolve();
    this.isPolite = {}; 
    this.device = null;  
    this.sendTransport = null; 
    this.recvTransport = null;          
    this._transportConnectCallback = null; 
    this._transportConnectErrback = null; 
    this._produceCallback = null;          
    this._produceErrback = null;

    this.onMessage = null;
    this.onChat = null;
    this.onPeersUpdate = null;
    this.onPeerStateChange = null;
    this.onTrack = null;          
    this.onScreenShare = null;    
    this.onQuality = null;
    this.onLocalScreenStream = null;    
    this.onAudioTrack = null;    
  }

  setStatus(val) {
    console.log("Status:", val ? "ONLINE" : "OFFLINE");
    this.onMessage?.(val ? "Connected" : "Disconnected");
  }
  _send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn("⚠️ WebSocket not ready, skipping:", data.type);
    }
  }
  
  _enqueue(fn) {
    this._connectQueue = this._connectQueue
      .then(() => fn())
      .catch(e => console.error("Queue error:", e));
    return this._connectQueue;
  }

  connectAndJoin() {
    const token = localStorage.getItem("token");

    // ✅ Step 1: prevent multiple connections
  if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
    console.warn("⚠️ WebSocket already exists");
    return;
  }

// ✅ Step 2: use local variable
  const ws = new WebSocket(
    `wss://${window.location.hostname}:3000?token=${token}`
  );

// store reference
  this.ws = ws;

// ✅ Step 3: use SAME ws inside onopen
  ws.onopen = () => {
    console.log("Connected → sending join");
    this.setStatus(true);

    ws.send(JSON.stringify({
      type: 'join-room',
      payload: { roomId: this.roomId, peerId: this.peerId }
    }));
  };

    this.ws.onerror = (err) => console.error("WebSocket error:", err);

    this.ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      console.log(`[WS @ ${this.peerId}]`, data.type, "from:", data.from || "server");

      if (data.type === "screen-share-start") {
        console.log(`[RECEIVED] ${this.peerId} ← screen share started by ${data.from}`);
        this.addMsg(`${data.from} started screen sharing`);

        this.screenSharers[data.from] = true;
        this.peerStates[data.from] = { ...(this.peerStates[data.from] || {}), isScreenSharing: true };

        this.updatePeerUI(data.from);
        
      }

      if (data.type === "screen-share-stop") {
        delete this.screenSharers[data.from];
        this.peerStates[data.from] = { ...(this.peerStates[data.from] || {}), isScreenSharing: false };
        this.updatePeerUI(data.from);
        this.onScreenShare?.(data.from, null); 
      }

      if (data.type === 'mute-status') {
        this.peerStates[data.from] = {
          ...(this.peerStates[data.from] || {}),
          muted: data.muted
      };
        this.updatePeerUI(data.from);
        const label = document.getElementById(`label-${data.from}`);
        if (label) {
          label.innerText = `${data.from} ${data.muted ? "🔇" : "🔊"}`;
        }
      }

      if (data.type === 'video-status') {
        this.peerStates[data.from] = { ...this.peerStates[data.from], videoOff: data.videoOff };
        this.updatePeerUI(data.from);
      }

      if (data.type === 'state-sync') {
        this.peers = new Set(data.payload.peers || []);
        this.onPeersUpdate?.([...this.peers]);
        this.renderMessages(data.payload.messages);
        if (this.peers.size < 2) this.addMsg("Waiting for another user...");

        for (const pid of this.peers) {
          if (pid !== this.peerId) {
          this.peerStates[pid] = { muted: false, videoOff: false, isScreenSharing: false };
          }
        }

        if (data.payload.muteStates) {
          Object.keys(data.payload.muteStates).forEach(pid => {
            this.peerStates[pid] = { ...(this.peerStates[pid] || {}), ...data.payload.muteStates[pid] };
            this.updatePeerUI(pid);
          });
        }
        if (data.payload.screenSharers) {
          data.payload.screenSharers.forEach(pid => {
            this.screenSharers[pid] = true;

            // const pc = this.createPeerConnection(pid);
            // pc.addTransceiver("video", { direction: "recvonly" });
            // this._enqueue(() => this._connectToPeer(pid, false));
          
            this.peerStates[pid] = { ...(this.peerStates[pid] || {}), isScreenSharing: true };
            this.updatePeerUI(pid);
          });
        }

        for (const peer of this.peers) {
          if (peer !== this.peerId && !this.peerConnections[peer]) {
            this._enqueue(() => this._connectToPeer(peer, this.peerId < peer));
          }
        }
        // ✅ Request transport after joining
        setTimeout(() => {
          console.log("🚀 Initiating transport setup...");
          this.initTransport();
        }, 500);
      }

      if (data.type === 'peer-joined') {
        const newPeer = data.payload;
        this.peers.add(newPeer);
        this.addMsg(`${newPeer} joined`);

        this.peerStates[newPeer] = { muted: false, videoOff: false, isScreenSharing: false };
        this.updatePeerUI(newPeer);

        this.renderUsers();
        if (newPeer !== this.peerId && !this.peerConnections[newPeer]) {
          this._enqueue(() => this._connectToPeer(newPeer, this.peerId < newPeer));
        }
      }

      if (data.type === 'peer-left') {
        const gone = data.payload;
        this.peers.delete(gone);
        this.addMsg(`${gone} left`);
        this.renderUsers();

        const pc = this.peerConnections[gone];
        if (pc) { pc.close(); delete this.peerConnections[gone]; }

        this._removeRecordingPeer(gone);

        delete this.dataChannels[gone];
        delete this.isMakingOffer[gone];
        delete this.pendingCandidates[gone];
        delete this.peerStates[gone];
        delete this.statsCache[gone];
        delete this.screenSharers[gone];

        document.getElementById(`container-${gone}`)?.remove();
      }

      if (data.type === 'produced') {
        console.log(`✅ Server confirmed producer: ${data.kind} id: ${data.id}`);
        this._produceCallback?.({ id: data.id });
      }

      if (data.type === 'hello') this.addMsg(`${data.payload} says hello`);

      // ✅ Server created transport — set up client side
     if (data.type === 'transport-created') {
      console.log("✅ Transport params received from server");
      if (!this.device) {
        await this.loadDevice(data.params.routerRtpCapabilities);
      } 
      this.sendTransport = this.device.createSendTransport({
        id:             data.params.id,
        iceParameters:  data.params.iceParameters,
        iceCandidates:  data.params.iceCandidates,
        dtlsParameters: data.params.dtlsParameters,
      });
      console.log("✅ Send transport created on client");

      this.sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        console.log("🔗 Transport connect event — sending dtlsParameters");
        this._send({ type: 'connect-transport', dtlsParameters });
        this._transportConnectCallback = callback;
        this._transportConnectErrback  = errback;
      });
      this.sendTransport.on('produce', (params, callback) => {
        console.log("⚠️ Dummy produce handler (DTLS trigger only)");
        callback({ id: 'dummy-id' });
      });

      console.log("🚀 Triggering DTLS handshake...");

  // 5️⃣ ✅ ADD THIS (DTLS trigger)
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = stream.getVideoTracks()[0];

      await this.sendTransport.produce({ track }); 
}

    // ✅ DTLS handshake complete
    if (data.type === 'transport-connected') {
      console.log("✅ DTLS handshake complete! Tunnel ready!");
      this._transportConnectCallback?.();
    }

      if (data.type === 'offer') {
        const from = data.from;
        const pc   = this.createPeerConnection(from);

        if (pc.getSenders().length === 0) {
          this.isMakingOffer[from] = true;
          await this.setupMedia(pc, from);
          this.isMakingOffer[from] = false;
        }

        const isPolite = this.isPolite[from];
        const offerCollision = this.isMakingOffer[from] || pc.signalingState !== "stable";
        if (offerCollision) {
          // const isPolite = this.peerId > from;
          if (!isPolite) {
            console.log("❌ Ignoring offer (impolite peer)");
            return;
          }

          console.log("Polite peer rolling back");
          await pc.setLocalDescription({ type: "rollback" });
        }

        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        await this._flushCandidates(from, pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._send({type: 'answer', to: from, from: this.peerId, sdp: answer });
      }

      if (data.type === 'answer') {
        const pc = this.peerConnections[data.from];
        if (pc && pc.signalingState !== "stable") {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          await this._flushCandidates(data.from, pc);
        }
      }

      if (data.type === 'candidate') {
        const pc = this.peerConnections[data.from];
        if (!pc) return;
        const candidate = new RTCIceCandidate(data.candidate);
        if (!pc.remoteDescription?.type) {
          if (!this.pendingCandidates[data.from]) this.pendingCandidates[data.from] = [];
          this.pendingCandidates[data.from].push(candidate);
          return;
        }
        try { await pc.addIceCandidate(candidate); }
        catch (e) { console.error("ICE candidate error:", e.message); }
      }
    };

    this.ws.onclose = () => this.setStatus(false);
  }

  async _flushCandidates(peerId, pc) {
    if (!this.pendingCandidates[peerId]) return;
    for (const c of this.pendingCandidates[peerId]) {
      try { await pc.addIceCandidate(c); } catch (e) { console.warn("Queued ICE error:", e); }
    }
    delete this.pendingCandidates[peerId];
  }

  async _connectToPeer(peerId, sendOffer) {
    this.isPolite[peerId] = this.peerId > peerId;
    const pc = this.createPeerConnection(peerId);
    try{
      this.isMakingOffer[peerId] = true;
      await this.setupMedia(pc, peerId);
      if (sendOffer) {
        if (pc.signalingState !== "stable") return;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._send({
          type: 'offer',
          to: peerId,
          from: this.peerId,
          sdp: pc.localDescription
      });
      console.log(`[${this.peerId}] Sent offer to ${peerId}`);
    }
  } catch (e) {
    console.error(`offer to ${peerId} failed:`, e);
  } finally {
    this.isMakingOffer[peerId] = false;
  } 
}

  async joinRoom(user, roomId) {
    if (!roomId) {
      console.warn("RoomId required");
      return;
    }

  // ❗ ALWAYS take identity from token (not UI)
    const token = localStorage.getItem("token");

    if (!token) {
      console.error("❌ No token found");
      return;
    }

  // ✅ decode username from token (optional but safe)
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      this.peerId = payload.username;
    } catch {
      console.error("❌ Invalid token format");
      return;
    }

    this.roomId = roomId;

  // ✅ Ensure media BEFORE connection
    if (!this.localStream) {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

      this.onLocalStream?.(this.localStream);
    }
    this.connectAndJoin();
    this.startStatsMonitoring();
  }

  sendHello() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'hello' }));
  }

  toggleAudio() {
    this.localStream.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
    const muted = !this.localStream.getAudioTracks()[0].enabled;
    this.onPeerStateChange?.(this.peerId, {
      muted
    });
    this.ws?.send(JSON.stringify({ type: "mute-status", from: this.peerId, muted }));
    // const localLabel = document.getElementById("localLabel");
    // if (localLabel) localLabel.innerText = muted ? `You (${this.peerId}) 🔇` : `You (${this.peerId}) 🔊`;
  }

  toggleVideo() {
    this.localStream.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
    const off = !this.localStream.getVideoTracks()[0].enabled;
    this.onPeerStateChange?.(this.peerId, {
      videoOff: off
    });
    this.ws?.send(JSON.stringify({ type: "video-status", from: this.peerId, videoOff: off }));
  }

  async toggleScreenShare() {
    try {
      if (!this.screenTrack) {
        console.log("🔥 Starting screen share");

        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const track = stream.getVideoTracks()[0];

        this.onLocalScreenStream?.(new MediaStream([track])); 

        
        this.screenTrack = track;
        this.screenTrack = track;
        this.screenSharers[this.peerId] = true;
        this.peerStates[this.peerId] = { ...(this.peerStates[this.peerId] || {}), isScreenSharing: true };


        for (const [pid, pc] of Object.entries(this.peerConnections)) {
        if (pc.screenTransceiver) {
          // Use pre-created slot from setupMedia
          await pc.screenTransceiver.sender.replaceTrack(track);
          pc.screenTransceiver.direction = "sendonly";
          pc.screenSender = pc.screenTransceiver.sender;
        } else {
          // Fallback: create new (should not happen if setupMedia ran)
          const transceiver = pc.addTransceiver(track, {
            direction: "sendonly",
            streams: [screenStream]
          });
          pc.screenSender = transceiver.sender;
          pc.screenTransceiver = transceiver;
        }
        console.log("Screen track added to", pid);
      }

        this.onPeerStateChange?.(this.peerId, this.peerStates[this.peerId]);

        this._send({ 
          type: "screen-share-start",
          from: this.peerId 
        });
 
        track.onended = () => this.stopScreenShare();

      } else {
        this.stopScreenShare();
      }
    } catch (e) {
      console.error("Screen share error:", e.message);
    }
  }

  async addScreenTransceiver(pc, peerId) {
    if (pc.screenSender) {
      await pc.screenSender.replaceTrack(this.screenTrack);
      return;
    }
    const transceiver = pc.addTransceiver(this.screenTrack, {
      direction: "sendonly",
      streams: [new MediaStream([this.screenTrack])]
    });
    pc.screenSender = transceiver.sender;
    pc.screenTransceiver = transceiver;
  }

  stopScreenShare() {
  if (!this.screenTrack) return;
  console.log("🛑 Stopping screen share");

  this.ws?.send(JSON.stringify({ type: "screen-share-stop", from: this.peerId }));

  delete this.screenSharers[this.peerId];
  this.peerStates[this.peerId] = { ...(this.peerStates[this.peerId] || {}), isScreenSharing: false };

  Object.values(this.peerConnections).forEach(pc => {
    if (pc.screenSender) {
      const transceiver = pc.getTransceivers().find(t => t.sender === pc.screenSender);
      pc.screenSender.replaceTrack(null);
      if (transceiver) transceiver.direction = "inactive"; // ✅ keeps slot, just deactivates
      pc.screenSender = null;
    }
  });

  this.screenTrack.stop();
  this.screenTrack = null;
  this.onLocalScreenStream?.(null);

  this.onPeerStateChange?.(this.peerId, this.peerStates[this.peerId]);
}

  // 
  
  async startRecording() {
    if (this.recorder) { console.warn("Already recording"); return; }
    if (!this.localStream) return;
    console.log("⏺ Recording started");

  // ✅ Canvas setup — same dimensions as index.html
    this.canvas = document.createElement("canvas");
    this.canvas.width  = 1280;
    this.canvas.height = 720;
    this.ctx = this.canvas.getContext("2d");

  // ✅ Audio: Web Audio mixer — local mic + all current remote peers
    this.audioCtx  = new AudioContext();
    if (this.audioCtx.state === "suspended") {
    await this.audioCtx.resume();
    }
    this.audioDest = this.audioCtx.createMediaStreamDestination();

  // Local mic
    this.localStream.getAudioTracks().forEach(track =>
      this.audioCtx.createMediaStreamSource(new MediaStream([track])).connect(this.audioDest)
    );

  // All currently connected remote peers audio
    for (const pid of Object.keys(this.peerConnections)) {
      this._addPeerAudioToRecording(pid);
    }

  // ✅ Combined stream: canvas video + mixed audio
    this.mixedStream = this.canvas.captureStream(30);
    if (this.mixedStream.getVideoTracks().length === 0) {
      console.error("❌ No video track in canvas stream");
      return;
    }

    console.log("🎥 Mixed stream tracks:", this.mixedStream.getTracks());
    console.log("🎥 Video tracks:", this.mixedStream.getVideoTracks().length);
    this.audioDest.stream.getAudioTracks().forEach(t => this.mixedStream.addTrack(t));

    const options = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? { mimeType: "video/webm;codecs=vp9,opus" }
      : { mimeType: "video/webm" };

    this.recorder = new MediaRecorder(this.mixedStream, options);
    this.recordedChunks = [];

    this.recorder.ondataavailable = (e) => {
      console.log("chunk size:", e.data.size); // 🔥 debug
      if (e.data.size > 0) {
        this.recordedChunks.push(e.data);
      }
    };

    this.recorder.onstop = () => {
      const blob = new Blob(this.recordedChunks, { type: "video/webm" });
      console.log("Final blob size:", blob.size);

      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "meeting-recording.webm";
      a.click();
      if (this.audioCtx) { this.audioCtx.close(); this.audioCtx = null; }
    };

    // 🔥 wait until at least one video is ready
      const waitForVideo = () => new Promise(resolve => {
        const interval = setInterval(() => {
          const videos = document.querySelectorAll("video");
          const ready = Array.from(videos).some(v => v.readyState >= 2);

          if (ready) {
            clearInterval(interval);
            resolve();
          }
        }, 200);
      });

      await waitForVideo();

      const drawFrame = () => {
        this._drawCompositeFrame();
        this.recordingRAF = requestAnimationFrame(drawFrame);
      };
      drawFrame();

      this.recorder.start(1000); // chunk every 1s same as index.html
    }

// ✅ Canvas compositor — same logic as index.html _drawCompositeFrame
// but uses data-type attributes instead of DOM IDs (React has no video-${peerId})
  _drawCompositeFrame() {
    const W = 1280, H = 720;
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, W, H);

  // Check if anyone is screen sharing
    const sharerPid = Object.keys(this.screenSharers)[0];
    let camY = 0;
    let camH = H;

    if (sharerPid) {
    // ✅ React: find screen video by data-type="screen" attribute
      const screenEl = document.querySelector('video[data-type="screen"]');
      if (screenEl && screenEl.srcObject && screenEl.readyState >= 2) {
        const sh = Math.round(H * 0.78); // top 78% = screen
        this.ctx.drawImage(screenEl, 0, 0, W, sh);
        camY = sh;
        camH = H - sh; // bottom 22% = cameras
      }
    }

  // ✅ React: find all camera videos by data-type="camera" attribute
    const camEls = Array.from(document.querySelectorAll('video[data-type="camera"]'))
      .filter(el => el.readyState >= 2 && el.videoWidth > 0);

    if (camEls.length > 0) {
      const cellW = Math.floor(W / camEls.length);
      camEls.forEach((el, i) => {
        this.ctx.drawImage(el, i * cellW, camY, cellW, camH);
      });
    }
  }

// ✅ Fix stopRecording — cancel RAF and close audioCtx
  stopRecording() {
    if (!this.recorder) return;
    console.log("⏹ Recording stopped");
    this.recorder.requestData();
    this.recorder.stop();
    cancelAnimationFrame(this.recordingRAF);
    this.recordingRAF = null;
    this.mixedStream?.getTracks().forEach(t => t.stop());
    this.mixedStream = null;

    this.canvas = null;
    this.ctx = null;
    this.recorder = null;
    this.peerAudioSources = {};
  // audioCtx closed in recorder.onstop
  }

  _addPeerAudioToRecording(peerId) {
    if (!this.audioCtx || !this.audioDest || this.peerAudioSources[peerId]) return;

  // ✅ No DOM audio elements in React — pull directly from RTCRtpReceiver
    const pc = this.peerConnections[peerId];
    if (!pc) return;

    const audioReceiver = pc.getReceivers().find(r => r.track?.kind === "audio");
    if (!audioReceiver?.track) return;

    try {
      const src = this.audioCtx.createMediaStreamSource(
        new MediaStream([audioReceiver.track])
      );
      src.connect(this.audioDest);
      this.peerAudioSources[peerId] = src;
      console.log("🎙 Added audio from", peerId, "to recording mix");
    } catch (e) {
      console.warn("Peer audio mix error:", e);
    }
  }

  _removeRecordingPeer(peerId) {
    const src = this.peerAudioSources[peerId];
    if (src) { try { src.disconnect(); } catch (_) {} delete this.peerAudioSources[peerId]; }
  }

  updatePeerUI(peerId) {
    const state = this.peerStates[peerId] || {};
    this.onPeerStateChange?.(peerId, state);
  }

  startStatsMonitoring() {
    setInterval(async () => {
      for (const peerId in this.peerConnections) {
        const pc = this.peerConnections[peerId];
        if (!pc) continue;
        this.parseStats(await pc.getStats(), peerId);
      }
    }, 2000);
  }

  parseStats(stats, peerId) {
    let rtt = null, jitter = null, packetsLost = null, bitrate = null;
    const pc = this.peerConnections[peerId];
    if (!pc) return;

    stats.forEach(report => {
      if (report.type === "candidate-pair" && report.state === "succeeded")
        rtt = report.currentRoundTripTime;

      if (report.type === "inbound-rtp" && (report.kind === "video" || report.mediaType === "video")) {
        jitter      = report.jitter;
        packetsLost = report.packetsLost;
      }

      if (report.type === "outbound-rtp" && (report.kind === "video" || report.mediaType === "video")) {
        const prev = this.statsCache[peerId];
        if (prev) {
          const timeDiff = report.timestamp - prev.timestamp;
          const byteDiff = report.bytesSent  - prev.bytesSent;
          bitrate = timeDiff > 0 ? (8 * byteDiff) / timeDiff : 0;
        }
        this.statsCache[peerId] = { timestamp: report.timestamp, bytesSent: report.bytesSent };
      }
    });

    console.log(`[${peerId}] RTT:${rtt?.toFixed(3)} Jitter:${jitter?.toFixed(3)} Loss:${packetsLost ?? 0} Bitrate:${bitrate?.toFixed(2) ?? 0}kbps`);

    const quality = this.getConnectionQuality(rtt, packetsLost, jitter);
    this.updateQualityBadge(peerId, quality, rtt);
  
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];

    if (['failed', 'disconnected'].includes(pc.iceConnectionState) || !bitrate || bitrate < 50) {
      params.encodings[0].maxBitrate = 200_000;
    } else if (rtt > 0.3 || jitter > 0.05) {
      params.encodings[0].maxBitrate = 300_000;
    } else {
      params.encodings[0].maxBitrate = 1_500_000;
    }
    sender.setParameters(params);
  }

  getConnectionQuality(rtt, loss, jitter) {
    if (!rtt) return "unknown";
    const rttMs = rtt * 1000;

    if (rttMs < 150 && loss < 2 && jitter < 0.03) return "good";
    if (rttMs < 300 && loss < 5) return "fair";
    return "poor";
  }
  
  updateQualityBadge(peerId, quality, rtt) {
  const ms = rtt ? (rtt * 1000).toFixed(0) : "?";
  this.onQuality?.(peerId, { quality, ms });

  // let icon = "⚪";
  // let text = "Unknown";

  // if (quality === "good") {
  //   icon = "🟢";
  //   text = "Good";
  // } else if (quality === "fair") {
  //   icon = "🟡"; 
  //   text = "Fair";
  // } else if (quality === "poor") {
  //   icon = "🔴";
  //   text = "Poor";
  // }

}

  createPeerConnection(peerId) {
    if (this.peerConnections[peerId]) return this.peerConnections[peerId];

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "turn:localhost:3478", username: "test", credential: "test" }
      ]
    });

    if (this.peerId < peerId) {
      const ch = pc.createDataChannel("chat", { ordered: true });
      this.setupDataChannel(ch, peerId);
    }
    pc.ondatachannel = (event) => this.setupDataChannel(event.channel, peerId);

  
    pc.ontrack = (event) => {
      if (event.track.kind === "video") {
        const videoTxcvrs = pc.getTransceivers()
          .filter(t => t.receiver.track?.kind === "video");

        const isScreen = videoTxcvrs.length > 1 &&
          event.transceiver === videoTxcvrs[videoTxcvrs.length - 1];

        const stream = event.streams[0] || new MediaStream([event.track]);

        if (isScreen) {
          console.log("📺 Screen track from", peerId);
          this.onScreenShare?.(peerId, stream);
        } else {
          console.log("📷 Camera track from", peerId);
          this.onTrack?.(peerId, stream);
        }
      }

      if (event.track.kind === "audio") {
        const stream = new MediaStream([event.track]);
        this.onAudioTrack?.(peerId, stream);
        if (this.recorder) this._addPeerAudioToRecording(peerId);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._send({
          type: 'candidate', to: peerId, from: this.peerId, candidate: event.candidate
        });
      }
    };

    pc.oniceconnectionstatechange = async () => {
      console.log("ICE State:", pc.iceConnectionState);
      if (pc.iceConnectionState === "failed") {
        if (pc.signalingState !== "stable") {
          await new Promise(resolve => {
            const check = () => {
              if (pc.signalingState === "stable") {
                pc.removeEventListener("signalingstatechange", check);
                resolve();
              }
            };
            pc.addEventListener("signalingstatechange", check);
          });
        }
        if (this.isMakingOffer[peerId]) return;
        try {
          this.isMakingOffer[peerId] = true;
          const offer = await pc.createOffer({ iceRestart: true });
          if (pc.signalingState !== "stable") return;
          await pc.setLocalDescription(offer);
          this._send({type: 'offer', to: peerId, from: this.peerId, sdp: offer });
        } catch (e) {
          console.error("ICE restart failed:", e);
        } finally {
          this.isMakingOffer[peerId] = false;
        }
      }
    };

    pc.onconnectionstatechange = () => console.log("Connection State:", pc.connectionState);

    pc.onnegotiationneeded = async () => {
      if (this.isMakingOffer[peerId]) return;
      if (pc.signalingState !== "stable") {
        console.log(`[${peerId}] Skip negotiation — state: ${pc.signalingState}`);
        return;
      }
      try {
        this.isMakingOffer[peerId] = true;
        console.log(`[${this.peerId}] 🔄 Renegotiating with ${peerId}`);

        const offer = await pc.createOffer();
        // Double-check state hasn't changed while awaiting createOffer
        if (pc.signalingState !== "stable") {
          console.log("⚠️ Abort setLocalDescription — state changed:", pc.signalingState);
          return;
        }
        await pc.setLocalDescription(offer);
        if (pc.localDescription?.type === "offer") {
          this._send({
            type: 'offer',
            to: peerId,
            from: this.peerId,
            sdp: pc.localDescription
          });
        }

        } catch (e) {
          console.warn("⚠️ negotiation error:", e.message);
        } finally {
          this.isMakingOffer[peerId] = false;
        }
      }
    

    this.peerConnections[peerId] = pc;
    setTimeout(() => this.updatePeerUI(peerId), 0);
    return pc;
  }

  async setupMedia(pc, peerId) {
    if (!this.localStream) {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    }
    // document.getElementById('localVideo').srcObject = this.localStream;

    this.localStream.getTracks().forEach(track => {
      const alreadyAdded = pc.getSenders().some(s => s.track === track);
      if (!alreadyAdded) pc.addTrack(track, this.localStream);
    });

  // ✅ Always pre-create a dedicated screen transceiver (sendonly placeholder)
  // so it's always the SECOND video transceiver, predictably
    if (!pc.screenTransceiver) {
      pc.screenTransceiver = pc.addTransceiver("video", {
        direction: "inactive"  // inactive until screen share starts
      });
    }
    if (this.screenTrack && pc.screenTransceiver) {
      await pc.screenTransceiver.sender.replaceTrack(this.screenTrack);
      pc.screenTransceiver.direction = "sendonly";
      pc.screenSender = pc.screenTransceiver.sender;
    }
  }
  
  renderUsers() {
    this.onPeersUpdate?.([...this.peers]);
  }

  addMsg(msg) {
    this.onMessage?.(msg);
  }

  renderMessages(msgs = []) {
    msgs.forEach(m => {
      if (m.type === 'hello') {
        this.onMessage?.(`${m.payload} says hello`);
      }
    });
  }

  setupDataChannel(channel, peerId) {
    const existing = this.dataChannels[peerId];
    if (existing && existing.readyState === "open") return;
    this.dataChannels[peerId] = channel;
    channel.onopen    = () => console.log("Chat connected with", peerId);
    channel.onmessage = (e) => this.addChatMsg(`${peerId}: ${e.data}`);
    channel.onclose   = () => { if (this.dataChannels[peerId] === channel) delete this.dataChannels[peerId]; };
    channel.onerror   = (err) => console.error("Data channel error:", err);
  }

  sendChat(msg) {
    if (!msg) return;
    this.addChatMsg(`You: ${msg}`);

    Object.values(this.dataChannels).forEach(ch => {
      if (ch.readyState === "open") ch.send(msg);
    });
  }

  addChatMsg(msg) {
    this.onChat?.(msg);
  }

  // ✅ MEDIASOUP: Load device with server capabilities
  async loadDevice(routerRtpCapabilities) {
    try {
      this.device = new Device();
      await this.device.load({ routerRtpCapabilities });
      console.log("✅ Device loaded");
      console.log("   Can produce video:", this.device.canProduce('video'));
      console.log("   Can produce audio:", this.device.canProduce('audio'));
    } catch (e) {
      console.error("❌ Device load failed:", e);
    }
  }

  // ✅ MEDIASOUP: Ask server to create transport
  async initTransport() {
    console.log("🚀 Requesting transport from server...");
    this._send({ type: 'create-transport' });
  }
}

  
// const app = new App();

// document.addEventListener("DOMContentLoaded", () => {
//   document.getElementById("chatInput").addEventListener("keypress", (e) => {
//     if (e.key === "Enter") app.sendChat();
//   });
// });

// window.onload = async () => {
//   if (!app.localStream) {
//     try {
//       app.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
//       document.getElementById('localVideo').srcObject = app.localStream;
//     } catch (e) { console.warn("Camera pre-warm failed:", e.message); }
//   }
//   console.log("Preview started");

//   const params = new URLSearchParams(window.location.search);
//   const user   = params.get('user');
//   const room   = params.get('room');

//   if (user && room) {
//     document.getElementById('username').value = user;
//     document.getElementById('roomId').value   = room;
//     app.peerId = user;
//     app.roomId = room;
//     // const localLabel = document.getElementById('localLabel');
//     // if (localLabel) localLabel.innerText = `You (${user}) 🔊`;
//     app.connectAndJoin();
//     app.startStatsMonitoring();
//   }
// }