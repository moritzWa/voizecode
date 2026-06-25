import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mic, MicOff, Square, Hand, Plus, SendHorizontal, Loader2, X, FolderOpen, History, ClipboardCopy, Check, Settings, GitPullRequest } from "lucide-react";
import { useVoize, VOICES } from "@/hooks/useVoize";
import type { SavedSession, ProjectInfo } from "@/hooks/useVoize";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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

function timeAgo(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Modal to start a new chat in a project that already has sessions, or resume a past session.
function SessionBrowser({ projects, sessions, onProject, onSession, onClose }: {
  projects: ProjectInfo[]; sessions: SavedSession[];
  onProject: (cwd: string, label: string) => void;
  onSession: (s: SavedSession) => void; onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[8vh]" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Open a chat</h2>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close"><X size={15} /></Button>
        </div>
        <div className="overflow-y-auto p-2">
          <div className="px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">New chat in a project</div>
          {projects.length === 0 && <div className="px-2 py-2 text-xs text-muted-foreground">No projects found yet.</div>}
          {projects.map((p) => (
            <button key={p.cwd} onClick={() => onProject(p.cwd, p.label)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent">
              <FolderOpen size={15} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{p.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{p.cwd}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{p.count} session{p.count === 1 ? "" : "s"}</span>
            </button>
          ))}

          <div className="mt-2 px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Resume a session</div>
          {sessions.length === 0 && <div className="px-2 py-2 text-xs text-muted-foreground">No past sessions.</div>}
          {sessions.map((s) => (
            <button key={s.id} onClick={() => onSession(s)}
              className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent">
              <History size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{s.preview}</span>
                <span className="block truncate text-xs text-muted-foreground">{s.label} · {timeAgo(s.mtime)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// A row in the settings modal with a toggle switch.
function SettingRow({ title, desc, on, onChange }: { title: string; desc: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
      <button role="switch" aria-checked={on} onClick={() => onChange(!on)}
        className={cn("inline-flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors", on ? "bg-primary" : "bg-input")}>
        <span className={cn("h-5 w-5 rounded-full bg-background shadow transition-transform", on ? "translate-x-5" : "translate-x-0")} />
      </button>
    </div>
  );
}

function SettingsModal({ v, onClose }: { v: ReturnType<typeof useVoize>; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border bg-popover text-popover-foreground shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Settings</h2>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close"><X size={15} /></Button>
        </div>
        <div className="px-4 py-2">
          <SettingRow title="Ambient thinking sound" desc="Soft shimmer while the agent is working." on={v.thinkingSound} onChange={v.setThinkingSound} />
        </div>
      </div>
    </div>
  );
}

// Speechify-style: render a spoken line word-by-word, highlighting the word at playback time `t`.
function SpokenWords({ words, t, fallback }: { words: { text: string; start: number }[]; t: number; fallback: string }) {
  if (!words.length) return <>{fallback}</>;
  let active = -1;
  for (let i = 0; i < words.length; i++) { if (words[i].start <= t) active = i; else break; }
  return (
    <>
      {words.map((w, i) => (
        <span key={i} className={i === active ? "rounded bg-primary/30 box-decoration-clone" : undefined}>
          {w.text}{i < words.length - 1 ? " " : ""}
        </span>
      ))}
    </>
  );
}

// Modal listing the chat repo's authored PRs (incl. drafts); pick one to talk through it.
function PRModal({ v, onPick, onClose }: { v: ReturnType<typeof useVoize>; onPick: (pr: { number: number; title: string; url: string }) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]" onClick={onClose}>
      <div className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Talk through a PR</h2>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close"><X size={15} /></Button>
        </div>
        <div className="overflow-y-auto p-2">
          {v.prs.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">No authored PRs found in this repo (needs <code>gh</code> auth + a GitHub remote).</div>}
          {v.prs.map((p) => (
            <button key={p.number} onClick={() => onPick(p)} className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent">
              <GitPullRequest size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">#{p.number} {p.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{p.isDraft ? "draft · " : ""}{new Date(p.createdAt).toLocaleDateString()}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const v = useVoize();
  const [draft, setDraft] = useState("");
  const [browser, setBrowser] = useState(false);
  const [settings, setSettings] = useState(false);
  const [prModal, setPrModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const openBrowser = () => { v.requestSessions(); setBrowser(true); };
  const growInput = (el: HTMLTextAreaElement) => { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; };
  const submit = () => { if (!draft.trim()) return; v.sendText(draft); setDraft(""); if (taRef.current) taRef.current.style.height = "auto"; };

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">voizecode</h1>
          <Button size="sm" onClick={openBrowser} title="Open or start a chat">
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
          <Button variant="ghost" size="icon" className="h-7 w-7" title="Copy debug info (project, chat, claude session id)"
            onClick={async () => { await v.copyDebug(); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
            {copied ? <Check size={14} className="text-green-600" /> : <ClipboardCopy size={14} />}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" title="Settings" onClick={() => setSettings(true)}>
            <Settings size={14} />
          </Button>
          <span className={v.connected ? "text-green-600 dark:text-green-400" : "text-destructive"}>
            {v.connected ? "connected" : "connecting…"}
          </span>
          {v.thinking && <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400"><Loader2 size={13} className="animate-spin" /> working…</span>}
        </div>
      </header>

      {/* session tabs attached to the chat panel (no gap) */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-end gap-1 overflow-x-auto overflow-y-hidden pt-1">
          {v.sessions.length === 0 && <span className="px-1 pb-2 text-xs text-muted-foreground">no sessions — start the laptop agent</span>}
          {v.sessions.map((s) => {
            const activeTab = s.sessionId === v.activeId;
            const title = v.titles[s.sessionId];
            return (
              <div key={s.sessionId}
                className={cn("flex max-w-[230px] items-center gap-1 rounded-t-lg border border-b-0 pl-3 pr-1 text-sm",
                  activeTab ? "-mb-px border-border bg-card" : "border-transparent bg-muted text-muted-foreground hover:bg-muted/70")}>
                <button onClick={() => v.switchSession(s.sessionId)} className="flex min-w-0 items-center gap-1.5 py-2">
                  <span className="truncate">
                    <span className="font-medium">{s.label}</span>
                    {title && <span className="text-muted-foreground"> · {title}</span>}
                  </span>
                  {v.unread[s.sessionId] && !activeTab && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />}
                </button>
                {v.sessions.length > 1 && (
                  <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0 opacity-60 hover:opacity-100" onClick={() => v.closeSession(s.sessionId)} title="Close chat (ends its claude)" aria-label="Close chat">
                    <X size={12} />
                  </Button>
                )}
              </div>
            );
          })}
          {v.sessions.length > 0 && (
            <Button variant="ghost" size="icon" className="mb-px h-8 shrink-0" onClick={openBrowser} title="New chat" aria-label="New chat">
              <Plus size={15} />
            </Button>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg rounded-tl-none border bg-card p-3">
          {v.lines.map((l, i) => {
            if (l.kind === "agent") return <AgentMessage key={i} text={l.text} />;
            if (l.kind === "speech") {
              const active = l.clip != null && l.clip === v.speakingClip;
              const words = l.clip != null ? v.clipWords[l.clip] : undefined;
              return (
                <div key={i} className={cn("break-words rounded-lg px-3 py-1.5 text-sm transition-colors", active ? "bg-accent" : "bg-muted")}>
                  {active && words ? <SpokenWords words={words} t={v.speakingTime} fallback={l.text} /> : l.text}
                </div>
              );
            }
            return <div key={i} className={cn("break-words",
              l.kind === "user" ? "self-end rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground" :
              "px-1 text-xs italic text-muted-foreground")}>{l.text}</div>;
          })}
          {v.interim && <div className="self-end px-3 text-sm text-muted-foreground">{v.interim}…</div>}
        </div>
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

      <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Button type="button" variant="outline" size="icon" title="Talk through one of your PRs"
          onClick={() => { v.requestPRs(); setPrModal(true); }}><GitPullRequest size={15} /></Button>
        <Textarea ref={taRef} rows={1} value={draft}
          onChange={(e) => { setDraft(e.target.value); growInput(e.currentTarget); }}
          placeholder={v.thinking && !draft.trim() ? "running — type to steer, or stop →" : "or type…  (Shift+Enter = newline)"}
          className="max-h-40 min-h-[38px] resize-none overflow-y-auto leading-snug"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            else if (e.key === "Escape" && v.thinking) { e.preventDefault(); v.interruptNow(); }
          }} />
        {draft.trim() ? (
          <Button type="submit" size="icon" title="Send (steers the agent if it's running)"><SendHorizontal size={15} /></Button>
        ) : v.thinking ? (
          <Button type="button" variant="destructive" size="icon" title="Stop the agent (Esc)" onClick={v.interruptNow}><Square size={15} /></Button>
        ) : (
          <Button type="submit" size="icon" disabled><SendHorizontal size={15} /></Button>
        )}
      </form>

      {browser && (
        <SessionBrowser
          projects={v.projects} sessions={v.savedSessions}
          onProject={(cwd, label) => { v.newInProject(cwd, label); setBrowser(false); }}
          onSession={(s) => { v.openSession(s.id, s.cwd, s.label); setBrowser(false); }}
          onClose={() => setBrowser(false)}
        />
      )}
      {settings && <SettingsModal v={v} onClose={() => setSettings(false)} />}
      {prModal && <PRModal v={v} onClose={() => setPrModal(false)}
        onPick={(p) => { v.sendText(`Let's walk through my PR #${p.number}: "${p.title}" (${p.url}). Read the diff with gh and explain what it does, then flag anything worth a second look.`); setPrModal(false); }} />}
    </main>
  );
}
