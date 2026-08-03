(() => {
  'use strict';

  // ─── Parse URL ─────────────────────────────────────────────────────────────
  const pathParts = window.location.pathname.split('/');
  const roomId = pathParts[2] || null;
  const token = pathParts[3] || null;

  if (!roomId || !token) {
    showError('Invalid URL', 'Missing roomId or token in the URL. Expected: /voice/{roomId}/{token}');
    return;
  }

  // ─── State ──────────────────────────────────────────────────────────────────
  let socket = null;
  let localStream = null;
  let audioContext = null;
  let analyser = null;
  let masterGainNode = null;
  let isMuted = false;
  let isDeafened = false;
  let isSpeaking = false;
  let speakCheckInterval = null;
  const peers = new Map();        // userId -> { pc, gainNode, panner, audioEl }
  const participants = new Map(); // userId -> { userId, speaking, position }
  const activeSpeakers = new Set();

  // ─── UI Elements ────────────────────────────────────────────────────────────
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const roomInfo = document.getElementById('room-info');
  const participantsList = document.getElementById('participants-list');
  const participantCount = document.getElementById('participant-count');
  const muteBtn = document.getElementById('mute-btn');
  const deafenBtn = document.getElementById('deafen-btn');
  const micIcon = document.getElementById('mic-icon');
  const mutedIcon = document.getElementById('muted-icon');
  const headphoneIcon = document.getElementById('headphone-icon');
  const deafenedIcon = document.getElementById('deafened-icon');
  const masterVolumeSlider = document.getElementById('master-volume');
  const permissionOverlay = document.getElementById('permission-overlay');
  const allowMicBtn = document.getElementById('allow-mic-btn');
  const errorOverlay = document.getElementById('error-overlay');
  const retryBtn = document.getElementById('retry-btn');

  // Toast container
  const toastContainer = document.createElement('div');
  toastContainer.id = 'toast-container';
  document.body.appendChild(toastContainer);

  // ─── Helpers ────────────────────────────────────────────────────────────────
  function setStatus(state, text) {
    statusDot.className = state;
    statusText.textContent = text;
  }

  function showError(title, message) {
    document.getElementById('error-title').textContent = title;
    document.getElementById('error-message').textContent = message;
    errorOverlay.style.display = 'flex';
  }

  function showToast(msg, duration = 3000) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => t.remove(), duration);
  }

  function shortId(id) {
    return String(id).slice(-6);
  }

  function getInitials(id) {
    const s = String(id);
    return s.slice(-2).toUpperCase();
  }

  // ─── Participant UI ──────────────────────────────────────────────────────────
  function renderParticipants() {
    participantsList.innerHTML = '';
    const count = participants.size + 1; // +1 for self
    participantCount.textContent = `${count} connected`;

    // Self
    const selfEl = createParticipantEl(token, true, isMuted, isSpeaking);
    participantsList.appendChild(selfEl);

    for (const [userId, info] of participants) {
      const el = createParticipantEl(userId, false, false, activeSpeakers.has(userId));
      participantsList.appendChild(el);
    }
  }

  function createParticipantEl(userId, isSelf, muted, speaking) {
    const div = document.createElement('div');
    div.className = 'participant' + (speaking ? ' speaking' : '');
    div.id = 'p-' + userId;

    const avatar = document.createElement('div');
    avatar.className = 'participant-avatar';
    avatar.textContent = getInitials(userId);

    const ring = document.createElement('div');
    ring.className = 'volume-ring';
    avatar.appendChild(ring);

    const info = document.createElement('div');
    info.className = 'participant-info';

    const name = document.createElement('div');
    name.className = 'participant-name';
    name.textContent = isSelf ? `You (${shortId(userId)})` : shortId(userId);

    const status = document.createElement('div');
    status.className = 'participant-status';
    status.textContent = speaking ? 'Speaking' : (muted ? 'Muted' : 'Connected');

    info.appendChild(name);
    info.appendChild(status);

    const bars = document.createElement('div');
    bars.className = 'speaking-bars';
    for (let i = 0; i < 3; i++) {
      const b = document.createElement('div');
      b.className = 'bar';
      b.style.height = '4px';
      bars.appendChild(b);
    }

    const badge = document.createElement('div');
    badge.className = 'participant-badge';
    if (isSelf) {
      badge.className += ' badge-you';
      badge.textContent = 'YOU';
    } else if (muted) {
      badge.className += ' badge-muted';
      badge.textContent = 'MUTED';
    }

    div.appendChild(avatar);
    div.appendChild(info);
    div.appendChild(bars);
    if (isSelf || muted) div.appendChild(badge);

    return div;
  }

  function updateSpeakingUI(userId, speaking) {
    const el = document.getElementById('p-' + userId);
    if (!el) return;
    el.classList.toggle('speaking', speaking);
    const status = el.querySelector('.participant-status');
    if (status) {
      status.textContent = speaking ? 'Speaking' : 'Connected';
    }
  }

  // Animate speaking bars
  let barAnimFrame = null;
  function animateBars() {
    const allBars = document.querySelectorAll('.participant.speaking .speaking-bars .bar');
    allBars.forEach(bar => {
      if (Math.random() > 0.5) {
        const h = 4 + Math.random() * 12;
        bar.style.height = h + 'px';
      }
    });
    barAnimFrame = requestAnimationFrame(() => setTimeout(animateBars, 80));
  }
  animateBars();

  // ─── Audio / WebRTC ─────────────────────────────────────────────────────────
  async function requestMic() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      permissionOverlay.style.display = 'none';
      setupAudioContext();
      connectSocket();
    } catch (err) {
      showError('Microphone Denied', 'Please allow microphone access and reload the page.');
    }
  }

  function setupAudioContext() {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    masterGainNode = audioContext.createGain();
    masterGainNode.gain.value = 1.0;
    masterGainNode.connect(audioContext.destination);

    const source = audioContext.createMediaStreamSource(localStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);

    startSpeakingDetection();
  }

  function startSpeakingDetection() {
    const data = new Uint8Array(analyser.frequencyBinCount);
    const THRESHOLD = 20;
    const DEBOUNCE = 200;
    let lastChange = 0;

    speakCheckInterval = setInterval(() => {
      if (isMuted || !analyser) return;
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const nowSpeaking = avg > THRESHOLD;
      const now = Date.now();

      if (nowSpeaking !== isSpeaking && (now - lastChange > DEBOUNCE)) {
        isSpeaking = nowSpeaking;
        lastChange = now;
        if (socket) socket.emit('speaking', { speaking: isSpeaking });
        updateSpeakingUI(token, isSpeaking);
        activeSpeakers[isSpeaking ? 'add' : 'delete'](token);
      }
    }, 100);
  }

  // ─── Socket.IO ──────────────────────────────────────────────────────────────
  function connectSocket() {
    setStatus('', 'Connecting to server...');

    socket = io({
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
    });

    socket.on('connect', () => {
      setStatus('connected', 'Connected');
      roomInfo.textContent = `Room: ${roomId.slice(0, 8)}`;
      socket.emit('join-room', { roomId, userId: token });
    });

    socket.on('disconnect', () => {
      setStatus('disconnected', 'Disconnected — reconnecting...');
      showToast('Disconnected from voice chat');
    });

    socket.on('reconnect', () => {
      setStatus('connected', 'Reconnected');
      socket.emit('join-room', { roomId, userId: token });
    });

    socket.on('room-users', ({ users }) => {
      for (const u of users) {
        participants.set(u.userId, u);
        createPeerConnection(u.userId, true); // we are the initiator
      }
      renderParticipants();
    });

    socket.on('user-joined', ({ userId }) => {
      participants.set(userId, { userId, speaking: false, position: null });
      createPeerConnection(userId, false); // they will initiate
      renderParticipants();
      showToast(`${shortId(userId)} joined`);
    });

    socket.on('user-left', ({ userId }) => {
      closePeer(userId);
      participants.delete(userId);
      activeSpeakers.delete(userId);
      renderParticipants();
      showToast(`${shortId(userId)} left`);
    });

    socket.on('signal', ({ fromUserId, signal }) => {
      handleSignal(fromUserId, signal);
    });

    socket.on('speakers-updated', ({ activeSpeakers: speakers }) => {
      activeSpeakers.clear();
      for (const uid of speakers) activeSpeakers.add(uid);
      for (const [uid] of participants) {
        updateSpeakingUI(uid, activeSpeakers.has(uid));
      }
      updateSpeakingUI(token, activeSpeakers.has(token));
    });

    socket.on('position-updated', ({ userId, position }) => {
      const p = participants.get(userId);
      if (p) p.position = position;
      updatePositionalAudio(userId, position);
    });

    socket.on('error', ({ message }) => {
      showError('Server Error', message);
    });
  }

  // ─── WebRTC ─────────────────────────────────────────────────────────────────
  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ],
  };

  function createPeerConnection(userId, isInitiator) {
    if (peers.has(userId)) closePeer(userId);

    const pc = new RTCPeerConnection(ICE_SERVERS);

    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('signal', {
          targetUserId: userId,
          signal: { type: 'ice-candidate', candidate: event.candidate },
        });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      setupAudioForPeer(userId, stream);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        closePeer(userId);
        if (participants.has(userId)) {
          setTimeout(() => createPeerConnection(userId, true), 1000);
        }
      }
    };

    peers.set(userId, { pc, gainNode: null, panner: null, audioEl: null });

    if (isInitiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (socket) {
            socket.emit('signal', {
              targetUserId: userId,
              signal: { type: 'offer', sdp: pc.localDescription },
            });
          }
        } catch (e) {
          console.error('Offer error', e);
        }
      };
    }

    return pc;
  }

  async function handleSignal(fromUserId, signal) {
    let peerData = peers.get(fromUserId);

    if (!peerData) {
      createPeerConnection(fromUserId, false);
      peerData = peers.get(fromUserId);
    }

    const { pc } = peerData;

    try {
      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (socket) {
          socket.emit('signal', {
            targetUserId: fromUserId,
            signal: { type: 'answer', sdp: pc.localDescription },
          });
        }
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      } else if (signal.type === 'ice-candidate' && signal.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (e) {
      console.error('Signal handling error:', e);
    }
  }

  function setupAudioForPeer(userId, stream) {
    const peerData = peers.get(userId);
    if (!peerData) return;

    // Cleanup previous audio
    if (peerData.audioEl) {
      peerData.audioEl.srcObject = null;
      peerData.audioEl.remove();
    }

    if (!audioContext) return;

    const source = audioContext.createMediaStreamSource(stream);
    const gainNode = audioContext.createGain();
    gainNode.gain.value = isDeafened ? 0 : 1.0;

    const panner = audioContext.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 10;
    panner.maxDistance = 80;
    panner.rolloffFactor = 1.5;
    panner.setPosition(0, 0, 0);

    source.connect(gainNode);
    gainNode.connect(panner);
    panner.connect(masterGainNode);

    // Also create a hidden audio element as fallback
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);

    peerData.gainNode = gainNode;
    peerData.panner = panner;
    peerData.audioEl = audioEl;
    peers.set(userId, peerData);
  }

  function updatePositionalAudio(userId, position) {
    const peerData = peers.get(userId);
    if (!peerData || !peerData.panner || !position) return;

    // Roblox studs -> rough world units (divide by 10 to normalize distance)
    peerData.panner.setPosition(position.x / 10, position.y / 10, position.z / 10);
  }

  function closePeer(userId) {
    const peerData = peers.get(userId);
    if (!peerData) return;

    if (peerData.pc) peerData.pc.close();
    if (peerData.audioEl) {
      peerData.audioEl.srcObject = null;
      peerData.audioEl.remove();
    }
    peers.delete(userId);
  }

  // ─── Controls ───────────────────────────────────────────────────────────────
  muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    if (localStream) {
      localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
    }
    micIcon.style.display = isMuted ? 'none' : 'block';
    mutedIcon.style.display = isMuted ? 'block' : 'none';
    muteBtn.classList.toggle('active-muted', isMuted);

    if (isMuted && isSpeaking) {
      isSpeaking = false;
      if (socket) socket.emit('speaking', { speaking: false });
      updateSpeakingUI(token, false);
    }
    renderParticipants();
    showToast(isMuted ? 'Microphone muted' : 'Microphone unmuted');
  });

  deafenBtn.addEventListener('click', () => {
    isDeafened = !isDeafened;
    headphoneIcon.style.display = isDeafened ? 'none' : 'block';
    deafenedIcon.style.display = isDeafened ? 'block' : 'none';
    deafenBtn.classList.toggle('active-muted', isDeafened);

    for (const [, peerData] of peers) {
      if (peerData.gainNode) {
        peerData.gainNode.gain.value = isDeafened ? 0 : masterVolumeSlider.value / 100;
      }
    }
    showToast(isDeafened ? 'Deafened' : 'Undeafened');
  });

  masterVolumeSlider.addEventListener('input', () => {
    const vol = masterVolumeSlider.value / 100;
    if (masterGainNode) masterGainNode.gain.value = vol;
  });

  allowMicBtn.addEventListener('click', requestMic);
  retryBtn.addEventListener('click', () => {
    errorOverlay.style.display = 'none';
    requestMic();
  });

  // ─── Init ────────────────────────────────────────────────────────────────────
  roomInfo.textContent = `Room: ${roomId.slice(0, 8)}`;

  // Show self in participant list immediately
  participants.clear();
  renderParticipants();

  // Show mic permission overlay
  permissionOverlay.style.display = 'flex';
  setStatus('', 'Waiting for microphone...');

  // Auto-request mic (some browsers allow this without user gesture)
  navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then(stream => {
      localStream = stream;
      permissionOverlay.style.display = 'none';
      setupAudioContext();
      connectSocket();
    })
    .catch(() => {
      // User needs to click the button
    });
})();
