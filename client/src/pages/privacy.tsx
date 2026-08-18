// Privacy policy. The App Store requires a reachable URL for one, and it has to actually
// describe what happens — voizecode streams microphone audio to three third parties, which is
// exactly the kind of thing a nutrition label is for. Keep this in sync with the real data flow
// (relay/main.ts is the authority); a policy that drifts from the code is worse than none.
export default function Privacy() {
  return (
    <div className="pp">
      <style>{`
        .pp { min-height: 100dvh; background: #0a0a0f; color: #e8e8ee; font-size: 16px; line-height: 1.7; -webkit-font-smoothing: antialiased; }
        .pp .wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px 96px; }
        .pp a { color: #b7b7fa; }
        .pp h1 { font-size: 34px; letter-spacing: -.03em; font-weight: 800; }
        .pp .updated { color: #6b6b80; font-size: 14px; margin-top: 8px; }
        .pp h2 { font-size: 19px; letter-spacing: -.015em; margin: 36px 0 8px; }
        .pp p { color: #c6c6d4; margin-bottom: 12px; }
        .pp ul { color: #c6c6d4; padding-left: 22px; margin-bottom: 12px; }
        .pp li { margin-bottom: 7px; }
        .pp strong { color: #e8e8ee; }
        .pp .back { display: inline-block; margin-bottom: 28px; color: #9a9aad; font-size: 14px; text-decoration: none; }
        .pp .back:hover { color: #b7b7fa; }
      `}</style>
      <div className="wrap">
        <a className="back" href="/">← voizecode</a>
        <h1>Privacy</h1>
        <p className="updated">Last updated 13 August 2026</p>

        <p>
          voizecode is a voice interface to a coding agent running on your own computer. Using it
          means your voice is transcribed, and what the agent says back is synthesized into speech.
          Both steps involve sending data to third parties. This page says exactly what goes where.
        </p>

        <h2>What is sent off your devices</h2>
        <ul>
          <li>
            <strong>Microphone audio</strong>, while a call is active, streams to our relay server
            and on to <a href="https://deepgram.com/privacy">Deepgram</a> for speech-to-text. The
            microphone is only open while you have started a call, and muting sends silence rather
            than your surroundings.
          </li>
          <li>
            <strong>Your transcribed words and the agent&apos;s replies</strong> go to
            <a href="https://openai.com/policies/privacy-policy"> OpenAI</a>, which compresses each
            reply into the one to three sentences that get spoken aloud.
          </li>
          <li>
            <strong>The text to be spoken</strong> goes to
            <a href="https://elevenlabs.io/privacy"> ElevenLabs</a> for speech synthesis (OpenAI is
            the fallback when ElevenLabs is unavailable).
          </li>
          <li>
            <strong>Your code and your prompts</strong> go to whichever coding agent you have
            configured on your own machine, under that vendor&apos;s terms: Anthropic&apos;s for
            Claude Code, OpenAI&apos;s for Codex. voizecode does not read or upload your repository
            itself; the agent on your laptop does the work and only its output travels.
          </li>
        </ul>

        <h2>What is stored</h2>
        <ul>
          <li>
            <strong>Spoken audio clips and their word timings</strong> are saved to Cloudflare R2 so
            you can tap a past line and hear it again without paying to re-synthesize it. These are
            currently kept indefinitely and are not automatically deleted.
          </li>
          <li>
            <strong>Your conversation transcripts</strong> are stored on your own device — browser
            local storage on the web, app storage on iOS — not on our servers. Clearing the app&apos;s
            data removes them.
          </li>
          <li>
            <strong>Live sessions</strong> exist only in the relay&apos;s memory and are gone when it
            restarts.
          </li>
          <li>
            <strong>Your access code</strong> is stored on your device to keep you signed in.
          </li>
        </ul>

        <h2>What is not collected</h2>
        <p>
          There are no accounts, no analytics, no tracking or advertising SDKs, and no third-party
          telemetry. Nothing about you is sold or shared beyond the processors listed above, each of
          which receives only what it needs to do its job.
        </p>

        <h2>Deleting your data</h2>
        <p>
          Transcripts: clear the app&apos;s storage, or use &ldquo;Clear chat&rdquo;. Stored audio
          clips: email the address below and they will be deleted from R2. Rotating your access code
          on your laptop immediately cuts off any device holding the old one.
        </p>

        <h2>Children</h2>
        <p>voizecode is a developer tool and is not directed at children under 13.</p>

        <h2>Changes</h2>
        <p>
          If what we do with data changes, this page changes with it, and the date at the top moves.
        </p>

        <h2>Contact</h2>
        <p>
          Questions or deletion requests: <a href="mailto:wallawitsch@gmail.com">wallawitsch@gmail.com</a>.
          The whole thing is open source at{" "}
          <a href="https://github.com/moritzWa/voizecode">github.com/moritzWa/voizecode</a> if you
          would rather read the code than take our word for it.
        </p>
      </div>
    </div>
  );
}
