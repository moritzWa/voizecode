import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mic, MicOff, Square, Hand, Plus, SendHorizontal, Loader2, X, FolderOpen, History, ClipboardCopy, Check, Settings, GitPullRequest, Search, Play, Pause, AudioLines, Pencil } from "lucide-react";
import { useVoize, VOICES } from "@/hooks/useVoize";
import type { SavedSession, ProjectInfo } from "@/hooks/useVoize";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const MIC_AUTO = "__auto__";

// Render an agent reply as markdown. Fenced code blocks scroll horizontally (no wrap, so
// ASCII diagrams stay aligned on a narrow phone); prose, lists, headings render readably.
function AgentMessage({ text }: { text: string }) {
  return (
    <div className="px-1 py-0.5 text-xs leading-relaxed text-foreground break-words
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
  onProject: (cwd: string, label: string, engine: string) => void;
  onSession: (s: SavedSession, engine: string) => void; onClose: () => void;
}) {
  const [engine, setEngine] = useState("claude"); // which coding agent backs a NEW chat
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[8vh]" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Open a chat</h2>
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-md border text-xs">
              {["claude", "codex"].map((e) => (
                <button key={e} onClick={() => setEngine(e)}
                  className={cn("px-2.5 py-1 capitalize", engine === e ? "bg-primary text-primary-foreground" : "hover:bg-accent")}>{e}</button>
              ))}
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close"><X size={15} /></Button>
          </div>
        </div>
        <div className="overflow-y-auto p-2">
          <div className="px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">New chat in a project</div>
          {projects.length === 0 && <div className="px-2 py-2 text-xs text-muted-foreground">No projects found yet.</div>}
          {projects.map((p) => (
            <button key={p.cwd} onClick={() => onProject(p.cwd, p.label, engine)}
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
            <button key={s.id} onClick={() => onSession(s, "claude")}
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
        <div className="divide-y px-4 py-2">
          <SettingRow title="Ambient thinking sound" desc="Soft shimmer while the agent is working." on={v.thinkingSound} onChange={v.setThinkingSound} />
          <div className="py-2">
            <div className="flex items-center justify-between"><div className="text-sm font-medium">Playback speed</div><div className="text-xs text-muted-foreground">{v.rate.toFixed(1)}x</div></div>
            <Slider min={1} max={3} step={0.1} value={[v.rate]} onValueChange={([r]) => v.setRate(r)} className="mt-2" />
          </div>
          <div className="py-2">
            <div className="text-sm font-medium">Default microphone</div>
            <div className="mb-2 text-xs text-muted-foreground">Auto prefers your Studio Display mic, then the MacBook Pro mic. Pick one to pin it.</div>
            <Select value={v.micPref || MIC_AUTO} onValueChange={(val) => v.setMicPref(val === MIC_AUTO ? "auto" : val)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={MIC_AUTO}>Auto (Studio Display → MacBook Pro)</SelectItem>
                {v.mics.map((m) => <SelectItem key={m.id} value={m.label}>{m.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {v.mics.length === 0 && <div className="mt-1 text-xs text-muted-foreground">Start a call once so the browser reveals device names.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// Split light markdown (**bold**, `code`) into styled words (markers removed), preserving the
// reading order so word index aligns with the TTS word timings.
type StyledWord = { text: string; bold?: boolean; code?: boolean };
function styledWords(text: string): StyledWord[] {
  const out: StyledWord[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|([^*`]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const seg = m[1] != null ? { v: m[1], bold: true } : m[2] != null ? { v: m[2], code: true } : { v: m[3] };
    for (const p of seg.v.split(/\s+/)) if (p) out.push({ text: p, bold: seg.bold, code: seg.code });
  }
  return out;
}

// Speechify-style spoken line: renders light markdown (**bold**, `code`) and highlights the word
// at playback time `t`. The highlight is the active word's own background, so it stays visible even
// on `code` words (a code word turns periwinkle when read instead of keeping its dark code bg).
// The inter-word space sits OUTSIDE the styled span, so no trailing space gets the code/highlight bg.
// Pass words=[] for an inactive line (renders styled text, no highlight).
function SpokenLine({ words, t, text }: { words: { text: string; start: number }[]; t: number; text: string }) {
  const sw = useMemo(() => styledWords(text), [text]);
  let active = -1;
  for (let i = 0; i < words.length; i++) { if (words[i].start <= t) active = i; else break; }
  return (
    <span>
      {sw.map((w, i) => {
        const isActive = i === active;
        return (
          <span key={i}>
            <span className={cn(
              "rounded-[2px]",
              w.bold && "font-semibold",
              w.code && "px-1 font-mono text-[0.9em]",
              isActive ? "bg-[#c3c4f5] dark:bg-indigo-400/40" : w.code ? "bg-background" : undefined,
            )}>{w.text}</span>
            {i < sw.length - 1 ? " " : ""}
          </span>
        );
      })}
    </span>
  );
}

// Bucket a PR by how long ago it was created, for scroll-orientation headers.
function prBucket(createdAt: string): string {
  const days = (Date.now() - new Date(createdAt).getTime()) / 86400000;
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 7) return "This week";
  if (days < 14) return "Last week";
  if (days < 21) return "2 weeks ago";
  if (days < 28) return "3 weeks ago";
  if (days < 60) return "Last month";
  return new Date(createdAt).toLocaleString(undefined, { month: "long", year: "numeric" });
}

// Modal listing the chat repo's PRs (yours, or all; incl. drafts); search + recency headers; pick one to talk through it.
function PRModal({ v, onPick, onClose }: { v: ReturnType<typeof useVoize>; onPick: (pr: { number: number; title: string; url: string }) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [loading, setLoading] = useState(true);
  useEffect(() => { setLoading(true); v.requestPRs(scope); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setLoading(false); }, [v.prs]);
  const query = q.trim().toLowerCase();
  const filtered = query ? v.prs.filter((p) => p.title.toLowerCase().includes(query)) : v.prs;
  let lastBucket = "";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]" onClick={onClose}>
      <div className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Talk through a PR</h2>
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-md border text-xs">
              {(["mine", "all"] as const).map((sc) => (
                <button key={sc} onClick={() => setScope(sc)}
                  className={cn("px-2.5 py-1 capitalize", scope === sc ? "bg-primary text-primary-foreground" : "hover:bg-accent")}>
                  {sc === "mine" ? "Mine" : "All"}
                </button>
              ))}
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close"><X size={15} /></Button>
          </div>
        </div>
        <div className="border-b p-2">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={scope === "all" ? "Search all PRs…" : "Search your PRs…"} className="h-8 pl-8 text-sm" />
          </div>
        </div>
        <div className="overflow-y-auto p-2">
          {loading && <div className="px-2 py-3 text-xs text-muted-foreground">Loading PRs…</div>}
          {!loading && v.prs.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">No {scope === "all" ? "" : "authored "}PRs found in this repo (needs <code>gh</code> auth + a GitHub remote).</div>}
          {!loading && v.prs.length > 0 && filtered.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">No PRs match “{q}”.</div>}
          {!loading && filtered.map((p) => {
            const bucket = prBucket(p.createdAt);
            const header = bucket !== lastBucket ? bucket : null;
            lastBucket = bucket;
            return (
              <div key={p.number}>
                {header && <div className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{header}</div>}
                <button onClick={() => onPick(p)} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent">
                  <GitPullRequest size={15} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{p.title}</span>
                  {scope === "all" && p.author && <span className="shrink-0 text-xs text-muted-foreground">{p.author}</span>}
                  {p.isDraft && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">draft</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Shown when the relay rejects the access code (wrong/missing). Lets the user paste the code.
function AccessGate({ onSubmit }: { onSubmit: (code: string) => void }) {
  const [code, setCode] = useState("");
  return (
    <main className="mx-auto flex h-screen max-w-sm flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-lg font-semibold">voizecode</h1>
      <p className="text-sm text-muted-foreground">Enter your access code to connect. It came from your laptop agent (or open the <code>?key=…</code> link it printed).</p>
      <form className="flex w-full gap-2" onSubmit={(e) => { e.preventDefault(); onSubmit(code); }}>
        <Input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="access code" className="flex-1" />
        <Button type="submit" disabled={!code.trim()}>Connect</Button>
      </form>
    </main>
  );
}

export default function Home() {
  const v = useVoize();
  const [draft, setDraft] = useState("");
  const [browser, setBrowser] = useState(false);
  const [settings, setSettings] = useState(false);
  const [prModal, setPrModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [forkPoint, setForkPoint] = useState<number | null>(null); // userIndex being edited (fork on send)
  const taRef = useRef<HTMLTextAreaElement>(null);
  const isCodexChat = v.model === "codex"; // forking is Claude-only
  const openBrowser = () => { v.requestSessions(); setBrowser(true); };
  const growInput = (el: HTMLTextAreaElement) => { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; };
  const resetInput = () => { setDraft(""); setForkPoint(null); if (taRef.current) taRef.current.style.height = "auto"; };
  const submit = () => {
    if (!draft.trim()) return;
    if (forkPoint != null) v.forkChat(forkPoint, draft); else v.sendText(draft);
    resetInput();
  };
  const editFrom = (userIndex: number, text: string) => { setForkPoint(userIndex); setDraft(text); requestAnimationFrame(() => { const el = taRef.current; if (el) { el.focus(); growInput(el); } }); };

  if (v.authError) return <AccessGate onSubmit={v.submitCode} />;

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col gap-3 p-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">voizecode</h1>
          <Button size="sm" onClick={openBrowser} title="Open or start a chat">
            <Plus size={13} /> New chat
          </Button>
          <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("whitespace-nowrap", v.connected ? "text-green-600 dark:text-green-400" : "text-destructive")}>
              {v.connected ? "connected" : "connecting…"}
            </span>
            {v.thinking && <Loader2 size={14} className="animate-spin text-blue-600 dark:text-blue-400" />}
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Copy debug info (project, chat, claude session id)"
              onClick={async () => { await v.copyDebug(); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
              {copied ? <Check size={14} className="text-green-600" /> : <ClipboardCopy size={14} />}
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Settings" onClick={() => setSettings(true)}>
              <Settings size={14} />
            </Button>
            <Select value={v.model} onValueChange={v.setModel}>
              <SelectTrigger className="h-7 w-[92px] text-xs" title="Claude model"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="haiku">haiku</SelectItem>
                <SelectItem value="sonnet">sonnet</SelectItem>
                <SelectItem value="opus">opus</SelectItem>
              </SelectContent>
            </Select>
            <Select value={v.voice} onValueChange={v.setVoice}>
              <SelectTrigger className="h-7 w-[140px] text-xs" title="Narrator voice"><SelectValue /></SelectTrigger>
              <SelectContent>
                {VOICES.map((vo) => <SelectItem key={vo.id} value={vo.id}>{vo.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
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
          {(() => { let userSeen = 0; return v.lines.map((l, i) => {
            if (l.kind === "agent") return <AgentMessage key={i} text={l.text} />;
            if (l.kind === "speech") {
              const active = l.clip != null && l.clip === v.speakingClip;
              const words = l.clip != null ? v.clipWords[l.clip] : undefined;
              return (
                <div key={i} onClick={() => l.key && v.replayClip(l)}
                  title={l.key ? "Click to replay" : undefined}
                  className={cn("break-words rounded px-1 py-0.5 text-sm transition-colors",
                    active ? "bg-[#e7e6fb] dark:bg-indigo-400/15" : l.key && "cursor-pointer hover:bg-muted")}>
                  <SpokenLine words={active && words?.length ? words : []} t={active ? v.speakingTime : 0} text={l.text} />
                </div>
              );
            }
            if (l.kind === "user") {
              const userIndex = userSeen++;
              return (
                <div key={i} className="group flex items-center justify-end gap-1.5 self-end">
                  {!isCodexChat && (
                    <button onClick={() => editFrom(userIndex, l.text)} title="Edit from here (forks the chat)"
                      className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100">
                      <Pencil size={13} />
                    </button>
                  )}
                  <div className="max-w-[85%] break-words rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground">{l.text}</div>
                </div>
              );
            }
            return <div key={i} className="break-words px-1 text-xs italic text-muted-foreground">{l.text}</div>;
          }); })()}
          {v.interim && <div className="self-end px-3 text-sm text-muted-foreground">{v.interim}…</div>}
        </div>
      </div>

      {v.micError && <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{v.micError}</div>}

      {!v.live ? (
        <div className="flex gap-2">
          <Button variant="success" size="xl" className="flex-1" onClick={() => v.start()}>
            <Mic size={18} /> Start call
          </Button>
          <Button variant="outline" size="xl" className="flex-1 font-semibold" onClick={() => v.start(true)}>
            <AudioLines size={18} /> Ramble
          </Button>
          <Button variant="outline" size="xl" className="px-4" onClick={v.togglePlayback}
            title={v.paused ? "Resume" : "Pause (or click a line to replay)"} aria-label="Play or pause">
            {v.paused ? <Play size={18} /> : <Pause size={18} />}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {/* ramble/dictation: talk freely with pauses; the agent waits until you tap to send */}
          <Button size="xl" className={cn("text-base font-semibold", v.rambling && "bg-red-600 text-white hover:bg-red-700")}
            variant={v.rambling ? "default" : "outline"} onClick={v.toggleRamble}>
            {v.rambling
              ? <><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-white" /> Recording — tap to send</>
              : <><AudioLines size={20} /> Ramble (talk freely, send when done)</>}
          </Button>
          {/* large primary mute toggle — silence ambient talk without ending the call */}
          <Button size="xl" variant={v.muted ? "destructive" : "secondary"} className="text-base font-semibold" onClick={v.toggleMute}>
            {v.muted ? <><MicOff size={22} /> Muted — tap to talk</> : <><Mic size={22} /> Mute mic</>}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" className="px-4" onClick={v.togglePlayback}
              title={v.paused ? "Resume" : "Pause (or click a line to replay)"} aria-label="Play or pause">
              {v.paused ? <Play size={15} /> : <Pause size={15} />}
            </Button>
            <Button variant="secondary" className="flex-1" onClick={v.stop}><Square size={15} /> Stop</Button>
            <Button className="flex-1 bg-amber-500 text-white hover:bg-amber-600" onClick={v.interruptNow}><Hand size={15} /> Interrupt</Button>
          </div>
        </div>
      )}

      {forkPoint != null && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-amber-400/40 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <span className="flex items-center gap-1.5"><Pencil size={12} /> Editing from here — sending rewinds the chat to this point (the rest is discarded).</span>
          <button onClick={resetInput} className="shrink-0 rounded p-0.5 hover:bg-amber-500/20" aria-label="Cancel edit"><X size={13} /></button>
        </div>
      )}
      <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Button type="button" variant="outline" size="icon" title="Talk through one of your PRs"
          onClick={() => setPrModal(true)}><GitPullRequest size={15} /></Button>
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
          onProject={(cwd, label, engine) => { v.newInProject(cwd, label, engine); setBrowser(false); }}
          onSession={(s, engine) => { v.openSession(s.id, s.cwd, s.label, engine); setBrowser(false); }}
          onClose={() => setBrowser(false)}
        />
      )}
      {settings && <SettingsModal v={v} onClose={() => setSettings(false)} />}
      {prModal && <PRModal v={v} onClose={() => setPrModal(false)}
        onPick={(p) => { v.sendText(`Let's look at my PR #${p.number}: "${p.title}" (${p.url}). Read the diff with gh to understand the code, then wait for my instructions.`); setPrModal(false); }} />}
    </main>
  );
}
