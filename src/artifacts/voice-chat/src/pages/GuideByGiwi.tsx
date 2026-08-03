export default function GuideByGiwi() {
  return (
    <div className="guide-page">
      <div className="guide-content">

        <header className="guide-header">
          <div className="guide-logo">🎙️</div>
          <h1>Giwivc — Detailed Setup Guide</h1>
          <p className="guide-subtitle">
            Full guide to setting up Roblox Voice Chat with Netlify hosting
          </p>
        </header>

        <section className="guide-section">
          <h2>📋 Overview</h2>
          <p>
            This system has two parts that work together:
          </p>
          <ul>
            <li><strong>Netlify</strong> — hosts the voice chat web page and your SDK Lua file</li>
            <li><strong>Replit</strong> — runs the real-time signaling server (Socket.IO + WebRTC relay)</li>
          </ul>
          <div className="guide-callout">
            <strong>Why two services?</strong> Netlify is great for fast static hosting, but WebRTC signaling requires a persistent server connection — that's what Replit provides.
          </div>
        </section>

        <section className="guide-section">
          <h2>✅ What You Need</h2>
          <ul>
            <li>A <strong>Replit</strong> account with this project deployed (Publish → Deploy)</li>
            <li>A <strong>Netlify</strong> account (free tier works)</li>
            <li>A <strong>GitHub</strong> account (Netlify deploys from GitHub)</li>
            <li>Your <strong>Roblox game</strong> with HTTP requests enabled</li>
            <li>Optional: a custom domain like <code>giwivc.today</code></li>
          </ul>
        </section>

        <section className="guide-section">
          <h2>Step 1 — Deploy the Replit Server</h2>
          <p>The Replit backend handles all real-time voice chat signaling. It must stay running 24/7.</p>
          <ol>
            <li>Open this project on <strong>Replit</strong></li>
            <li>Click <strong>Deploy</strong> (top right) → choose <strong>Reserved VM</strong> (required for WebSockets)</li>
            <li>Deploy and wait for it to go live</li>
            <li>
              Note your Replit app URL — it will look like:<br />
              <code>https://your-app-name.replit.app</code>
            </li>
          </ol>
          <div className="guide-callout warn">
            ⚠️ Do <strong>not</strong> use Autoscale deployment — it does not support persistent WebSocket connections. Always use <strong>Reserved VM</strong>.
          </div>
        </section>

        <section className="guide-section">
          <h2>Step 2 — Push This Project to GitHub</h2>
          <ol>
            <li>On Replit, click the <strong>Git</strong> panel (branch icon in the left sidebar)</li>
            <li>Click <strong>Create a GitHub repository</strong> and follow the prompts</li>
            <li>Push the code — Netlify will pull from this repo</li>
          </ol>
        </section>

        <section className="guide-section">
          <h2>Step 3 — Deploy to Netlify</h2>
          <ol>
            <li>Go to <a href="https://netlify.com" target="_blank" rel="noreferrer">netlify.com</a> and log in</li>
            <li>Click <strong>Add new site → Import an existing project</strong></li>
            <li>Choose <strong>GitHub</strong> and authorise Netlify to access your repo</li>
            <li>Select your repository</li>
            <li>
              Netlify will auto-detect the <code>netlify.toml</code> — confirm these settings:
              <div className="code-block">
                <pre>{`Build command:  pnpm --filter @workspace/voice-chat run build
Publish dir:    artifacts/voice-chat/dist/public`}</pre>
              </div>
            </li>
            <li>
              Under <strong>Environment variables</strong>, add:
              <div className="code-block">
                <pre>{`VITE_API_SERVER = https://your-app-name.replit.app`}</pre>
              </div>
              Replace <code>your-app-name</code> with your actual Replit deployment URL.
            </li>
            <li>Click <strong>Deploy site</strong> and wait ~2 minutes</li>
          </ol>
          <div className="guide-callout">
            After deployment, Netlify gives you a URL like <code>https://amazing-site-123.netlify.app</code>. Test it by visiting <code>/voice/test/123</code> — you should see the voice chat UI.
          </div>
        </section>

        <section className="guide-section">
          <h2>Step 4 — Custom Domain (Optional)</h2>
          <p>If you want a clean URL like <code>giwivc.today</code> instead of the Netlify subdomain:</p>
          <ol>
            <li>In Netlify, go to <strong>Domain management → Add a domain</strong></li>
            <li>Enter your domain and follow Netlify's DNS instructions</li>
            <li>Netlify automatically provisions HTTPS — wait up to 24h for DNS to propagate</li>
            <li>
              Update the <code>VCLoader</code> script in Roblox to use your domain:
              <div className="code-block">
                <pre>{`local SDK_URL = "https://giwivc.today/sdk/VoiceChatServer.lua"`}</pre>
              </div>
            </li>
            <li>
              Update the <code>InitVC</code> script in Roblox:
              <div className="code-block">
                <pre>{`local vc = VoiceChat.new("https://giwivc.today")`}</pre>
              </div>
            </li>
          </ol>
        </section>

        <section className="guide-section">
          <h2>Step 5 — Roblox Game Setup</h2>
          <p>In your Roblox game, you need these scripts and objects:</p>

          <h3>Enable HTTP Requests</h3>
          <ol>
            <li>In Roblox Studio, go to <strong>Game Settings → Security</strong></li>
            <li>Enable <strong>Allow HTTP Requests</strong></li>
            <li>Enable <strong>Allow loadstring</strong> (required for VCLoader)</li>
          </ol>

          <h3>Required Roblox Objects</h3>
          <div className="code-block">
            <pre>{`ServerScriptService/
  VCLoader          ← Script (downloads + runs VoiceChatServer.lua)

ReplicatedStorage/
  TopbarPlus        ← ModuleScript (get from the Roblox toolbox)
  VoiceChat         ← ModuleScript (the VoiceChat module script)
  VoiceChatSDK      ← ModuleScript (your SDK module)

StarterPlayerScripts/
  SDK_RUNTIME       ← LocalScript (handles F5 reload)
  InitVC            ← LocalScript (starts the VoiceChat module)`}</pre>
          </div>

          <h3>VCLoader Script</h3>
          <p>Place this in <strong>ServerScriptService</strong> as a Script:</p>
          <div className="code-block">
            <pre>{`local HttpService = game:GetService("HttpService")

local SDK_URL = "https://giwivc.today/sdk/VoiceChatServer.lua"

local function loadSdk()
    print("Loader: Fetching VoiceChat Server SDK...")

    local success, response = pcall(function()
        return HttpService:GetAsync(SDK_URL, true)
    end)

    if not success then
        warn("Loader: HTTP Request failed.")
        warn("Error: " .. tostring(response))
        return
    end

    local func, loadError = loadstring(response)

    if not func then
        warn("Loader: Failed to compile SDK.")
        warn("Error: " .. tostring(loadError))
        return
    end

    local runSuccess, runError = pcall(func)

    if runSuccess then
        print("Loader: VoiceChat Server SDK loaded!")
    else
        warn("Loader: Runtime error in SDK.")
        warn("Error: " .. tostring(runError))
    end
end

loadSdk()`}</pre>
          </div>

          <h3>InitVC Script</h3>
          <p>Place this in <strong>StarterPlayerScripts</strong> as a LocalScript:</p>
          <div className="code-block">
            <pre>{`local ReplicatedStorage = game:GetService("ReplicatedStorage")
local VoiceChat = require(ReplicatedStorage:WaitForChild("VoiceChat"))

local vc = VoiceChat.new("https://giwivc.today")
vc:createUI()`}</pre>
          </div>
        </section>

        <section className="guide-section">
          <h2>Step 6 — Test It</h2>
          <ol>
            <li>Start your Roblox game in Studio (Play)</li>
            <li>Watch the <strong>Output</strong> panel — you should see:<br />
              <code>[VoiceChat] Room ID: 12345-abcdef</code>
            </li>
            <li>Click the <strong>VC</strong> icon in the topbar — the setup UI should appear with a URL</li>
            <li>Open that URL in your browser</li>
            <li>Allow microphone access</li>
            <li>The UI should close and voice chat should start — you will hear other players!</li>
          </ol>
        </section>

        <section className="guide-section">
          <h2>🔄 How It Works</h2>
          <div className="flow-diagram">
            <div className="flow-step">
              <div className="flow-icon">🎮</div>
              <div><strong>VCLoader</strong><br /><small>Downloads SDK from Netlify</small></div>
            </div>
            <div className="flow-arrow">→</div>
            <div className="flow-step">
              <div className="flow-icon">🖥️</div>
              <div><strong>VoiceChatServer.lua</strong><br /><small>Fetches room ID from Replit API</small></div>
            </div>
            <div className="flow-arrow">→</div>
            <div className="flow-step">
              <div className="flow-icon">🌐</div>
              <div><strong>Player opens URL</strong><br /><small>Browser connects via WebRTC</small></div>
            </div>
            <div className="flow-arrow">→</div>
            <div className="flow-step">
              <div className="flow-icon">🎙️</div>
              <div><strong>Voice active</strong><br /><small>Positional audio + speaking indicators</small></div>
            </div>
          </div>
        </section>

        <section className="guide-section">
          <h2>❓ Troubleshooting</h2>

          <h3>VCLoader says "HTTP Request failed"</h3>
          <ul>
            <li>Make sure <strong>Allow HTTP Requests</strong> is enabled in Game Settings</li>
            <li>Check that your Netlify site is deployed and the SDK URL returns Lua code</li>
          </ul>

          <h3>VCLoader says "Failed to compile SDK"</h3>
          <ul>
            <li>Make sure <strong>Allow loadstring</strong> is enabled in Game Settings</li>
          </ul>

          <h3>Room ID never appears in Output</h3>
          <ul>
            <li>Your Replit server is probably not deployed — go back to Step 1</li>
            <li>Check the <code>BASE_URL</code> inside VoiceChatServer.lua matches your Replit URL</li>
          </ul>

          <h3>Browser page shows "Disconnected"</h3>
          <ul>
            <li>Check <code>VITE_API_SERVER</code> is set correctly in Netlify environment variables</li>
            <li>Make sure your Replit deployment is running (Reserved VM, not Autoscale)</li>
          </ul>

          <h3>No audio from other players</h3>
          <ul>
            <li>Both players must have granted microphone permission in the browser</li>
            <li>Try using Chrome — it has the best WebRTC support</li>
            <li>If behind a strict firewall, STUN may fail — a TURN server would be needed</li>
          </ul>
        </section>

        <footer className="guide-footer">
          <p>Made by <strong>Giwi</strong> · <a href="/voice/demo/preview">Try Voice Chat</a></p>
        </footer>

      </div>
    </div>
  );
}
