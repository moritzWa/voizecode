// Marketing landing, shown at the bare domain when no access token is stored. Authenticated
// users (stored token or a ?key= link) never see this — index.tsx routes them straight to the
// app. "Open the app" flips to the access gate.
export function Landing({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="lp">
      <style>{`
        .lp { min-height: 100dvh; background: #0a0a0f; color: #e8e8ee; font-size: 16px; line-height: 1.65; -webkit-font-smoothing: antialiased; }
        .lp .wrap { max-width: 980px; margin: 0 auto; padding: 0 24px; }
        .lp a { color: #b7b7fa; text-decoration: none; }
        .lp a:hover { text-decoration: underline; }
        .lp nav { display: flex; align-items: center; gap: 20px; padding: 22px 0; }
        .lp .logo { font-weight: 700; font-size: 18px; letter-spacing: -.02em; }
        .lp .logo .dot { color: #8b8bf4; }
        .lp nav .spacer { flex: 1; }
        .lp .navlink { color: #9a9aad; font-size: 14px; }
        .lp .btn { display: inline-flex; align-items: center; gap: 8px; border-radius: 10px; padding: 9px 18px; font-size: 14.5px; font-weight: 600; border: 1px solid #23232f; color: #e8e8ee; background: #12121a; transition: all .15s; cursor: pointer; text-decoration: none !important; }
        .lp .btn:hover { border-color: #34344a; background: #16161f; }
        .lp .btn.primary { background: #8b8bf4; border-color: #8b8bf4; color: #0b0b12; }
        .lp .btn.primary:hover { background: #b7b7fa; border-color: #b7b7fa; }
        .lp .hero { padding: 64px 0 40px; text-align: center; }
        .lp .hero h1 { font-size: clamp(38px, 6.5vw, 62px); line-height: 1.06; letter-spacing: -.035em; font-weight: 800; }
        .lp .hero h1 .grad { background: linear-gradient(100deg, #b7b7fa, #7dd3fc 60%, #34d399); -webkit-background-clip: text; background-clip: text; color: transparent; }
        .lp .hero p.sub { margin: 22px auto 0; max-width: 640px; color: #9a9aad; font-size: clamp(16px, 2.4vw, 19px); }
        .lp .ctas { margin-top: 34px; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
        .lp .hint { margin-top: 14px; font-size: 13px; color: #6b6b80; }
        .lp .terminal { margin: 52px auto 0; max-width: 720px; text-align: left; border: 1px solid #23232f; border-radius: 14px; background: #0d0d14; overflow: hidden; box-shadow: 0 24px 80px -32px rgba(139,139,244,.25); }
        .lp .terminal .bar { display: flex; gap: 6px; padding: 11px 14px; border-bottom: 1px solid #23232f; }
        .lp .terminal .bar span { width: 11px; height: 11px; border-radius: 50%; background: #2c2c3a; }
        .lp .terminal pre { padding: 18px 20px 22px; font: 13.5px/1.75 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #c6c6d4; overflow-x: auto; white-space: pre; }
        .lp .t-dim { color: #5d5d72; } .lp .t-you { color: #34d399; font-weight: 600; } .lp .t-voice { color: #b7b7fa; }
        .lp section { padding: 64px 0 0; }
        .lp section h2 { font-size: 26px; letter-spacing: -.02em; margin-bottom: 8px; }
        .lp section p.lead { color: #9a9aad; max-width: 620px; }
        .lp .grid3 { margin-top: 32px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
        .lp .card { border: 1px solid #23232f; background: #12121a; border-radius: 14px; padding: 18px 20px; text-align: left; }
        .lp .card .n { font: 700 12px/1 ui-monospace, monospace; color: #8b8bf4; letter-spacing: .1em; }
        .lp .card h3 { font-size: 15.5px; margin: 8px 0 5px; }
        .lp .card p { font-size: 13.5px; color: #9a9aad; }
        .lp .install { margin-top: 28px; border: 1px solid #23232f; border-radius: 14px; background: #0d0d14; overflow: hidden; }
        .lp .install pre { padding: 18px 20px; font: 13.5px/1.9 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #c6c6d4; overflow-x: auto; }
        .lp .install .c { color: #5d5d72; }
        .lp footer { margin-top: 80px; border-top: 1px solid #23232f; padding: 26px 0 44px; display: flex; gap: 18px; align-items: center; color: #6b6b80; font-size: 13.5px; flex-wrap: wrap; }
        .lp footer .spacer { flex: 1; }
        @media (max-width: 760px) { .lp .grid3 { grid-template-columns: 1fr; } .lp .hero { padding-top: 40px; } }
      `}</style>
      <div className="wrap">
        <nav>
          <span className="logo">voize<span className="dot">code</span></span>
          <span className="spacer" />
          <a className="navlink" href="https://github.com/moritzWa/voizecode">GitHub</a>
          <button className="btn primary" onClick={onOpen}>Open the app</button>
        </nav>

        <div className="hero">
          <h1>Your codebase,<br /><span className="grad">hands-free.</span></h1>
          <p className="sub">
            Explore <em>and</em> change code by voice — from anywhere. voizecode turns Claude Code or
            Codex into something that feels like a phone call with your repo.
          </p>
          <div className="ctas">
            <button className="btn primary" onClick={onOpen}>Open the app →</button>
            <a className="btn" href="https://github.com/moritzWa/voizecode">Star on GitHub</a>
          </div>
          <div className="hint">Runs against your own laptop — your code never leaves your machine except to your model provider.</div>

          <div className="terminal">
            <div className="bar"><span /><span /><span /></div>
            <pre>
              <span className="t-dim">~/code/api</span> $ voize{"\n"}
              <span className="t-dim">voize → https://voizecode.com  (chat: api)  — keeping Mac awake</span>{"\n\n"}
              <span className="t-you">you</span>    {"\"Look at the open PR and tell me if anything's risky.\"\n"}
              <span className="t-voice">agent</span>  {"\"Reading the diff… the retry logic in billing.ts swallows\n       the timeout error — that's the risky part. Want me to fix it?\"\n"}
              <span className="t-you">you</span>    {"\"Yes, and add a test first.\"\n"}
              <span className="t-voice">agent</span>  {"\"There are no tests for it, so I'll add one first…\n       done — test red, fix in, test green. Committed.\""}
            </pre>
          </div>
        </div>

        <section>
          <h2>The killer feature isn&apos;t voice input.</h2>
          <p className="lead">
            It&apos;s voice <strong>output</strong>: instead of reading pages of agent logs, a narrator
            continuously summarizes what your agent is doing, as it works. That&apos;s pair-programming,
            not terminal-watching.
          </p>
          <div className="grid3">
            <div className="card"><div className="n">01</div><h3>Say it</h3><p>Talk on your phone or desktop — whole thoughts, not commands. Barge in any time to redirect mid-task.</p></div>
            <div className="card"><div className="n">02</div><h3>The agent works</h3><p>Claude Code or Codex runs on your own laptop, in your real repos, with your tools and credentials.</p></div>
            <div className="card"><div className="n">03</div><h3>Hear it think</h3><p>A narrator speaks progress and results aloud, with word highlighting synced to the audio.</p></div>
          </div>
        </section>

        <section>
          <h2>Built for actually using it</h2>
          <div className="grid3">
            <div className="card"><h3>📱 From anywhere</h3><p>Phone on cellular → relay → your laptop. Review a PR on a walk, ship a fix from the couch.</p></div>
            <div className="card"><h3>🗣️ Barge-in</h3><p>Talking over the agent stops the audio and interrupts it mid-turn. Your next sentence redirects the same session.</p></div>
            <div className="card"><h3>📑 Multi-repo tabs</h3><p>One agent, many projects. Open a chat in any repo, resume any past Claude Code session.</p></div>
            <div className="card"><h3>⏪ Replay anything</h3><p>Every spoken sentence is stored. Tap a line to re-listen from there — pitch-preserved at 1–3×.</p></div>
            <div className="card"><h3>🔀 PR mode</h3><p>Pick a pull request and talk through it — the diff becomes the conversation context.</p></div>
            <div className="card"><h3>🎛️ Ramble mode</h3><p>Think out loud across pauses; nothing sends until you tap. Dictation for half-formed ideas.</p></div>
          </div>
        </section>

        <section>
          <h2>Quick start</h2>
          <p className="lead">The CLI runs on your laptop; this web app is where you talk. There&apos;s also an Electron desktop app.</p>
          <div className="install">
            <pre>
              <span className="c"># one-time setup</span>{"\n"}
              git clone https://github.com/moritzWa/voizecode &amp;&amp; cd voizecode{"\n"}
              npm run setup                    <span className="c"># installs agent + client deps</span>{"\n"}
              cp .env.example relay/.env       <span className="c"># add DEEPGRAM / OPENAI / ELEVENLABS keys</span>{"\n\n"}
              <span className="c"># every day after: from any repo</span>{"\n"}
              voize                            <span className="c"># agent up, chat opened, phone URL printed</span>
            </pre>
          </div>
        </section>

        <footer>
          <span>voizecode — built by <a href="https://github.com/moritzWa">@moritzWa</a></span>
          <span className="spacer" />
          <a href="https://github.com/moritzWa/voizecode">GitHub</a>
          <a href="/privacy">Privacy</a>
          <button className="btn" onClick={onOpen} style={{ padding: "5px 12px", fontSize: 13 }}>Open the app</button>
        </footer>
      </div>
    </div>
  );
}
