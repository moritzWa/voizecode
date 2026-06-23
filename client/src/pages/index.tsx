import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mic, MicOff, Square, Hand, Plus, SendHorizontal, Loader2, X } from "lucide-react";
import { useVoize, VOICES } from "@/hooks/useVoize";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const MIC_DEFAULT = "__default__";

// Render an agent reply as markdown. Fenced code blocks scroll horizontally (no wrap, so
// ASCII diagrams stay aligned on a narrow phone); prose, lists, headings render readably.
function AgentMessage({ text }: { text: string }) {
  return (
    <div className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-foreground break-words
      [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0
      [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5
      [&_h1]:mb-1 [&_h1]:mt-2 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:font-semibold
      [&_strong]:font-semibold [&_a]:text-blue-600 dark:[&_a]:text-blue-400 [&_a]:underline
      [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_pre]:rounded [&_pre]:bg-background [&_pre]:p-2 [&_pre]:font-mono [&_pre]:border
      [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-background [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-mono">
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
          <Button size="sm" onClick={v.newSession} title="New chat in a separate tab">
            <Plus size={13} /> New chat
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
          <Select value={v.model} onValueChange={v.setModel}>
            <SelectTrigger className="w-[88px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="haiku">haiku</SelectItem>
              <SelectItem value="sonnet">sonnet</SelectItem>
              <SelectItem value="opus">opus</SelectItem>
            </SelectContent>
          </Select>
          <Select value={v.voice} onValueChange={v.setVoice}>
            <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {VOICES.map((vo) => <SelectItem key={vo.id} value={vo.id}>{vo.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className={v.connected ? "text-green-600 dark:text-green-400" : "text-destructive"}>
            {v.connected ? "connected" : "connecting…"}
          </span>
          {v.thinking && <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400"><Loader2 size={13} className="animate-spin" /> working…</span>}
        </div>
      </header>

      {/* session tabs */}
      <div className="flex gap-1 overflow-x-auto">
        {v.sessions.length === 0 && <span className="text-xs text-muted-foreground">no sessions — start a laptop agent in a repo</span>}
        {v.sessions.map((s) => (
          <div key={s.sessionId}
            className={cn("flex items-center gap-1.5 rounded-t-lg pl-3 pr-1.5 text-sm",
              s.sessionId === v.activeId ? "bg-card font-medium" : "bg-muted text-muted-foreground")}>
            <button onClick={() => v.switchSession(s.sessionId)} className="flex items-center gap-1.5 py-1.5">
              {s.label}
              {v.unread[s.sessionId] && s.sessionId !== v.activeId && <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />}
            </button>
            {v.sessions.length > 1 && (
              <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => v.closeSession(s.sessionId)} title="Close chat (ends its claude)" aria-label="Close chat">
                <X size={13} />
              </Button>
            )}
          </div>
        ))}
        {v.sessions.length > 0 && (
          <Button variant="ghost" size="icon" className="h-8 rounded-t-lg" onClick={v.newSession} title="New chat" aria-label="New chat">
            <Plus size={15} />
          </Button>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto rounded-lg border bg-card p-3">
        {v.lines.map((l, i) => (
          l.kind === "agent" ? <AgentMessage key={i} text={l.text} /> :
          <div key={i} className={cn("break-words",
            l.kind === "user" ? "self-end rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground" :
            l.kind === "speech" ? cn("rounded-lg px-3 py-1.5 text-sm transition-colors",
              l.clip != null && l.clip === v.speakingClip ? "bg-accent ring-1 ring-primary/40" : "bg-muted") :
            "px-1 text-xs italic text-muted-foreground")}>{l.text}</div>
        ))}
        {v.interim && <div className="self-end px-3 text-sm text-muted-foreground">{v.interim}…</div>}
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <label className="whitespace-nowrap">speed {v.rate.toFixed(1)}x</label>
        <Slider min={1} max={3} step={0.1} value={[v.rate]} onValueChange={([r]) => v.setRate(r)} className="flex-1" />
      </div>

      {v.mics.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Mic size={14} className="shrink-0" />
          <Select value={v.micId || MIC_DEFAULT} onValueChange={(val) => v.setMic(val === MIC_DEFAULT ? "" : val)}>
            <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={MIC_DEFAULT}>Default mic</SelectItem>
              {v.mics.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}

      {v.micError && <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{v.micError}</div>}

      {!v.live ? (
        <Button variant="success" size="xl" onClick={v.start}>
          <Mic size={18} /> Start call
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          {/* large primary mute toggle — silence ambient talk without ending the call */}
          <Button size="xl" variant={v.muted ? "destructive" : "secondary"} className="text-base font-semibold" onClick={v.toggleMute}>
            {v.muted ? <><MicOff size={22} /> Muted — tap to talk</> : <><Mic size={22} /> Mute mic</>}
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={v.stop}><Square size={15} /> Stop</Button>
            <Button className="flex-1 bg-amber-500 text-white hover:bg-amber-600" onClick={v.interruptNow}><Hand size={15} /> Interrupt</Button>
          </div>
        </div>
      )}

      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { v.sendText(draft); setDraft(""); } }}>
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="or type…" />
        <Button type="submit" size="icon"><SendHorizontal size={15} /></Button>
      </form>
    </main>
  );
}
