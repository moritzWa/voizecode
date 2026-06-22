import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mic, MicOff, Square, Hand, Plus, SendHorizontal, Loader2 } from "lucide-react";
import { useVoize, VOICES } from "@/hooks/useVoize";

// Render an agent reply as markdown. Fenced code blocks scroll horizontally (no wrap, so
// ASCII diagrams stay aligned on a narrow phone); prose, lists, headings render readably.
function AgentMessage({ text }: { text: string }) {
  return (
    <div className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-700 break-words
      [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0
      [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5
      [&_h1]:mb-1 [&_h1]:mt-2 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:font-semibold
      [&_strong]:font-semibold [&_a]:text-blue-600 [&_a]:underline
      [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_pre]:rounded [&_pre]:bg-zinc-100 [&_pre]:p-2 [&_pre]:font-mono
      [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-zinc-200 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-mono">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

export default function Home() {
  const v = useVoize();
  const [draft, setDraft] = useState("");

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">voizecode</h1>
          <button onClick={v.clearChat} title="New chat — clears history + resets context"
            className="flex items-center gap-1 rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700">
            <Plus size={13} /> New chat
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-zinc-500">
          <select value={v.model} onChange={(e) => v.setModel(e.target.value)}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs">
            <option value="haiku">haiku</option>
            <option value="sonnet">sonnet</option>
            <option value="opus">opus</option>
          </select>
          <select value={v.voice} onChange={(e) => v.setVoice(e.target.value)} title="voice"
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs">
            {VOICES.map((vo) => <option key={vo.id} value={vo.id}>{vo.label}</option>)}
          </select>
          <span className={v.connected ? "text-green-600" : "text-red-500"}>
            {v.connected ? "connected" : "connecting…"}
          </span>
          {v.thinking && <span className="flex items-center gap-1 text-blue-600"><Loader2 size={13} className="animate-spin" /> working…</span>}
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
        <label className="whitespace-nowrap">speed {v.rate.toFixed(1)}x</label>
        <input type="range" min={1} max={3} step={0.1} value={v.rate}
          onChange={(e) => v.setRate(Number(e.target.value))} className="flex-1" />
      </div>

      {v.mics.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Mic size={14} className="shrink-0" />
          <select value={v.micId} onChange={(e) => v.setMic(e.target.value)}
            className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-xs">
            <option value="">Default</option>
            {v.mics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      )}

      {v.micError && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{v.micError}</div>}

      {!v.live ? (
        <button onClick={v.start}
          className="flex items-center justify-center gap-2 rounded-lg bg-green-600 py-3 text-sm font-medium text-white hover:bg-green-700">
          <Mic size={18} /> Start call
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          {/* large primary mute toggle — silence ambient talk without ending the call */}
          <button onClick={v.toggleMute}
            className={`flex items-center justify-center gap-2 rounded-lg py-4 text-base font-semibold text-white ${v.muted ? "bg-red-600 hover:bg-red-700" : "bg-zinc-700 hover:bg-zinc-800"}`}>
            {v.muted ? <><MicOff size={22} /> Muted — tap to talk</> : <><Mic size={22} /> Mute mic</>}
          </button>
          <div className="flex gap-2">
            <button onClick={v.stop} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-zinc-200 py-2 text-sm hover:bg-zinc-300">
              <Square size={15} /> Stop
            </button>
            <button onClick={v.interruptNow} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-amber-500 py-2 text-sm font-medium text-white hover:bg-amber-600">
              <Hand size={15} /> Interrupt
            </button>
          </div>
        </div>
      )}

      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { v.sendText(draft); setDraft(""); } }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="or type…"
          className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm" />
        <button className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
          <SendHorizontal size={15} />
        </button>
      </form>
    </main>
  );
}
