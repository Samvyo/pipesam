import { useEffect, useRef, useState } from "react";
import { useRoom } from "./rtc/RoomContext.jsx";
import { useNavigate } from 'react-router-dom';

function parseJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64));
  } catch (e) {
    console.error("Invalid token", e);
    return null;
  }
}

function App() {
  const room = useRoom();
  const videoRef = useRef();
  const qualityRef = useRef({});
  const borderRefs = useRef({});
  const usernameRef = useRef("");
  const myPeerIdRef = useRef("");
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("");
  const [chatInput, setChatInput] = useState("");

  const [chat, setChat] = useState([]);
  const [users, setUsers] = useState([]);
  const [peerState, setPeerState] = useState({});
  const [token, setToken] = useState("");
  const [joined, setJoined] = useState(false);
  const [myPeerId, setMyPeerId] = useState("");

  const [streams, setStreams] = useState({});
  const [audioStreams, setAudioStreams] = useState({});
  const [screenStreams, setScreenStreams] = useState({});
  const [localScreenStream, setLocalScreenStream] = useState(null);
  const [statsPanel, setStatsPanel] = useState(null); // { peerId, data }
  const [statsLoading, setStatsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingBy, setRecordingBy] = useState(null);
  const [recordingError, setRecordingError] = useState(null);
  const [isMyRecording, setIsMyRecording] = useState(false); 
  
  const screenEntries = Object.entries(screenStreams);
  // const activeScreenStream = localScreenStream || (screenEntries.length > 0 ? screenEntries[0][1] : null);

  // ─── callbacks ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!room) return;

    room.onLocalScreenStream = (stream) => setLocalScreenStream(stream || null);
    room.onMessage = () => {};
    room.onChat = (msg) => setChat(prev => [...prev, msg]);

    room.onPeersUpdate = (list) => {
      setUsers(list);
      
      setTimeout(() => {
        list.forEach(pid => {
          if (pid === room.peerId) return;
          const state = room.peerStates[pid];
          if (!state) return;
          const muteIcon = document.getElementById(`mute-icon-${pid}`);
          if (muteIcon) muteIcon.style.display = state.muted ? "flex" : "none";
          const labelMute = document.getElementById(`label-mute-${pid}`);
          if (labelMute) labelMute.textContent = state.muted ? "🔇" : "🔊";
          const userMute = document.getElementById(`user-mute-${pid}`);
          if (userMute) userMute.textContent = state.muted ? " 🔇" : " 🔊";
          const videoOff = document.getElementById(`videooff-${pid}`);
          if (videoOff) videoOff.style.display = state.videoOff ? "flex" : "none";
          const userVideo = document.getElementById(`user-video-${pid}`);
          if (userVideo) userVideo.textContent = state.videoOff ? " 📷❌" : "";
        });
      }, 300);

      setStreams(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(k => { if (!list.includes(k.split("-")[0])) delete updated[k]; });
        return updated;
      });
      setScreenStreams(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(k => { if (!list.includes(k.split("-")[0])) delete updated[k]; });
        return updated;
      });
      setAudioStreams(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(k => { if (!list.includes(k.split("-")[0])) delete updated[k]; });
        return updated;
      });
      Object.keys(qualityRef.current).forEach(k => { if (!list.includes(k.split("-")[0])) delete qualityRef.current[k]; });
      Object.keys(borderRefs.current).forEach(k => { if (!list.includes(k.split("-")[0])) delete borderRefs.current[k]; });
    };

    room.onPeerStateChange = (peerId, state) => {
      if (peerId === room.peerId) {
        setPeerState(prev => ({ ...prev, [peerId]: { ...(prev[peerId] || {}), ...state } }));
        return;
      }
      if ('muted' in state) {
        if (borderRefs.current[peerId]) borderRefs.current[peerId].style.border = `2px solid ${state.muted ? "#f44" : "#444"}`;
        const muteIcon = document.getElementById(`mute-icon-${peerId}`);
        if (muteIcon) muteIcon.style.display = state.muted ? "flex" : "none";
        const labelMute = document.getElementById(`label-mute-${peerId}`);
        if (labelMute) labelMute.textContent = state.muted ? "🔇" : "🔊";
        const userMute = document.getElementById(`user-mute-${peerId}`);
        if (userMute) userMute.textContent = state.muted ? " 🔇" : " 🔊";
      }
      if ('videoOff' in state) {
        const videoOff = document.getElementById(`videooff-${peerId}`);
        if (videoOff) videoOff.style.display = state.videoOff ? "flex" : "none";
        const userVideo = document.getElementById(`user-video-${peerId}`);
        if (userVideo) userVideo.textContent = state.videoOff ? " 📷❌" : "";
      }
      if ('isScreenSharing' in state) {
        const screenIcon = document.getElementById(`label-screen-${peerId}`);
        if (screenIcon) screenIcon.textContent = state.isScreenSharing ? " 🖥" : "";
        const userScreen = document.getElementById(`user-screen-${peerId}`);
        if (userScreen) userScreen.textContent = state.isScreenSharing ? " 🖥" : "";
      }
    };

    room.onTrack = (peerId, stream) => {
      if (!stream) { setStreams(prev => { const u = {...prev}; delete u[peerId]; return u; }); return; }
      // const videoTrack = stream.getVideoTracks()[0];
      // if (!videoTrack) return;
      setStreams(prev => ({ ...prev, [peerId]: stream}));
    };

    room.onAudioTrack = (peerId, stream) => {
      if (!stream) { setAudioStreams(prev => { const u = {...prev}; delete u[peerId]; return u; }); return; }
      setAudioStreams(prev => ({ ...prev, [peerId]: stream }));
    };

    room.onScreenShare = (peerId, stream) => {
      setScreenStreams(prev => {
        const updated = { ...prev };
        if (!stream) delete updated[peerId];
        else updated[peerId] = stream;
        return updated;
      });
    };

    room.onQuality = (peerId, data) => {
      qualityRef.current[peerId] = data;
      const color = data.quality === "good" ? "#4f4" : data.quality === "fair" ? "#ff4" : "#f44";
      const icon  = data.quality === "good" ? "🟢" : data.quality === "fair" ? "🟡" : "🔴";
      const text  = `${icon} ${data.ms}ms`;
      const badge = document.getElementById(`quality-badge-${peerId}`);
      if (badge) { badge.style.color = color; badge.textContent = text; }
      const userBadge = document.getElementById(`quality-user-${peerId}`);
      if (userBadge) { userBadge.style.color = color; userBadge.textContent = ` ${text}`; }
    };
    room.onRecordingChange = (active, startedBy) => {
      setIsRecording(active);
      setRecordingBy(startedBy || null);
      setIsMyRecording(active && startedBy === myPeerIdRef.current); 
    };

    room.onRecordingError = (msg) => {
      setRecordingError(msg);
      setTimeout(() => setRecordingError(null), 4000);
    };
  }, [room]);
  
  const [previewStream, setPreviewStream] = useState(null);

  useEffect(() => {
  let streamRef;

  const startPreview = async () => {
    try {
      streamRef = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

      setPreviewStream(streamRef);

      // 🔥 ALWAYS attach preview
      if (videoRef.current) {
        videoRef.current.srcObject = streamRef;
      }

      // 🔥 also prepare for join
      room.localStream = streamRef;

    } catch (e) {
      console.warn("Camera preview failed:", e.message);
    }
  };

  startPreview();

  return () => {
    // ❌ DO NOT stop tracks here
  };
}, [navigate]); // 🔥 important change

  // ─── leave handler ────────────────────────────────────────────────────────────
  const handleLeave = () => {
    try {
      room.leave();
    } catch (e) {
      console.warn("Leave error:", e);
    }

    // 🔥 FULL RESET
    setJoined(false);
    setStreams({});
    setAudioStreams({});
    setScreenStreams({});
    setLocalScreenStream(null);
    setUsers([]);
    setChat([]);
    setMyPeerId("");
    setPeerState({});

    // 🔥 CLEAR INPUTS
    setToken("");
    setUsername("");
    setRoomId("");

    // 🔥 FORCE NAVIGATION
    navigate('/feedback', { replace: true });
  };

  const myState = peerState[myPeerId] || {};
  const activeScreen =
    localScreenStream ||
    Object.values(screenStreams)[0] ||
    null;

  // ─── styles ───────────────────────────────────────────────────────────────────
  const S = {
    root: { display:"flex", flexDirection:"column", height:"100vh", overflow:"hidden", background:"#0d0d0f", color:"#e8e8ec", fontFamily:"'DM Sans', system-ui, sans-serif" },
    topBar: { display:"flex", gap:8, padding:"10px 16px", background:"#16161a", flexShrink:0, borderBottom:"1px solid #2a2a35", alignItems:"center" },
    input: { background:"#0d0d0f", color:"#e8e8ec", border:"1px solid #2a2a35", padding:"7px 12px", borderRadius:8, fontSize:13, outline:"none" },
    btn: (bg) => ({ background:bg||"#252530", color:"#e8e8ec", border:"none", padding:"7px 14px", borderRadius:8, cursor:"pointer", fontSize:13, fontWeight:500, transition:"opacity 0.15s" }),
    usersBar: { display:"flex", alignItems:"center", gap:8, padding:"6px 16px", background:"#13131a", flexShrink:0, fontSize:12, borderBottom:"1px solid #1e1e28", flexWrap:"wrap" },
    chip: (color, bg) => ({ color, background:bg, padding:"3px 10px", borderRadius:20, fontSize:11, fontWeight:500 }),
    screenArea: { flex:1, minHeight:0, position:"relative", display:"flex", justifyContent:"center", alignItems:"center", background:"#000", overflow:"hidden" },
    cameraRow: { display:"flex", justifyContent:"center", flexWrap:"nowrap", gap:8, padding:8, background:"#0a0a0e", flexShrink:0, height:200, minHeight:200, maxHeight:200, overflow:"hidden" },
    controls: { display:"flex", gap:6, padding:"8px 12px", background:"#16161a", flexShrink:0, flexWrap:"wrap", borderTop:"1px solid #2a2a35", alignItems:"center" },
    chatLog: { maxHeight:80, overflowY:"auto", padding:"4px 16px", background:"#0f0f14", fontSize:12 },
    chatInput: { flex:1, background:"#0d0d0f", color:"#e8e8ec", border:"1px solid #2a2a35", padding:"7px 12px", borderRadius:8, fontSize:13, outline:"none" },
  };

  const fetchStats = async (peerId) => {
  setStatsLoading(true);
  try {
    const protocol = window.location.protocol;
    const res = await fetch(`${protocol}//${window.location.hostname}:3000/stats`);
    const data = await res.json();
    setStatsPanel({ peerId, data });
  } catch(e) {
    console.error("Stats fetch failed:", e);
  }
  setStatsLoading(false);
};


  return (
    <div style={S.root}>

      {/* Hidden audio players */}
      {Object.entries(audioStreams).map(([peerId, stream]) => (
        <audio key={peerId} autoPlay playsInline
          ref={el => { if (!el || !stream) return; if (el.srcObject !== stream) { el.srcObject = stream; el.play().catch(() => {}); } }}
          style={{ display:"none" }}
        />
      ))}

      {/* TOP BAR */}
      <div style={S.topBar}>
        <span style={{ fontWeight:700, fontSize:15, color:"#7c6af7", marginRight:4 }}>Video Call</span>
        <input placeholder="Token" value={token} onChange={e => setToken(e.target.value)} style={{ ...S.input, flex:2 }} />
        <input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} style={{ ...S.input, flex:1 }} />
        <input placeholder="Room" value={roomId} onChange={e => setRoomId(e.target.value)} style={{ ...S.input, flex:1 }} />
        <button style={{ ...S.btn("#7c6af7"), fontWeight:700 }} onClick={() => {
          if (!username || !roomId || !token) { alert("Enter username, room and token"); return; }
          const payload = parseJwt(token);
          if (!payload) { alert("❌ Invalid token"); return; }
          if (String(payload.username) !== String(username)) { alert("❌ Username mismatch"); return; }
          if (String(payload.roomId) !== String(roomId)) { alert("❌ RoomId mismatch"); return; }
          localStorage.setItem("token", token);

          usernameRef.current = username;   // ← MUST be BEFORE joinRoom
          setMyPeerId(username);
          myPeerIdRef.current = username;
          setJoined(true);
          room.joinRoom(null, roomId);
          // setIsModerator(true); 
        }}>Join</button>
      </div>

      {/* ACTIVE USERS BAR */}
      {joined && (
        <div style={S.usersBar}>
          <span style={{ color:"#555" }}>👥</span>
          {users.length <= 1 ? (
            <>
              {users.map(u => <span key={u} style={S.chip("#7c6af7","rgba(124,106,247,0.12)")}>{u} (you)</span>)}
              <span style={{ color:"#f5a623", fontSize:11 }}>⏳ Waiting for others...</span>
            </>
          ) : users.map(u => (
            <span key={u} style={S.chip(u===myPeerId?"#7c6af7":"#4de8a0", u===myPeerId?"rgba(124,106,247,0.12)":"rgba(77,232,160,0.1)")}>
              {u}
              {u === myPeerId && <span style={{ color:"#555" }}> (you)</span>}
              {u === myPeerId
                ? <>{" "}{myState.muted?"🔇":"🔊"}{myState.videoOff?" 📷❌":""}{myState.isScreenSharing?" 🖥":""}</>
                : <><span id={`user-mute-${u}`}> 🔊</span><span id={`user-video-${u}`}/><span id={`user-screen-${u}`}/></>
              }
              {u !== myPeerId && <span id={`quality-user-${u}`} style={{ marginLeft:4, color:"#555", fontSize:10 }}>⚪ --ms</span>}
            </span>
          ))}
        </div>
      )}

      {/* Recording indicator bar */}
{isRecording && (
  <div style={{
    display:"flex", alignItems:"center", gap:8,
    padding:"5px 16px", background:"rgba(192,57,43,0.15)",
    borderBottom:"1px solid rgba(192,57,43,0.3)", flexShrink:0
  }}>
    <span style={{
      width:10, height:10, borderRadius:"50%", background:"#c0392b",
      animation:"recPulse 1.4s ease-in-out infinite"
    }}/>
    <span style={{ fontSize:12, color:"#e8a0a0" }}>
      Recording in progress{recordingBy ? ` · started by ${recordingBy}` : ""}
    </span>
    <style>{`
      @keyframes recPulse {
        0%,100% { opacity:1; box-shadow:0 0 0 0 rgba(192,57,43,0.6); }
        50%      { opacity:0.7; box-shadow:0 0 0 6px rgba(192,57,43,0); }
      }
    `}</style>
  </div>
)}

{/* Recording error toast */}
{recordingError && (
  <div style={{
    position:"fixed", bottom:80, left:"50%", transform:"translateX(-50%)",
    background:"#c0392b", color:"#fff", padding:"10px 20px",
    borderRadius:8, fontSize:13, zIndex:2000,
    boxShadow:"0 4px 16px rgba(0,0,0,0.4)"
  }}>
    ⚠️ {recordingError}
  </div>
)}

      {activeScreen && (
         <div style={S.screenArea}>
          <video
            autoPlay
            playsInline
            data-type="screen"
            style={{ maxWidth:"100%", maxHeight:"100%", objectFit:"contain" }}
            ref={el => {
              if (!el || !activeScreen) return;
              if (el.srcObject !== activeScreen) {
                el.srcObject = activeScreen;
                el.muted = false;
                el.onloadedmetadata = () => el.play().catch(() => {});
              }
            }}
          />
          <span style={{
            position:"absolute",
            bottom:8,
            left:8,
            background:"rgba(0,0,0,0.7)",
            padding:"4px 10px",
            borderRadius:6,
            fontSize:11,
            color:"#e8e8ec"
          }}>
            🖥 Screen Share
          </span>
        </div>
      )}

      {/* CAMERA ROW */}
      <div style={S.cameraRow}>
        {/* Local */}
        <div style={{ position:"relative" }}>
          <video ref={videoRef} autoPlay muted data-type="camera"
            style={{ width:240, height:180, minWidth:240, objectFit:"cover", borderRadius:10, border:"2px solid #252530" }}
          />
          <button onClick={() => fetchStats(myPeerId)} style={{
            position:"absolute", top:6, right:6, background:"rgba(124,106,247,0.85)",
            border:"none", borderRadius:"50%", width:22, height:22, cursor:"pointer",
            color:"#fff", fontSize:11, lineHeight:"22px", textAlign:"center"
          }}>ℹ</button>
          <span style={{ position:"absolute", bottom:4, left:4, color:"#e8e8ec", fontSize:10, background:"rgba(0,0,0,0.7)", padding:"2px 6px", borderRadius:4 }}>
            {myPeerId||"You"} {myState.muted?"🔇":"🔊"} {myState.videoOff?"📷❌":"📷"}
          </span>
        </div>

        {/* Remote cameras */}
        {Object.entries(streams).map(([pid, stream]) => (
          <div key={pid} style={{ position:"relative" }}>
            <video data-type="camera" autoPlay playsInline
              style={{ width:240, height:180, minWidth:240, objectFit:"cover", borderRadius:10, border:"2px solid #252530" }}
              ref={el => {
                if (!el || !stream) return;
                borderRefs.current[pid] = el;
                if (el.srcObject !== stream) {
                  el.srcObject = stream; el.muted=false; el.autoplay=true; el.playsInline=true;
                  el.onloadedmetadata = () => el.play().catch(() => {});
                }
              }}
            />
            <div id={`quality-badge-${pid}`} style={{ position:"absolute", top:6, left:6, background:"rgba(0,0,0,0.75)", padding:"2px 5px", borderRadius:4, fontSize:10, color:"#666" }}>⚪ --ms</div>
            <div id={`mute-icon-${pid}`} style={{ display:"none", position:"absolute", top:6, right:6, background:"rgba(200,0,0,0.85)", borderRadius:"50%", width:24, height:24, alignItems:"center", justifyContent:"center", fontSize:12 }}>🔇</div>
            <div id={`videooff-${pid}`} style={{ display:"none", position:"absolute", inset:0, background:"rgba(0,0,0,0.82)", alignItems:"center", justifyContent:"center", borderRadius:10, fontSize:24 }}>📷❌</div>
            <button onClick={() => fetchStats(pid)} style={{
              position:"absolute", top:6, right:32, background:"rgba(124,106,247,0.85)",
              border:"none", borderRadius:"50%", width:22, height:22, cursor:"pointer",
              color:"#fff", fontSize:11, lineHeight:"22px", textAlign:"center"
            }}>ℹ</button>
            <span style={{ position:"absolute", bottom:4, left:4, color:"#e8e8ec", fontSize:10, background:"rgba(0,0,0,0.7)", padding:"2px 6px", borderRadius:4 }}>
              {pid} <span id={`label-mute-${pid}`}>🔊</span><span id={`label-screen-${pid}`}/>
            </span>
          </div>
        ))}
      </div>

      {/* CONTROLS */}
      <div style={S.controls}>
        <button style={S.btn(myState.muted?"#c0392b":undefined)} onClick={() => room.toggleAudio()}>
          {myState.muted ? "🔇 Unmute" : "🔊 Mute"}
        </button>
        <button style={S.btn(myState.videoOff?"#c0392b":undefined)} onClick={() => room.toggleVideo()}>
          {myState.videoOff ? "📷 Cam On" : "📷 Cam Off"}
        </button>
        <button style={S.btn(myState.isScreenSharing?"#e67e22":undefined)} onClick={() => room.toggleScreenShare()}>
          {myState.isScreenSharing ? "🛑 Stop Share" : "🖥 Share"}
        </button>

      {isMyRecording ? (
        <button style={S.btn("#c0392b")} onClick={() => room.stopRecording()}>
          ⏹ Stop Rec
        </button>
      ) : !isRecording ? (
        <button style={S.btn("#27ae60")} onClick={() => room.startRecording()}>
          ⏺ Record
        </button>
      ) : (
        <button style={{ ...S.btn("#555"), cursor:"not-allowed", opacity:0.5 }} disabled>
          ⏺ Recording...
        </button>
      )}
        {/* ✅ LEAVE BUTTON — redirects to /feedback */}
        <button style={{ ...S.btn("#c0392b"), fontWeight:700, marginLeft:"auto" }} onClick={handleLeave}>
          🚪 Leave
        </button>

        <input value={chatInput} onChange={e => setChatInput(e.target.value)}
          onKeyDown={e => { if (e.key==="Enter") { room.sendChat(chatInput); setChatInput(""); } }}
          placeholder="Chat..." style={S.chatInput}
        />
        <button style={S.btn("#7c6af7")} onClick={() => { room.sendChat(chatInput); setChatInput(""); }}>Send</button>
      </div>

  
      {/* CHAT LOG */}
      <div style={S.chatLog}>
        {chat.map((c, i) => <div key={i} style={{ color:"#888", padding:"1px 0" }}>{c}</div>)}
      </div>

      {/* STATS PANEL */}
      {statsPanel && (
        <div style={{
          position:"fixed", top:0, right:0, width:380, height:"100vh",
          background:"#13131a", borderLeft:"1px solid #2a2a35",
          overflowY:"auto", zIndex:1000, padding:16, fontSize:12,
          color:"#e8e8ec"
        }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <span style={{ fontWeight:700, fontSize:14, color:"#7c6af7" }}>📊 Stats — {statsPanel.peerId}</span>
            <button onClick={() => setStatsPanel(null)} style={{
              background:"none", border:"none", color:"#888", cursor:"pointer", fontSize:18
            }}>✕</button>
          </div>

          {Object.entries(statsPanel.data).map(([roomId, roomData]) => (
            <div key={roomId}>

              {/* Producers */}
              {roomData.producers?.filter(p => p.peerId === statsPanel.peerId).map(p => (
                <div key={p.producerId} style={{ marginBottom:12 }}>
                  <div style={{ color:"#7c6af7", fontWeight:600, marginBottom:6, padding:"4px 8px", background:"rgba(124,106,247,0.1)", borderRadius:6 }}>
                    📤 Producer — {p.kind}
                  </div>
                  {p.stats?.[0] && Object.entries(p.stats[0]).map(([k, v]) => (
                    <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"2px 8px", borderBottom:"1px solid #1e1e28" }}>
                      <span style={{ color:"#888" }}>{k}</span>
                      <span style={{ color:"#e8e8ec", fontFamily:"monospace" }}>{String(v)}</span>
                    </div>
                  ))}
                </div>
              ))}

              {/* Consumers */}
              {roomData.consumers?.filter(c =>
                c.producerPeerId === statsPanel.peerId || c.consumingPeerId === statsPanel.peerId
              ).map(c => (
                <div key={c.consumerId} style={{ marginBottom:12 }}>
                  <div style={{ color:"#4de8a0", fontWeight:600, marginBottom:6, padding:"4px 8px", background:"rgba(77,232,160,0.1)", borderRadius:6 }}>
                    📥 Consumer — {c.kind} ({c.producerPeerId} → {c.consumingPeerId})
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", padding:"2px 8px", borderBottom:"1px solid #1e1e28" }}>
                    <span style={{ color:"#888" }}>currentLayers</span>
                    <span style={{ color:"#e8e8ec", fontFamily:"monospace" }}>{JSON.stringify(c.currentLayers)}</span>
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", padding:"2px 8px", borderBottom:"1px solid #1e1e28" }}>
                    <span style={{ color:"#888" }}>preferredLayers</span>
                    <span style={{ color:"#e8e8ec", fontFamily:"monospace" }}>{JSON.stringify(c.preferredLayers)}</span>
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", padding:"2px 8px", borderBottom:"1px solid #1e1e28" }}>
                    <span style={{ color:"#888" }}>score</span>
                    <span style={{ color:"#e8e8ec", fontFamily:"monospace" }}>{JSON.stringify(c.score)}</span>
                  </div>
                  {c.stats?.[0] && Object.entries(c.stats[0]).map(([k, v]) => (
                    <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"2px 8px", borderBottom:"1px solid #1e1e28" }}>
                      <span style={{ color:"#888" }}>{k}</span>
                      <span style={{ color:"#e8e8ec", fontFamily:"monospace" }}>{String(v)}</span>
                    </div>
                  ))}
                </div>
              ))}

              {/* Transports */}
              {roomData.transports?.filter(t => t.peerId === statsPanel.peerId).map((t, i) => (
                <div key={i} style={{ marginBottom:12 }}>
                  <div style={{ color:"#f5a623", fontWeight:600, marginBottom:6, padding:"4px 8px", background:"rgba(245,166,35,0.1)", borderRadius:6 }}>
                    🚌 Transport — {t.direction}
                  </div>
                  {t.stats?.[0] && Object.entries(t.stats[0]).map(([k, v]) => (
                    <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"2px 8px", borderBottom:"1px solid #1e1e28" }}>
                      <span style={{ color:"#888" }}>{k}</span>
                      <span style={{ color:"#e8e8ec", fontFamily:"monospace" }}>{String(v)}</span>
                    </div>
                  ))}
                </div>
              ))}

            </div>
          ))}

          <button onClick={() => fetchStats(statsPanel.peerId)} style={{
            width:"100%", marginTop:12, padding:"8px", background:"rgba(124,106,247,0.2)",
            color:"#7c6af7", border:"1px solid #7c6af7", borderRadius:8, cursor:"pointer", fontSize:12
          }}>
            {statsLoading ? "Loading..." : "🔄 Refresh Stats"}
          </button>
        </div>
      )}

    </div>   
  );
}

export default App;
  
