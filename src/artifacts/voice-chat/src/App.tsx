import { Switch, Route, Router as WouterRouter, Link } from "wouter";
import VoiceChat from "./pages/VoiceChat";
import GuideByGiwi from "./pages/GuideByGiwi";
import MicTest from "./pages/MicTest";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/voice/:roomId/:token" component={VoiceChat} />
      <Route path="/detailedguidebygiwi" component={GuideByGiwi} />
      <Route path="/test" component={MicTest} />
      <Route path="/">
        {() => (
          <div className="landing">
            <div className="landing-card">
              <div className="landing-icon">🎙️</div>
              <h1>GIWI VCC!!</h1>
              <p>Open a room URL to join voice chat:</p>
              <code>/voice/&#123;roomId&#125;/&#123;token&#125;</code>
              <div className="landing-links">
                <Link href="/test" className="landing-link">🎙️ Test your mic</Link>
              </div>
            </div>
          </div>
        )}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <Router />
    </WouterRouter>
  );
}

export default App;
