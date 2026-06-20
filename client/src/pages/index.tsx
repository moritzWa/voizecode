import { useState } from "react";
import { useVoize } from "@/hooks/useVoize";

// Render an agent reply: fenced ```code``` blocks become horizontally-scrollable
// monospace (no wrap, so ASCII diagrams stay aligned on a narrow phone); prose wraps.
function AgentMessage({ text }: { text: string }) {
  const parts = text.split(/```[^\n]*\n?/);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-zinc-50 px-3 py-1.5 text-xs text-zinc-700">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="overflow-x-auto whitespace-pre rounded bg-zinc-100 p-2 font-mono leading-snug">{part.replace(/\n$/, "")}</pre>
        ) : (
          part.trim() && <span key={i} className="whitespace-pre-wrap break-words">{part}</span>
        )
      )}
    </div>
  );
}

export default function Home() {
  const v = useVoize();
  const [draft, setDraft] = useState("");

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">voizecode</h1>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <select value={v.model} onChange={(e) => v.setModel(e.target.value)}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs">
            <option value="haiku">haiku</option>
            <option value="sonnet">sonnet</option>
            <option value="opus">opus</option>
          </select>
          <span className={v.connected ? "text-green-600" : "text-red-500"}>
            {v.connected ? "relay connected" : "connecting…"}
          </span>
          {v.thinking && <span className="animate-pulse text-blue-600">working…</span>}
        </div>
      </header>

      {/* session tabs */}
      <div className="flex gap-1 overflow-x-auto">
        {v.sessions.length === 0 && <span className="text-xs text-zinc-400">no sessions — start a laptop agent in a repo</span>}
        {v.sessions.map((s) => (
          <button key={s.sessionId} onClick={() => v.switchSession(s.sessionId)}
            className={`flex items-center gap-1.5 rounded-t-lg px-3 py-1.5 text-sm ${s.sessionId === v.activeId ? "bg-white font-medium" : "bg-zinc-200 text-zinc-600"}`}>
            {s.label}
            {v.unread[s.sessionId] && s.sessionId !== v.activeId && <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />}
          </button>
        ))}
      </div>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3">
        {v.lines.map((l, i) => (
          l.kind === "agent" ? <AgentMessage key={i} text={l.text} /> :
          <div key={i} className={
            l.kind === "user" ? "self-end break-words rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white" :
            l.kind === "speech" ? "break-words rounded-lg bg-zinc-100 px-3 py-1.5 text-sm" :
            "break-words px-1 text-xs italic text-zinc-400"
          }>{l.text}</div>
        ))}
        {v.interim && <div className="self-end px-3 text-sm text-zinc-400">{v.interim}…</div>}
      </div>

      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <label>speed {v.rate.toFixed(1)}x</label>
        <input type="range" min={1} max={3} step={0.1} value={v.rate}
          onChange={(e) => v.setRate(Number(e.target.value))} className="flex-1" />
      </div>

      <div className="flex gap-2">
        {!v.live ? (
          <button onClick={v.start} className="flex-1 rounded-lg bg-green-600 py-2 text-sm font-medium text-white">
            🎙️ Start call
          </button>
        ) : (
          <>
            <button onClick={v.stop} className="rounded-lg bg-zinc-200 px-4 py-2 text-sm">Stop</button>
            <button onClick={v.interruptNow} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white">
              ✋ Interrupt
            </button>
          </>
        )}
      </div>

      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { v.sendText(draft); setDraft(""); } }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="or type…"
          className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm" />
        <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">Send</button>
      </form>
    </main>
  );
}
