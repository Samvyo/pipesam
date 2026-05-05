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
  }, [room, myPeerId]);
  
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
    cameraRow: { display:"flex", justifyContent:"center", flexWrap:"nowrap", gap:8, padding:8, background:"#0a0a0e", flexShrink:0, height:170, minHeight:170, maxHeight:170, overflow:"hidden" },
    controls: { display:"flex", gap:6, padding:"8px 12px", background:"#16161a", flexShrink:0, flexWrap:"wrap", borderTop:"1px solid #2a2a35", alignItems:"center" },
    chatLog: { maxHeight:80, overflowY:"auto", padding:"4px 16px", background:"#0f0f14", fontSize:12 },
    chatInput: { flex:1, background:"#0d0d0f", color:"#e8e8ec", border:"1px solid #2a2a35", padding:"7px 12px", borderRadius:8, fontSize:13, outline:"none" },
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
          room.joinRoom(null, roomId);
          setJoined(true);
          setMyPeerId(username);
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

      {/* SCREEN SHARE — local preview
      {localScreenStream && (
        <div style={S.screenArea}>
          <video
            autoPlay
            muted
            playsInline
            data-type="screen"
            style={{ maxWidth:"100%", maxHeight:"100%", objectFit:"contain" }}
            ref={el => {
              if (!el || !localScreenStream) return;
              if (el.srcObject !== localScreenStream) {
                el.srcObject = localScreenStream;
                el.onloadedmetadata = () => el.play().catch(() => {});
              }
            }}
          />
          <span style={{ position:"absolute", bottom:8, left:8, background:"rgba(0,0,0,0.7)", padding:"4px 10px", borderRadius:6, fontSize:11, color:"#e8e8ec" }}>
            🖥 You (screen)
          </span>
        </div>
      )} */}

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
            style={{ width:200, height:150, minWidth:200, objectFit:"cover", borderRadius:10, border:"2px solid #252530" }}
          />
          <span style={{ position:"absolute", bottom:4, left:4, color:"#e8e8ec", fontSize:10, background:"rgba(0,0,0,0.7)", padding:"2px 6px", borderRadius:4 }}>
            {myPeerId||"You"} {myState.muted?"🔇":"🔊"} {myState.videoOff?"📷❌":"📷"}
          </span>
        </div>

        {/* Remote cameras */}
        {Object.entries(streams).map(([pid, stream]) => (
          <div key={pid} style={{ position:"relative" }}>
            <video data-type="camera" autoPlay playsInline
              style={{ width:200, height:150, minWidth:200, objectFit:"cover", borderRadius:10, border:"2px solid #252530" }}
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
        <button style={S.btn()} onClick={() => room.startRecording()}>⏺ Record</button>
        <button style={S.btn()} onClick={() => room.stopRecording()}>⏹ Stop</button>

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
    </div>
  );
}

export default App;