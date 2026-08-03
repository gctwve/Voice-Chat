import { useEffect, useRef, useState } from "react";

type TestState = "idle" | "requesting" | "active" | "error";

const BAR_COUNT = 20;

export default function MicTest() {
  const [state, setState] = useState<TestState>("idle");
  const [error, setError] = useState("");
  const [loopback, setLoopback] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [bars, setBars] = useState<number[]>(Array(BAR_COUNT).fill(0));
  const [peakDb, setPeakDb] = useState(-Infinity);

  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animRef = useRef<number | null>(null);
  const dataRef = useRef<Uint8Array | null>(null);

  function startAnalyser(analyser: AnalyserNode) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    dataRef.current = data;

    function tick() {
      analyser.getByteFrequencyData(data);

      // Bucket into BAR_COUNT bars
      const bucketSize = Math.floor(data.length / BAR_COUNT);
      const newBars = Array.from({ length: BAR_COUNT }, (_, i) => {
        let sum = 0;
        for (let j = 0; j < bucketSize; j++) {
          sum += data[i * bucketSize + j];
        }
        return sum / bucketSize / 255;
      });
      setBars(newBars);

      // Peak dB
      let max = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] > max) max = data[i];
      }
      const db = max === 0 ? -Infinity : 20 * Math.log10(max / 255);
      setPeakDb(db);

      animRef.current = requestAnimationFrame(tick);
    }

    animRef.current = requestAnimationFrame(tick);
  }

  async function start() {
    setState("requesting");
    setError("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;

      const ctx = new AudioContext();
      ctxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      analyserRef.current = analyser;
      source.connect(analyser);

      const gain = ctx.createGain();
      gain.gain.value = 0;
      gainRef.current = gain;

      const delay = ctx.createDelay(0.3);
      delay.delayTime.value = 0.05;
      analyser.connect(delay);
      delay.connect(gain);
      gain.connect(ctx.destination);

      startAnalyser(analyser);
      setState("active");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes("denied") || msg.includes("Permission")
        ? "Microphone access was denied. Please allow mic access in your browser and try again."
        : `Could not access microphone: ${msg}`);
      setState("error");
    }
  }

  function stop() {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    if (ctxRef.current) { ctxRef.current.close(); ctxRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    gainRef.current = null;
    analyserRef.current = null;
    setState("idle");
    setBars(Array(BAR_COUNT).fill(0));
    setPeakDb(-Infinity);
    setLoopback(false);
  }

  function toggleLoopback() {
    if (!gainRef.current) return;
    const next = !loopback;
    gainRef.current.gain.value = next ? volume : 0;
    setLoopback(next);
  }

  function handleVolume(v: number) {
    setVolume(v);
    if (gainRef.current && loopback) gainRef.current.gain.value = v;
  }

  useEffect(() => () => stop(), []);

  const isSpeaking = bars.some(b => b > 0.08);
  const dbDisplay = isFinite(peakDb) ? `${peakDb.toFixed(1)} dB` : "—";

  return (
    <div className="test-page">
      <div className="test-card">
        <div className="test-header">
          <div className="test-icon">🎙️</div>
          <h1>Mic Test</h1>
          <p>Check your microphone and hear yourself before joining a room</p>
        </div>

        {state === "idle" && (
          <button className="test-btn primary" onClick={start}>
            Start Mic Test
          </button>
        )}

        {state === "requesting" && (
          <div className="test-status">
            <div className="spinner" />
            Waiting for microphone permission…
          </div>
        )}

        {state === "error" && (
          <div className="test-error">
            <div className="test-error-icon">⚠️</div>
            <p>{error}</p>
            <button className="test-btn primary" onClick={start}>Try Again</button>
          </div>
        )}

        {state === "active" && (
          <>
            <div className={`test-meter-wrap ${isSpeaking ? "speaking" : ""}`}>
              <div className="test-bars">
                {bars.map((h, i) => (
                  <div
                    key={i}
                    className="test-bar"
                    style={{ height: `${Math.max(4, h * 100)}%` }}
                  />
                ))}
              </div>
              <div className="test-meter-label">
                {isSpeaking ? "🟢 Picking up audio" : "⚪ Speak into your mic"}
              </div>
              <div className="test-db">{dbDisplay}</div>
            </div>

            <div className="test-controls">
              <div className="test-control-row">
                <span className="test-control-label">Hear yourself</span>
                <button
                  className={`test-toggle ${loopback ? "on" : "off"}`}
                  onClick={toggleLoopback}
                >
                  {loopback ? "ON" : "OFF"}
                </button>
              </div>

              {loopback && (
                <div className="test-control-row">
                  <span className="test-control-label">Loopback volume</span>
                  <div className="test-slider-wrap">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={volume}
                      onChange={e => handleVolume(parseFloat(e.target.value))}
                      className="test-slider"
                    />
                    <span className="test-slider-val">{Math.round(volume * 100)}%</span>
                  </div>
                </div>
              )}

              {loopback && (
                <div className="test-callout">
                  🎧 Use headphones to avoid echo feedback
                </div>
              )}
            </div>

            <div className="test-checklist">
              <div className={`test-check ${isSpeaking ? "pass" : ""}`}>
                {isSpeaking ? "✅" : "⏳"} Microphone is {isSpeaking ? "working" : "not yet detecting audio"}
              </div>
              <div className={`test-check ${loopback ? "pass" : ""}`}>
                {loopback ? "✅" : "⬜"} Loopback {loopback ? "active — can you hear yourself?" : "off"}
              </div>
            </div>

            <button className="test-btn secondary" onClick={stop}>
              Stop Test
            </button>
          </>
        )}
      </div>
    </div>
  );
}
