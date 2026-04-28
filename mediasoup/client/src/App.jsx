import { useEffect, useRef, useState } from "react";
import { useRoom } from "./rtc/RoomContext.jsx";

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

  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("");
  const [chatInput, setChatInput] = useState("");

  const [chat, setChat] = useState([]);
  const [users, setUsers] = useState([]);
  const [peerState, setPeerState] = useState({});  // ✅ only used for OWN controls
  const [token, setToken] = useState("");
  const [joined, setJoined] = useState(false);
  const [myPeerId, setMyPeerId] = useState("");

  const [streams, setStreams] = useState({});
  const [audioStreams, setAudioStreams] = useState({});
  const [screenStreams, setScreenStreams] = useState({});
  const [localScreenStream, setLocalScreenStream] = useState(null);

  const screenEntries = Object.entries(screenStreams);
  const activeScreenStream = localScreenStream || (screenEntries.length > 0 ? screenEntries[0][1] : null);

  useEffect(() => {
    if (!room) return;

    // room.onLocalStream = (stream) => {
    //   if (videoRef.current) videoRef.current.srcObject = stream;
    // };

    room.onLocalScreenStream = (stream) => {
      setLocalScreenStream(stream || null);
    };

    room.onMessage = () => {};

    room.onChat = (msg) => {
      setChat(prev => [...prev, msg]);
    };

    room.onPeersUpdate = (list) => {
      setUsers(list);
      setTimeout(() => {
        list.forEach(pid => {
          if (pid === room.peerId) return;
          const state = room.peerStates[pid];
          if (!state) return;

        // apply mute
          const muteIcon = document.getElementById(`mute-icon-${pid}`);
          if (muteIcon) muteIcon.style.display = state.muted ? "flex" : "none";
          const labelMute = document.getElementById(`label-mute-${pid}`);
          if (labelMute) labelMute.textContent = state.muted ? "🔇" : "🔊";
          const userMute = document.getElementById(`user-mute-${pid}`);
          if (userMute) userMute.textContent = state.muted ? " 🔇" : " 🔊";

        // apply video
          const videoOff = document.getElementById(`videooff-${pid}`);
          if (videoOff) videoOff.style.display = state.videoOff ? "flex" : "none";
          const userVideo = document.getElementById(`user-video-${pid}`);
          if (userVideo) userVideo.textContent = state.videoOff ? " 📷❌" : "";
        });
      }, 300);


      setStreams(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(k => { if (!list.includes(k)) delete updated[k]; });
        return updated;
      });
      setScreenStreams(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(k => { if (!list.includes(k)) delete updated[k]; });
        return updated;
      });
      setAudioStreams(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(k => { if (!list.includes(k)) delete updated[k]; });
        return updated;
      });
      Object.keys(qualityRef.current).forEach(k => {
        if (!list.includes(k)) delete qualityRef.current[k];
      });
      Object.keys(borderRefs.current).forEach(k => {
        if (!list.includes(k)) delete borderRefs.current[k];
      });
    };

    room.onPeerStateChange = (peerId, state) => {
      // ✅ own state through React — needed for control button colors
      if (peerId === room.peerId) {
        setPeerState(prev => ({
          ...prev,
          [peerId]: { ...(prev[peerId] || {}), ...state }
        }));
        return;
      }

      // ✅ peer state — pure DOM updates, zero React re-render, zero blink
      if ('muted' in state) {
        if (borderRefs.current[peerId]) {
          borderRefs.current[peerId].style.border =
            `2px solid ${state.muted ? "#f44" : "#444"}`;
        }
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
      if (stream.getVideoTracks().length > 0) {
        setStreams(prev => ({ ...prev, [peerId]: stream }));
      }
    };

    room.onAudioTrack = (peerId, stream) => {
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
      const color = data.quality === "good" ? "#4f4"
                  : data.quality === "fair" ? "#ff4" : "#f44";
      const icon  = data.quality === "good" ? "🟢"
                  : data.quality === "fair" ? "🟡" : "🔴";
      const text  = `${icon} ${data.ms}ms`;

      const badge = document.getElementById(`quality-badge-${peerId}`);
      if (badge) { badge.style.color = color; badge.textContent = text; }

      const userBadge = document.getElementById(`quality-user-${peerId}`);
      if (userBadge) { userBadge.style.color = color; userBadge.textContent = ` ${text}`; }
    };

  }, [room, myPeerId]);

  useEffect(() => {
  // ✅ set BEFORE getUserMedia so joinRoom reuses same stream
  room.onLocalStream = (stream) => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  };

  navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    .then(stream => {
      room.localStream = stream;  // ✅ pre-set so joinRoom won't call getUserMedia again
      if (videoRef.current) videoRef.current.srcObject = stream;
    })
    .catch(e => console.warn("Camera preview failed:", e.message));
}, [room]);

  const myState = peerState[myPeerId] || {};

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", background: "#111", color: "#fff" }}>

      {/* Hidden audio players */}
      {Object.entries(audioStreams).map(([peerId, stream]) => (
        <audio
          key={peerId}
          autoPlay
          playsInline
          ref={el => {
            if (!el || !stream) return;
            if (el.srcObject !== stream) {
              el.srcObject = stream;
              el.play().catch(e => console.warn("Audio play blocked:", peerId, e.message));
            }
          }}
          style={{ display: "none" }}
        />
      ))}

      {/* TOP BAR */}
      <div style={{ display: "flex", gap: 8, padding: "8px 12px", background: "#222", flexShrink: 0 }}>
        <input placeholder="Token" value={token} onChange={e => setToken(e.target.value)} style={{ flex: 2 }} />
        <input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} style={{ flex: 1 }} />
        <input placeholder="Room" value={roomId} onChange={e => setRoomId(e.target.value)} style={{ flex: 1 }} />
        <button onClick={() => {
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
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px", background: "#1a1a2e", flexShrink: 0, fontSize: 12, borderBottom: "1px solid #333", flexWrap: "wrap" }}>
          <span style={{ color: "#888" }}>👥</span>
          {users.length <= 1 ? (
            <>
              {users.map(u => (
                <span key={u} style={{ color: "#4af", background: "rgba(68,170,255,0.1)", padding: "2px 8px", borderRadius: 12 }}>
                  {u} (you)
                </span>
              ))}
              <span style={{ color: "#f90" }}>⏳ Waiting for others to join...</span>
            </>
          ) : (
            users.map(u => (
              <span key={u} style={{
                color: u === myPeerId ? "#4af" : "#7f7",
                background: u === myPeerId ? "rgba(68,170,255,0.1)" : "rgba(100,255,100,0.1)",
                padding: "2px 8px", borderRadius: 12
              }}>
                {u}
                {u === myPeerId && <span style={{ color: "#888" }}> (you)</span>}
                {u === myPeerId
                  ? <>{" "}{myState.muted ? "🔇" : "🔊"}{myState.videoOff ? " 📷❌" : ""}{myState.isScreenSharing ? " 🖥" : ""}</>
                  : <><span id={`user-mute-${u}`}> 🔊</span><span id={`user-video-${u}`}></span><span id={`user-screen-${u}`}></span></>
                }
                {u !== myPeerId && (
                  <span id={`quality-user-${u}`} style={{ marginLeft: 4, color: "#888", fontSize: 11 }}>⚪ --ms</span>
                )}
              </span>
            ))
          )}
        </div>
      )}

      {/* SCREEN SHARE */}
      {activeScreenStream && (
        <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", justifyContent: "center", alignItems: "center", background: "#000", overflow: "hidden" }}>
          <video
            data-type="screen" autoPlay playsInline
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            ref={el => {
              if (!el || !activeScreenStream) return;
              const currentId = el.srcObject?.getVideoTracks()[0]?.id;
              const newId = activeScreenStream?.getVideoTracks()[0]?.id;
              if (currentId !== newId) { el.srcObject = activeScreenStream; el.muted = true; }
            }}
          />
          <span style={{ position: "absolute", bottom: 8, left: 8, background: "rgba(0,0,0,0.7)", padding: "4px 8px", borderRadius: 4, fontSize: 12, color: "#fff" }}>
            🖥 {localScreenStream ? "You" : Object.keys(screenStreams)[0]}
          </span>
        </div>
      )}

      {/* CAMERA ROW */}
      <div style={{ display: "flex", justifyContent: "center", flexWrap: "nowrap", gap: 8, padding: 8, background: "#050314", flexShrink: 0, height: 170, minHeight: 170, maxHeight: 170, overflow: "hidden" }}>

        {/* Local camera */}
        <div style={{ position: "relative" }}>
          <video
            ref={videoRef} autoPlay muted data-type="camera"
            style={{ width: 200, height: 150, minWidth: 200, objectFit: "cover", borderRadius: 8, border: "2px solid #444" }}
          />
          <span style={{ position: "absolute", bottom: 4, left: 4, color: "#fff", fontSize: 11, background: "rgba(0,0,0,0.6)", padding: "2px 6px", borderRadius: 4 }}>
            {myPeerId || "You"} {myState.muted ? "🔇" : "🔊"} {myState.videoOff ? "📷❌" : "📷"}
          </span>
        </div>

        {/* Remote cameras — no peerState used in JSX = no re-render from peer state changes */}
        {Object.entries(streams)
          .filter(([_, s]) => s.getVideoTracks().length > 0)
          .map(([pid, stream]) => (
            <div key={pid} style={{ position: "relative" }}>
              <video
                data-type="camera" autoPlay playsInline
                style={{ width: 200, height: 150, minWidth: 200, objectFit: "cover", borderRadius: 8, border: "2px solid #444" }}
                ref={el => {
                  if (!el) return;
                  borderRefs.current[pid] = el;
                  const currentId = el.srcObject?.getVideoTracks()[0]?.id;
                  const newId = stream?.getVideoTracks()[0]?.id;
                  if (currentId !== newId) { el.srcObject = stream; el.muted = true; }
                }}
              />

              {/* All overlays have stable ids — updated via DOM only */}
              <div id={`quality-badge-${pid}`} style={{ position: "absolute", top: 6, left: 6, background: "rgba(0,0,0,0.75)", padding: "2px 5px", borderRadius: 4, fontSize: 10, color: "#888" }}>
                ⚪ --ms
              </div>

              <div id={`mute-icon-${pid}`} style={{ display: "none", position: "absolute", top: 6, right: 6, background: "rgba(200,0,0,0.8)", borderRadius: "50%", width: 24, height: 24, alignItems: "center", justifyContent: "center", fontSize: 12 }}>
                🔇
              </div>

              <div id={`videooff-${pid}`} style={{ display: "none", position: "absolute", inset: 0, background: "rgba(0,0,0,0.8)", alignItems: "center", justifyContent: "center", borderRadius: 8, fontSize: 24 }}>
                📷❌
              </div>

              <span style={{ position: "absolute", bottom: 4, left: 4, color: "#fff", fontSize: 11, background: "rgba(0,0,0,0.6)", padding: "2px 6px", borderRadius: 4 }}>
                {pid} <span id={`label-mute-${pid}`}>🔊</span><span id={`label-screen-${pid}`}></span>
              </span>
            </div>
          ))}
      </div>

      {/* CONTROLS */}
      <div style={{ display: "flex", gap: 8, padding: "8px 12px", background: "#222", flexShrink: 0, flexWrap: "wrap" }}>
        <button onClick={() => room.toggleAudio()} style={{ background: myState.muted ? "#c00" : "#444", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 6, cursor: "pointer" }}>
          {myState.muted ? "🔇 Unmute" : "🔊 Mute"}
        </button>
        <button onClick={() => room.toggleVideo()} style={{ background: myState.videoOff ? "#c00" : "#444", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 6, cursor: "pointer" }}>
          {myState.videoOff ? "📷 Camera On" : "📷 Camera Off"}
        </button>
        <button onClick={() => room.toggleScreenShare()} style={{ background: myState.isScreenSharing ? "#c60" : "#444", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 6, cursor: "pointer" }}>
          {myState.isScreenSharing ? "🛑 Stop Share" : "🖥 Share Screen"}
        </button>
        <button onClick={() => room.startRecording()} style={{ background: "#444", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 6, cursor: "pointer" }}>⏺ Record</button>
        <button onClick={() => room.stopRecording()} style={{ background: "#444", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 6, cursor: "pointer" }}>⏹ Stop</button>
        <input
          value={chatInput}
          onChange={e => setChatInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { room.sendChat(chatInput); setChatInput(""); } }}
          placeholder="Chat..."
          style={{ flex: 1, background: "#333", color: "#fff", border: "1px solid #555", padding: "6px 10px", borderRadius: 6 }}
        />
        <button onClick={() => { room.sendChat(chatInput); setChatInput(""); }} style={{ background: "#444", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 6, cursor: "pointer" }}>Send</button>
      </div>

      {/* CHAT LOG */}
      <div style={{ maxHeight: 80, overflowY: "auto", padding: "4px 12px", background: "#181818", fontSize: 12 }}>
        {chat.map((c, i) => <div key={i} style={{ color: "#ccc" }}>{c}</div>)}
      </div>
    </div>
  );
}

export default App;