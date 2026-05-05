import { Device } from 'mediasoup-client';
export default class Room {
  constructor(onStateChange) {
    // this._notify = onStateChange; 
    this.ws               = null;

    this.peerId           = null;
    this.roomId           = null;

    // this.peerConnections  = {};
    this.localStream      = null;
    this.screenTrack      = null;
    this.peers            = new Set();
    this.peerStates       = {};
    this.screenSharers = {};
    this.statsCache       = {};
    // this.dataChannels     = {};
    this.canvas           = null;
    this.ctx              = null;
    this.mixedStream      = null;
    this.recorder         = null;
    this.recordedChunks   = [];
    this.recordingRAF     = null;
    this.audioCtx         = null;
    this.audioDest        = null;
    this.peerAudioSources = {};
    this._connectQueue    = Promise.resolve();

    this.device = null;  
    this.sendTransport = null; 
    this.recvTransport = null; 

    this._sendConnectCb    = null;
    this._sendConnectEb    = null;
    this._recvConnectCb    = null;
    this._recvConnectEb    = null;

    this._produceCallbacks = new Map(); 
    this._produced = false;
    this._producersRequested = false;
    // this.deviceLoading = null;

    this.onMessage = null;
    this.onChat = null;
    this.onPeersUpdate = null;
    this.onPeerStateChange = null;
    this.onTrack = null;          
    this.onScreenShare = null;    
    this.onQuality = null;
    this.onLocalScreenStream = null;    
    this.onAudioTrack = null; 
    this._rtpSent = false;   

    this.dataProducer = null;
    this.dataConsumers = new Map();
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
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
// ✅ Step 2: use local variable
  const ws = new WebSocket(
    `${protocol}://${window.location.hostname}:3000?token=${token}`
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
      
      if (data.type === 'transport-connected') {

        if (data.direction === 'send') {
          console.log("✅ SEND transport connected");

          this._sendConnectCb?.();
          this._sendConnectCb = null;
          } 

        if (data.direction === 'recv') {
          console.log("✅ RECV transport connected");

          this._recvConnectCb?.();
          this._recvConnectCb = null;
          
          }
        }
        
      if (data.type === 'new-consumer') {
        const { consumerId, producerId, kind, rtpParameters, producerPeerId, appData } = data.params;

        console.log(`📥 new-consumer: kind=${kind} from peer=${producerPeerId}`);

        if (!this.recvTransport) {
          console.warn("⚠️ recvTransport not ready yet");
          return;
        }

        const consumer = await this.recvTransport.consume({
          id:  consumerId,     // the consumer's own ID
          producerId,          // which producer this consumes
          kind,
          rtpParameters,
          paused: true
        });
        console.log("TRACK STATE:", consumer.track.readyState);

        const stream = new MediaStream([consumer.track]);

        if (kind === 'video' && appData?.type === 'screen') {
          this.onScreenShare?.(producerPeerId, stream);   // ✅ goes to screen section
        } else if (kind === 'video') {
          this.onTrack?.(producerPeerId, stream);
        } else if (kind === 'audio') {
          this.onAudioTrack?.(producerPeerId, stream);
        }
        this._send({ type: 'resume-consumer', consumerId: consumer.id});
      }

      
      if (data.type === 'new-data-producer') {
        this._pendingDataProducerPeer = this._pendingDataProducerPeer || {};
        this._pendingDataProducerPeer[data.dataProducerId] = data.producerPeerId;
  
        this._send({
          type: 'consume-data',
          dataProducerId: data.dataProducerId
        });
      }

      if (data.type === 'data-consumer-created') {
        const { id, dataProducerId, sctpStreamParameters, label } = data.params;

        const dataConsumer = await this.recvTransport.consumeData({
          id,
          dataProducerId,
          sctpStreamParameters,
          label
        });

        const senderPeerId = this._pendingDataProducerPeer?.[dataProducerId] || 'peer';
        delete this._pendingDataProducerPeer?.[dataProducerId];

        dataConsumer.on("message", (msg) => {
          if (senderPeerId === this.peerId) return;
          this.addChatMsg(`${senderPeerId}: ${msg}`); 
        });

        this.dataConsumers.set(id, dataConsumer);
      } 

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
            this.peerStates[pid] = { ...(this.peerStates[pid] || {}), isScreenSharing: true };
            this.updatePeerUI(pid);
          });
        }
        this.initTransport();
      }

      if (data.type === 'peer-joined') {
        const newPeer = data.payload;
        this.peers.add(newPeer);
        this.addMsg(`${newPeer} joined`);

        this.peerStates[newPeer] = { muted: false, videoOff: false, isScreenSharing: false };
        this.updatePeerUI(newPeer);

        this.renderUsers();
      }

      if (data.type === 'peer-left') {
        const gone = data.payload;

        console.log("👋 Peer left:", gone);

        this.peers.delete(gone);

        // 🔥 remove UI streams
        this.onTrack?.(gone, null);
        this.onAudioTrack?.(gone, null);
        this.onScreenShare?.(gone, null);

        delete this.peerStates[gone];
        delete this.screenSharers[gone];
        delete this.statsCache[gone];

        this.onPeersUpdate?.([...this.peers]);
      }
      if (data.type === 'produced') {
        console.log(`✅ Producer confirmed: kind=${data.kind} id=${data.id}`);
        // Fix 8: look up by kind — video and audio have separate callbacks
        const entry = this._produceCallbacks.get(data.kind);
        if (entry) {
          entry.callback({ id: data.id });
          this._produceCallbacks.delete(data.kind); // clean up after resolving
        }
      }

      if (data.type === 'data-produced') {
        console.log("✅ DataProducer confirmed:", data.id);
        if (this._dataProduceCallback) {
        this._dataProduceCallback({ id: data.id });
        this._dataProduceCallback = null;
      }
    }

      if (data.type === 'hello') this.addMsg(`${data.payload} says hello`);

      // ✅ Server created transport — set up client side
     if (data.type === 'transport-created') {
      if (!this.device) {
        this.device = new Device();
      }

      if (!this.device.loaded) {
        await this.device.load({
          routerRtpCapabilities: data.params.routerRtpCapabilities
        });
       console.log("✅ Device loaded");
      }

      if (!this._rtpSent && this.device.loaded) {
        console.log("📡 Sending rtpCapabilities");

        this._send({
          type: 'rtp-capabilities',
          rtpCapabilities: this.device.rtpCapabilities
        });
        this._rtpSent = true;
      }
 

      if (data.direction === 'send') {
        // ── SEND TRANSPORT ────────────────────────────────────────────────────
        this.sendTransport = this.device.createSendTransport(data.params);
        console.log("✅ Send transport created:", this.sendTransport.id);

        this.sendTransport.observer.on('close', () => console.log('🔍 sendTransport closed'));
        this.sendTransport.observer.on('newproducer', producer => {
          console.log('🔍 new producer:', producer.id, producer.kind);
          producer.observer.on('close', () => console.log('🔍 producer closed:', producer.id));
        });
        this.sendTransport.observer.on('newdataproducer', dp => {
          console.log('🔍 new dataProducer:', dp.id);
          dp.observer.on('close', () => console.log('🔍 dataProducer closed:', dp.id));
        });

        this.sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
          console.log("🔥 SEND connect triggered");
          this._sendConnectCb = callback;
          this._sendConnectEb = errback;
          this._send({
            type:  'connect-transport',
            direction: 'send',
            transportId: this.sendTransport.id, // server finds by id, not peerId
            dtlsParameters,
          });
        });

        this.sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
          console.log("📤 produce event:", kind);
          this._produceCallbacks.set(kind, { callback, errback });
          this._send({ type: 'produce', kind, rtpParameters, appData });
        });

        this.sendTransport.on('producedata', (params, callback, errback) => {
          console.log("💬 producedata event triggered");

          this._send({
            type: 'produce-data',
            sctpStreamParameters: params.sctpStreamParameters,
            label: params.label
          });

          this._dataProduceCallback = callback;
        });

        if (!this._produced) {
          this._produced = true;
          const videoTrack = this.localStream?.getVideoTracks()[0];
          const audioTrack = this.localStream?.getAudioTracks()[0];

          if (videoTrack) {
            this.sendTransport.produce({ track: videoTrack })
              .then(() => console.log("🎥 Video producer started"))
              .catch(e => console.error("❌ Video produce failed:", e));
          }
          if (audioTrack) {
            this.sendTransport.produce({ track: audioTrack })
              .then(() => console.log("🎤 Audio producer started"))
              .catch(e => console.error("❌ Audio produce failed:", e));
            }
          }
          if (!this.dataProducer) {
            this.sendTransport.produceData({ label: 'chat', ordered: true })
              .then(dp => {
                this.dataProducer = dp;
                console.log("💬 DataProducer created");
              })
              .catch(e => console.error("❌ DataProducer failed:", e));
          }
        }

      if (data.direction === 'recv') {
        this.recvTransport = this.device.createRecvTransport(data.params);
        console.log("✅ Recv transport created:", this.recvTransport.id);

        this.recvTransport.observer.on('close', () => console.log('🔍 recvTransport closed'));
        this.recvTransport.observer.on('newconsumer', consumer => {
          console.log('🔍 new consumer:', consumer.id, consumer.kind);
          consumer.observer.on('close', () => console.log('🔍 consumer closed:', consumer.id));
        });
        this.recvTransport.observer.on('newdataconsumer', dc => {
          console.log('🔍 new dataConsumer:', dc.id);
          dc.observer.on('close', () => console.log('🔍 dataConsumer closed:', dc.id));
        });

        this.recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
          console.log("🔥 RECV connect triggered");
          this._recvConnectCb = callback;
          this._recvConnectEb = errback;
          this._send({
            type:        'connect-transport',
            direction: 'recv',
            transportId: this.recvTransport.id, // different id from send transport
            dtlsParameters,
          });
        });
    }
    }
  }

    this.ws.onclose = () => this.setStatus(false);
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
    // this.startStatsMonitoring();
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
        this.screenSharers[this.peerId] = true;
        this.peerStates[this.peerId] = { ...(this.peerStates[this.peerId] || {}), isScreenSharing: true };

        this.screenProducer = await this.sendTransport.produce({
          track,
          appData: { type: 'screen' }
        });

        this.onPeerStateChange?.(this.peerId, this.peerStates[this.peerId]);
        this._send({ type: 'screen-share-start', from: this.peerId });

        track.onended = () => this.stopScreenShare();
      } else {
        this.stopScreenShare();
      }
    } catch (e) {
      console.error("Screen share error:", e.message);
    }
  }

  stopScreenShare() {
  if (!this.screenTrack) return;
  console.log("🛑 Stopping screen share");

   if (this.screenProducer) {
    try { this.screenProducer.close(); } catch(e) {}
    this.screenProducer = null;
  }

  this.ws?.send(JSON.stringify({ type: "screen-share-stop", from: this.peerId }));

  delete this.screenSharers[this.peerId];
  this.peerStates[this.peerId] = { ...(this.peerStates[this.peerId] || {}), isScreenSharing: false };

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

  _removeRecordingPeer(peerId) {
    const src = this.peerAudioSources[peerId];
    if (src) { try { src.disconnect(); } catch (_) {} delete this.peerAudioSources[peerId]; }
  }

  updatePeerUI(peerId) {
    const state = this.peerStates[peerId] || {};
    this.onPeerStateChange?.(peerId, state);
  }

  
  updateQualityBadge(peerId, quality, rtt) {
    const ms = rtt ? (rtt * 1000).toFixed(0) : "?";
    this.onQuality?.(peerId, { quality, ms });
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


  sendChat(msg) {
    if (!msg) return;

    this.addChatMsg(`You: ${msg}`);

    if (this.dataProducer) {
      this.dataProducer.send(msg);
    } else {
      console.warn("⚠️ DataProducer not ready");
    }
  }

  addChatMsg(msg) {
    this.onChat?.(msg);
  }
  
  leave() {
    console.log("🚪 Leaving room...");

    if (this.dataProducer) {
      try { this.dataProducer.close(); } catch(e) {}
      this.dataProducer = null;
    }

    for (const [id, dc] of this.dataConsumers) {
      try { dc.close(); } catch(e) {}
    }
    this.dataConsumers.clear();

    if (this.sendTransport) {
      try { this.sendTransport.close(); } catch(e) {}
      this.sendTransport = null;
    }
    if (this.recvTransport) {
      try { this.recvTransport.close(); } catch(e) {}
      this.recvTransport = null;
    }
    
    this.localStream = null;

    if (this.screenProducer) {
      try { this.screenProducer.close(); } catch(e) {}
      this.screenProducer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this._produced = false;
    this._producersRequested = false;
    this._rtpSent = false;
    this.device = null;
    this.peers = new Set();
    this.peerStates = {};
    this.screenSharers = {};
    this.dataConsumers = new Map();
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
    console.log("🚀 Requesting BOTH transports from server...");

    // 1️⃣ SEND transport
    this._send({
      type: 'create-transport',
      direction: 'send'
    });

    // 2️⃣ RECV transport
    this._send({
      type: 'create-transport',
      direction: 'recv'
    });
  }
}

