import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "wouter";
import { io, type Socket } from "socket.io-client";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Participant {
  userId: string;
  speaking: boolean;
  position?: { x: number; y: number; z: number };
}

interface PeerData {
  pc: RTCPeerConnection;
  audioEl: HTMLAudioElement | null;
  panner: PannerNode | null;
  /** ICE candidates queued before setRemoteDescription was called */
  pendingCandidates: RTCIceCandidateInit[];
  makingOffer: boolean;
}

interface Toast {
  id: number;
  msg: string;
}

// ─── ICE Config ──────────────────────────────────────────────────────────────
// STUN alone fails for symmetric NAT (corporate/mobile networks).
// TURN relays traffic through a server as a universal fallback.

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // Open Relay Project — free public TURN servers, no account needed
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:80?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

function shortId(id: string) {
  return String(id).slice(-6);
}

function getInitials(id: string) {
  return String(id).slice(-2).toUpperCase();
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function VoiceChat() {
  const params = useParams<{ roomId: string; token: string }>();
  const roomId = params.roomId ?? "";
  const token = params.token ?? "";

  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [statusText, setStatusText] = useState("Waiting for microphone...");
  const [participants, setParticipants] = useState<Map<string, Participant>>(new Map());
  const [activeSpeakers, setActiveSpeakers] = useState<Set<string>>(new Set());
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(100);
  const [showPermission, setShowPermission] = useState(true);
  const [error, setError] = useState<{ title: string; msg: string } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const socketRef = useRef<Socket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const myPositionRef = useRef<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 0 });
  const peersRef = useRef<Map<string, PeerData>>(new Map());
  const speakIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSpeakChangeRef = useRef(0);
  const isMutedRef = useRef(false);
  const isDeafenedRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const activeSpeakersRef = useRef<Set<string>>(new Set());

  // keep refs in sync with state
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { isDeafenedRef.current = isDeafened; }, [isDeafened]);
  useEffect(() => { isSpeakingRef.current = isSpeaking; }, [isSpeaking]);
  useEffect(() => { activeSpeakersRef.current = activeSpeakers; }, [activeSpeakers]);

  // ── Toasts ──────────────────────────────────────────────────────────────────
  const showToast = useCallback((msg: string) => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
  }, []);

  // ── Audio Context ───────────────────────────────────────────────────────────
  const setupAudioContext = useCallback((stream: MediaStream) => {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioContextRef.current = ctx;
    // Resume immediately — browsers suspend AudioContext created without a user gesture
    ctx.resume().catch(() => {});

    const master = ctx.createGain();
    master.gain.value = 1.0;
    master.connect(ctx.destination);
    masterGainRef.current = master;

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const THRESHOLD = 20;
    const DEBOUNCE = 200;

    speakIntervalRef.current = setInterval(() => {
      if (isMutedRef.current || !analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const nowSpeaking = avg > THRESHOLD;
      const now = Date.now();
      if (nowSpeaking !== isSpeakingRef.current && now - lastSpeakChangeRef.current > DEBOUNCE) {
        isSpeakingRef.current = nowSpeaking;
        lastSpeakChangeRef.current = now;
        setIsSpeaking(nowSpeaking);
        if (socketRef.current) socketRef.current.emit("speaking", { speaking: nowSpeaking });
        if (nowSpeaking) {
          setActiveSpeakers(s => new Set([...s, token]));
        } else {
          setActiveSpeakers(s => { const n = new Set(s); n.delete(token); return n; });
        }
      }
    }, 100);
  }, [token]);

  // ── WebRTC ──────────────────────────────────────────────────────────────────
  const setupAudioForPeer = useCallback((userId: string, stream: MediaStream) => {
    const peerData = peersRef.current.get(userId);
    if (!peerData) return;

    // Remove any existing audio element for this peer
    document.getElementById(`vc-audio-${userId}`)?.remove();

    // Create a hidden <audio> element — handles browser autoplay policy correctly.
    // We then pipe it through Web Audio via createMediaElementSource so we can
    // apply a PannerNode for 3D proximity fading.
    const audio = document.createElement("audio");
    audio.id = `vc-audio-${userId}`;
    audio.autoplay = true;
    audio.srcObject = stream;
    audio.style.position = "absolute";
    audio.style.width = "0";
    audio.style.height = "0";
    document.body.appendChild(audio);

    peerData.audioEl = audio;
    peerData.panner = null;

    const ctx = audioContextRef.current;
    const master = masterGainRef.current;

    if (ctx && master && ctx.state !== "closed") {
      ctx.resume().catch(() => {});
      try {
        // createMediaElementSource captures the <audio> element's output into the
        // Web Audio graph — it no longer plays through the speakers directly.
        // We then route: source → panner → masterGain → destination.
        const source = ctx.createMediaElementSource(audio);

        const panner = ctx.createPanner();
        panner.panningModel = "HRTF";
        panner.distanceModel = "linear"; // linear fades cleanly to 0 at maxDistance
        panner.refDistance = 3.5;   // full volume up to 35 Roblox studs
        panner.maxDistance = 5;     // completely silent at 50 Roblox studs
        panner.rolloffFactor = 1;   // rolloffFactor=1 with linear = exact 0 at maxDistance
        // Start at the peer's last known position (or origin if not yet known)
        const pos = myPositionRef.current;
        panner.setPosition(pos.x / 10, pos.y / 10, pos.z / 10);

        source.connect(panner);
        panner.connect(master);

        peerData.panner = panner;
      } catch (e) {
        // Web Audio setup failed (e.g. context suspended) — fall back to direct element playback
        console.warn("[VoiceChat] Web Audio routing failed, using direct playback:", e);
        audio.volume = isDeafenedRef.current ? 0 : volume / 100;
        audio.play().catch(() => {});
      }
    } else {
      // No AudioContext yet — direct element playback
      audio.volume = isDeafenedRef.current ? 0 : volume / 100;
      audio.play().catch(err => {
        console.warn("[VoiceChat] audio.play() deferred until user interaction:", err);
        const retry = () => { audio.play().catch(() => {}); };
        document.addEventListener("click", retry, { once: true });
        document.addEventListener("keydown", retry, { once: true });
      });
    }
  }, [volume]);

  const closePeer = useCallback((userId: string) => {
    const peerData = peersRef.current.get(userId);
    if (!peerData) return;
    peerData.pc.close();
    if (peerData.audioEl) {
      peerData.audioEl.srcObject = null;
      peerData.audioEl.remove();
    }
    peersRef.current.delete(userId);
  }, []);

  const createPeerConnection = useCallback((userId: string, isInitiator: boolean) => {
    if (peersRef.current.has(userId)) closePeer(userId);

    const pc = new RTCPeerConnection(ICE_SERVERS);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track =>
        pc.addTrack(track, localStreamRef.current!)
      );
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit("signal", {
          targetUserId: userId,
          signal: { type: "ice-candidate", candidate: event.candidate },
        });
      }
    };

    pc.ontrack = (event) => {
      // event.streams[0] can be empty in some browsers — fall back to wrapping the track
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      setupAudioForPeer(userId, stream);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ICE state for ${userId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        // ICE succeeded — resume audio context in case it was still suspended
        audioContextRef.current?.resume().catch(() => {});
      }
      if (pc.iceConnectionState === "failed") {
        closePeer(userId);
        setParticipants(p => {
          if (p.has(userId)) {
            setTimeout(() => createPeerConnection(userId, isInitiator), 1000);
          }
          return p;
        });
      }
    };

    peersRef.current.set(userId, {
      pc,
      audioEl: null,
      panner: null,
      pendingCandidates: [],
      makingOffer: false,
    });

    if (isInitiator) {
      pc.onnegotiationneeded = async () => {
        const pd = peersRef.current.get(userId);
        if (!pd || pd.makingOffer) return;
        try {
          pd.makingOffer = true;
          const offer = await pc.createOffer();
          if (pc.signalingState !== "stable") return; // Already handled
          await pc.setLocalDescription(offer);
          socketRef.current?.emit("signal", {
            targetUserId: userId,
            signal: { type: "offer", sdp: pc.localDescription },
          });
        } catch (e) {
          console.error("Offer error", e);
        } finally {
          const pd2 = peersRef.current.get(userId);
          if (pd2) pd2.makingOffer = false;
        }
      };
    }

    return pc;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closePeer, setupAudioForPeer]);

  // Flush any ICE candidates that were queued before setRemoteDescription
  const flushPendingCandidates = useCallback(async (userId: string) => {
    const peerData = peersRef.current.get(userId);
    if (!peerData || peerData.pendingCandidates.length === 0) return;
    const candidates = peerData.pendingCandidates.splice(0);
    for (const c of candidates) {
      await peerData.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    }
  }, []);

  const handleSignal = useCallback(async (fromUserId: string, signal: any) => {
    if (!peersRef.current.has(fromUserId)) {
      createPeerConnection(fromUserId, false);
    }
    const peerData = peersRef.current.get(fromUserId);
    if (!peerData) return;
    const { pc } = peerData;

    try {
      if (signal.type === "offer") {
        // Ignore collision: if we are also making an offer, let the initiator win
        const offerCollision = peerData.makingOffer || pc.signalingState !== "stable";
        if (offerCollision) return;
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        await flushPendingCandidates(fromUserId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socketRef.current?.emit("signal", {
          targetUserId: fromUserId,
          signal: { type: "answer", sdp: pc.localDescription },
        });
      } else if (signal.type === "answer") {
        if (pc.signalingState === "have-local-offer") {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          await flushPendingCandidates(fromUserId);
        }
      } else if (signal.type === "ice-candidate" && signal.candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
        } else {
          // Queue — remote description not set yet; will be flushed above
          peerData.pendingCandidates.push(signal.candidate);
        }
      }
    } catch (e) {
      console.error("Signal handling error:", e);
    }
  }, [createPeerConnection, flushPendingCandidates]);

  // ── Socket ──────────────────────────────────────────────────────────────────
  const connectSocket = useCallback(() => {
    setStatusText("Connecting to server...");

    const apiServer =
      (import.meta.env.VITE_API_SERVER as string | undefined) ||
      window.location.origin;
    const socket = io(apiServer, {
      transports: ["websocket", "polling"],
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus("connected");
      setStatusText("Connected");
      socket.emit("join-room", { roomId, userId: token });
    });

    socket.on("disconnect", () => {
      setStatus("disconnected");
      setStatusText("Disconnected — reconnecting...");
      showToast("Disconnected from voice chat");
    });

    socket.on("reconnect", () => {
      setStatus("connected");
      setStatusText("Reconnected");
      socket.emit("join-room", { roomId, userId: token });
    });

    socket.on("room-users", ({ users }: { users: Array<{ userId: string; speaking: boolean; position?: any }> }) => {
      const map = new Map<string, Participant>();
      for (const u of users) {
        map.set(u.userId, { userId: u.userId, speaking: u.speaking, position: u.position });
        createPeerConnection(u.userId, true);
      }
      setParticipants(map);
    });

    socket.on("user-joined", ({ userId }: { userId: string }) => {
      setParticipants(p => {
        const n = new Map(p);
        n.set(userId, { userId, speaking: false });
        return n;
      });
      createPeerConnection(userId, false);
      showToast(`${shortId(userId)} joined`);
    });

    socket.on("user-left", ({ userId }: { userId: string }) => {
      closePeer(userId);
      setParticipants(p => { const n = new Map(p); n.delete(userId); return n; });
      setActiveSpeakers(s => { const n = new Set(s); n.delete(userId); return n; });
      showToast(`${shortId(userId)} left`);
    });

    socket.on("signal", ({ fromUserId, signal }: { fromUserId: string; signal: any }) => {
      handleSignal(fromUserId, signal);
    });

    socket.on("speakers-updated", ({ activeSpeakers: speakers }: { activeSpeakers: string[] }) => {
      const s = new Set(speakers);
      setActiveSpeakers(s);
      activeSpeakersRef.current = s;
    });

    socket.on("position-updated", ({ userId, position, lookVector }: {
      userId: string;
      position: { x: number; y: number; z: number };
      lookVector?: { x: number; y: number; z: number };
    }) => {
      if (userId === token) {
        // This is our own position broadcast back to us — update the AudioContext
        // listener so all PannerNodes compute distance/direction relative to us.
        myPositionRef.current = position;
        const ctx = audioContextRef.current;
        if (ctx) {
          const lx = position.x / 10, ly = position.y / 10, lz = position.z / 10;
          // AudioListener.positionX/Y/Z are AudioParam (modern API)
          if (ctx.listener.positionX) {
            ctx.listener.positionX.setValueAtTime(lx, ctx.currentTime);
            ctx.listener.positionY.setValueAtTime(ly, ctx.currentTime);
            ctx.listener.positionZ.setValueAtTime(lz, ctx.currentTime);
          } else {
            (ctx.listener as AudioListener).setPosition?.(lx, ly, lz);
          }
          if (lookVector) {
            const fx = lookVector.x, fy = lookVector.y, fz = lookVector.z;
            if (ctx.listener.forwardX) {
              ctx.listener.forwardX.setValueAtTime(fx, ctx.currentTime);
              ctx.listener.forwardY.setValueAtTime(fy, ctx.currentTime);
              ctx.listener.forwardZ.setValueAtTime(fz, ctx.currentTime);
              ctx.listener.upX.setValueAtTime(0, ctx.currentTime);
              ctx.listener.upY.setValueAtTime(1, ctx.currentTime);
              ctx.listener.upZ.setValueAtTime(0, ctx.currentTime);
            } else {
              (ctx.listener as AudioListener).setOrientation?.(fx, fy, fz, 0, 1, 0);
            }
          }
        }
        return;
      }

      // Remote peer position — update their panner node
      setParticipants(p => {
        const n = new Map(p);
        const existing = n.get(userId);
        if (existing) n.set(userId, { ...existing, position });
        return n;
      });
      const peerData = peersRef.current.get(userId);
      if (peerData?.panner && position) {
        peerData.panner.setPosition(position.x / 10, position.y / 10, position.z / 10);
      }
    });
  }, [roomId, token, createPeerConnection, closePeer, handleSignal, showToast]);

  // ── Mic ─────────────────────────────────────────────────────────────────────
  const requestMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      setShowPermission(false);
      setupAudioContext(stream);
      connectSocket();
    } catch {
      setError({
        title: "Microphone Denied",
        msg: "Please allow microphone access and reload the page.",
      });
    }
  }, [setupAudioContext, connectSocket]);

  // ── Init ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then(stream => {
        localStreamRef.current = stream;
        setShowPermission(false);
        setupAudioContext(stream);
        connectSocket();
      })
      .catch(() => {
        // User needs to click Allow button
      });

    return () => {
      speakIntervalRef.current && clearInterval(speakIntervalRef.current);
      socketRef.current?.disconnect();
      for (const [, peerData] of peersRef.current) peerData.pc.close();
      peersRef.current.clear();
      localStreamRef.current?.getTracks().forEach(t => t.stop());
      audioContextRef.current?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mute / Deafen ────────────────────────────────────────────────────────────
  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    isMutedRef.current = next;
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !next; });
    }
    if (next && isSpeakingRef.current) {
      isSpeakingRef.current = false;
      setIsSpeaking(false);
      socketRef.current?.emit("speaking", { speaking: false });
      setActiveSpeakers(s => { const n = new Set(s); n.delete(token); return n; });
    }
    showToast(next ? "Microphone muted" : "Microphone unmuted");
  };

  const toggleDeafen = () => {
    const next = !isDeafened;
    setIsDeafened(next);
    isDeafenedRef.current = next;
    if (masterGainRef.current) {
      // Smooth 20ms ramp to avoid click artifacts
      const now = masterGainRef.current.context.currentTime;
      masterGainRef.current.gain.setTargetAtTime(next ? 0 : volume / 100, now, 0.02);
    } else {
      // Fallback when Web Audio isn't available
      for (const [, pd] of peersRef.current) {
        if (pd.audioEl) pd.audioEl.muted = next;
      }
    }
    showToast(next ? "Deafened" : "Undeafened");
  };

  const onVolumeChange = (v: number) => {
    setVolume(v);
    if (masterGainRef.current && !isDeafenedRef.current) {
      const now = masterGainRef.current.context.currentTime;
      masterGainRef.current.gain.setTargetAtTime(v / 100, now, 0.02);
    } else {
      // Fallback when Web Audio isn't available
      for (const [, pd] of peersRef.current) {
        if (pd.audioEl) pd.audioEl.volume = v / 100;
      }
    }
  };

  // ── Animated bars ────────────────────────────────────────────────────────────
  const barHeights = useBarAnimation(activeSpeakers);

  // ── Render ───────────────────────────────────────────────────────────────────
  const allParticipants: Participant[] = [
    { userId: token, speaking: isSpeaking },
    ...Array.from(participants.values()),
  ];

  return (
    <div className="vc-app">
      <div className="vc-status-bar">
        <div className={`vc-status-dot ${status}`} />
        <span className="vc-status-text">{statusText}</span>
        <span className="vc-room-info">Room: {roomId.slice(0, 8)}</span>
      </div>

      <div className="vc-main">
        <div className="vc-controls">
          <button
            className={`vc-control-btn${isMuted ? " active-muted" : ""}`}
            onClick={toggleMute}
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? <MutedIcon /> : <MicIcon />}
          </button>
          <button
            className={`vc-control-btn${isDeafened ? " active-muted" : ""}`}
            onClick={toggleDeafen}
            title={isDeafened ? "Undeafen" : "Deafen"}
          >
            {isDeafened ? <DeafenedIcon /> : <HeadphoneIcon />}
          </button>
          <div className="vc-volume">
            <VolumeIcon />
            <input
              type="range"
              min={0}
              max={200}
              value={volume}
              onChange={e => onVolumeChange(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="vc-participants">
          <div className="vc-participants-header">
            <span className="vc-participants-label">Voice Room</span>
            <span className="vc-count">{allParticipants.length} connected</span>
          </div>
          <div className="vc-participants-list">
            {allParticipants.map(p => {
              const speaking = p.userId === token ? isSpeaking : activeSpeakers.has(p.userId);
              const isSelf = p.userId === token;
              const muted = isSelf && isMuted;
              return (
                <div key={p.userId} className={`vc-participant${speaking ? " speaking" : ""}`}>
                  <div className="vc-avatar">{getInitials(p.userId)}</div>
                  <div className="vc-info">
                    <div className="vc-name">{isSelf ? `You (${shortId(p.userId)})` : shortId(p.userId)}</div>
                    <div className="vc-sub">{speaking ? "Speaking" : muted ? "Muted" : "Connected"}</div>
                  </div>
                  <div className="vc-bars">
                    {[0, 1, 2].map(i => (
                      <div
                        key={i}
                        className="vc-bar"
                        style={{ height: speaking ? `${barHeights[p.userId]?.[i] ?? 4}px` : "4px" }}
                      />
                    ))}
                  </div>
                  {(isSelf || muted) && (
                    <span className={`vc-badge ${isSelf ? "vc-badge-you" : "vc-badge-muted"}`}>
                      {isSelf ? "YOU" : "MUTED"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {showPermission && !error && (
        <div className="vc-overlay">
          <div className="vc-overlay-card">
            <div className="vc-overlay-icon">🎙️</div>
            <h2>Microphone Access</h2>
            <p>This page needs access to your microphone to enable voice chat.</p>
            <button className="vc-primary-btn" onClick={requestMic}>Allow Microphone</button>
            <p className="vc-hint">Make sure you are using Chrome, Firefox, or Edge.</p>
          </div>
        </div>
      )}

      {error && (
        <div className="vc-overlay">
          <div className="vc-overlay-card">
            <div className="vc-overlay-icon">⚠️</div>
            <h2>{error.title}</h2>
            <p>{error.msg}</p>
            <button className="vc-primary-btn" onClick={() => { setError(null); requestMic(); }}>Retry</button>
          </div>
        </div>
      )}

      <div className="vc-toasts">
        {toasts.map(t => (
          <div key={t.id} className="vc-toast">{t.msg}</div>
        ))}
      </div>
    </div>
  );
}

// ── Bar animation hook ────────────────────────────────────────────────────────
function useBarAnimation(activeSpeakers: Set<string>) {
  const [heights, setHeights] = useState<Record<string, number[]>>({});
  const frameRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function tick() {
      if (activeSpeakers.size === 0) {
        setHeights({});
        frameRef.current = setTimeout(tick, 200);
        return;
      }
      const next: Record<string, number[]> = {};
      for (const uid of activeSpeakers) {
        next[uid] = [0, 1, 2].map(() => 4 + Math.random() * 12);
      }
      setHeights(next);
      frameRef.current = setTimeout(tick, 80);
    }
    tick();
    return () => { if (frameRef.current) clearTimeout(frameRef.current); };
  }, [activeSpeakers]);

  return heights;
}

// ── Icons ────────────────────────────────────────────────────────────────────

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
    </svg>
  );
}

function MutedIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V20c0 .55.45 1 1 1s1-.45 1-1v-2.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
    </svg>
  );
}

function HeadphoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h1c1.1 0 2-.9 2-2v-4c0-1.1-.9-2-2-2H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h1c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z" />
    </svg>
  );
}

function DeafenedIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M3.63 3.63c-.39.39-.39 1.02 0 1.41L7.29 8.7 7 9H5c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h1c1.1 0 2-.9 2-2v-4c0-.36-.09-.69-.22-1l1.58 1.58C9.12 11.9 9 12.19 9 12.5v.5c0 1.1.9 2 2 2v3h2v-3c.28 0 .54-.07.78-.17l7.81 7.81c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L5.05 3.63c-.4-.39-1.03-.39-1.42 0zM19 11v2h-2v-2c0-3.87-3.13-7-7-7-1.27 0-2.46.35-3.47.95l-1.41-1.41C6.51 2.54 9.1 2 12 2c4.97 0 9 4.03 9 9z" />
    </svg>
  );
}

function VolumeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5zm7-.17v6.34L9.83 13H7v-2h2.83L12 8.83z" />
    </svg>
  );
}
