// Ports of the web client's three modals: Settings, the session browser, and the PR picker.
// Same information, same ordering; the controls become native ones (a Switch instead of a
// role="switch" button, a row of chips instead of a Radix Select, since a native picker sheet
// for three options is more taps than it saves).
import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { ChevronRight, FolderOpen, GitPullRequest, History, Search, X } from "lucide-react-native";
import type { ProjectInfo, PullRequest, SavedSession } from "@shared/protocol";
import { VOICES } from "../core/useVoize";
import { usePalette } from "./theme";
import { updateInfo } from "./updates";

const RATES = [1, 1.5, 2, 2.5, 3];

// A bottom sheet, not a centred dialog. On a phone a modal that floats in the middle of the
// screen reads as a website in a webview; sheets rise from the bottom edge, sit under the thumb,
// and are what every native app uses for this. Grabber, large top corners, slide-up animation.
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const MUTED = usePalette().mutedForeground;
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      {/* accessible={false} on both: a Pressable is one accessibility element by default, which
          would collapse every control in the sheet into a single concatenated label — unusable
          with VoiceOver and invisible to the e2e flows. */}
      <Pressable accessible={false} className="flex-1 justify-end bg-black/60" onPress={onClose}>
        <Pressable
          accessible={false}
          className="max-h-[88%] rounded-t-[28px] border-t border-x border-border bg-popover overflow-hidden pb-8"
          onPress={() => { /* swallow: an inside tap must not close the sheet */ }}
        >
          <View className="items-center pt-2.5 pb-1">
            <View className="h-1 w-9 rounded-full bg-sheet-grabber" />
          </View>
          <View className="flex-row items-center justify-between px-5 pb-3 pt-1">
            <Text className="text-foreground text-[17px] font-semibold tracking-tight">{title}</Text>
            <Pressable onPress={onClose} hitSlop={10}
              accessibilityRole="button" accessibilityLabel="Close sheet"
              className="h-7 w-7 items-center justify-center rounded-full bg-secondary active:opacity-60">
              <X size={14} color={MUTED} />
            </Pressable>
          </View>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function Chip({ label, on, onPress }: { label: string; on?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-full px-3.5 py-2 active:opacity-70 ${on ? "bg-foreground" : "bg-secondary"}`}
    >
      <Text className={`text-[13.5px] ${on ? "text-background font-semibold" : "text-muted-foreground"}`}>{label}</Text>
    </Pressable>
  );
}

// A tappable list row in the native idiom: full-bleed, chevron on the right, separated by
// insets rather than boxes.
function Row({ icon, title, subtitle, right, onPress }: {
  icon: React.ReactNode; title: string; subtitle?: string; right?: React.ReactNode; onPress: () => void;
}) {
  const p = usePalette();
  return (
    <Pressable onPress={onPress} className="flex-row items-center gap-3 rounded-2xl px-3 py-3 active:bg-secondary">
      <View className="h-9 w-9 items-center justify-center rounded-xl bg-secondary">{icon}</View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-foreground text-[15px]">{title}</Text>
        {!!subtitle && <Text numberOfLines={1} className="text-muted-foreground text-[12.5px] mt-0.5">{subtitle}</Text>}
      </View>
      {right}
      <ChevronRight size={16} color={p.faint} />
    </Pressable>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text className="px-3 pb-1.5 pt-3 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </Text>
  );
}

export function SettingsModal({ v, onClose }: { v: any; onClose: () => void }) {
  const MUTED = usePalette().mutedForeground;
  return (
    <Sheet title="Settings" onClose={onClose}>
      <ScrollView className="px-4" contentContainerClassName="pb-4">
        {/* Grouped cards, the way iOS Settings groups things — not a stack of bordered rows. */}
        <View className="rounded-2xl bg-card/60 p-3.5 mb-3">
          <Text className="text-foreground text-[15px] font-medium mb-2.5">Claude model</Text>
          <View className="flex-row gap-2">
            {["haiku", "sonnet", "opus"].map((m) => (
              <Chip key={m} label={m} on={v.model === m} onPress={() => v.setModel(m)} />
            ))}
          </View>
        </View>

        <View className="rounded-2xl bg-card/60 p-3.5 mb-3">
          <Text className="text-foreground text-[15px] font-medium mb-2.5">Narrator voice</Text>
          <View className="flex-row flex-wrap gap-2">
            {VOICES.map((vo) => (
              <Chip key={vo.id} label={vo.label} on={v.voice === vo.id} onPress={() => v.setVoice(vo.id)} />
            ))}
          </View>
        </View>

        <View className="rounded-2xl bg-card/60 p-3.5 mb-3">
          <View className="flex-row items-center justify-between mb-2.5">
            <Text className="text-foreground text-[15px] font-medium">Playback speed</Text>
            <Text className="text-muted-foreground text-[13px]">{v.rate.toFixed(1)}x</Text>
          </View>
          <View className="flex-row gap-2">
            {RATES.map((r) => <Chip key={r} label={`${r}x`} on={v.rate === r} onPress={() => v.setRate(r)} />)}
          </View>
        </View>

        <View className="flex-row items-center justify-between gap-4 rounded-2xl bg-card/60 p-3.5">
          <View className="flex-1">
            <Text className="text-foreground text-[15px] font-medium">Ambient thinking sound</Text>
            <Text className="text-muted-foreground text-[12.5px] mt-0.5">Soft shimmer while the agent is working.</Text>
          </View>
          <Switch value={v.thinkingSound} onValueChange={v.setThinkingSound} />
        </View>
        {/* Which JS bundle is actually running. Without this there is no way to tell an OTA that
            has not applied yet from one that shipped but changed nothing — that ambiguity cost a
            round trip more than once. */}
        <Text className="px-1 pt-4 text-[11px] text-muted-foreground">
          v{updateInfo().runtime} · update {updateInfo().id.slice(0, 8)}
          {updateInfo().createdAt ? ` · ${updateInfo().createdAt}` : ""}
        </Text>
        {/* No microphone picker: that setting exists on the web because a Mac has several inputs.
            iOS owns audio routing and offers no equivalent choice. */}
      </ScrollView>
    </Sheet>
  );
}

function timeAgo(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// The picker's contents, without the sheet chrome — so the same component can be a modal *and*
// the home screen. With no chat open there is nothing to show but an empty transcript, and an
// empty screen is a worse answer than "here is what you can open".
export function SessionPicker({ projects, sessions, onProject, onSession }: {
  projects: ProjectInfo[]; sessions: SavedSession[];
  onProject: (cwd: string, label: string, engine: string) => void;
  onSession: (s: SavedSession, engine: string) => void;
}) {
  const [engine, setEngine] = useState("claude"); // which coding agent backs a NEW chat
  const MUTED = usePalette().mutedForeground;
  return (
    <>
      <View className="flex-row gap-2 px-5 pb-1">
        {["claude", "codex"].map((e) => <Chip key={e} label={e} on={engine === e} onPress={() => setEngine(e)} />)}
      </View>
      <ScrollView className="px-2" contentContainerClassName="pb-4">
        <SectionLabel>New chat in a project</SectionLabel>
        {projects.length === 0 && <Text className="px-3 py-2 text-[13px] text-muted-foreground">No projects found yet.</Text>}
        {projects.map((p) => (
          <Row
            key={p.cwd}
            icon={<FolderOpen size={17} color={MUTED} />}
            title={p.label}
            subtitle={p.cwd}
            right={<Text className="text-muted-foreground text-[12.5px]">{p.count}</Text>}
            onPress={() => onProject(p.cwd, p.label, engine)}
          />
        ))}

        <SectionLabel>Resume a session</SectionLabel>
        {sessions.length === 0 && <Text className="px-3 py-2 text-[13px] text-muted-foreground">No past sessions.</Text>}
        {sessions.map((s) => (
          <Row
            key={s.id}
            icon={<History size={17} color={MUTED} />}
            title={s.preview}
            subtitle={`${s.label} · ${timeAgo(s.mtime)}`}
            onPress={() => onSession(s, "claude")}
          />
        ))}
      </ScrollView>
    </>
  );
}

export function SessionBrowser({ onClose, ...rest }: {
  projects: ProjectInfo[]; sessions: SavedSession[];
  onProject: (cwd: string, label: string, engine: string) => void;
  onSession: (s: SavedSession, engine: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="Open a chat" onClose={onClose}>
      <SessionPicker {...rest} />
    </Sheet>
  );
}

// Bucket a PR by age, for scroll-orientation headers.
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

export function PRModal({ v, onPick, onClose }: {
  v: any; onPick: (pr: PullRequest) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const MUTED = usePalette().mutedForeground;
  useEffect(() => { v.requestPRs(scope); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const query = q.trim().toLowerCase();
  const filtered: PullRequest[] = query ? v.prs.filter((p: PullRequest) => p.title.toLowerCase().includes(query)) : v.prs;
  let lastBucket = "";
  return (
    <Sheet title="Talk through a PR" onClose={onClose}>
      <View className="flex-row gap-2 px-5 pb-2">
        <Chip label="Mine" on={scope === "mine"} onPress={() => setScope("mine")} />
        <Chip label="All" on={scope === "all"} onPress={() => setScope("all")} />
      </View>
      <View className="px-5 pb-2">
        <View className="flex-row items-center gap-2 rounded-2xl bg-secondary px-3.5 py-2.5">
          <Search size={15} color={MUTED} />
          <TextInput
            value={q} onChangeText={setQ}
            placeholder={scope === "all" ? "Search all PRs…" : "Search your PRs…"}
            placeholderTextColor={MUTED}
            autoCapitalize="none"
            className="flex-1 p-0 text-foreground text-[15px]"
          />
        </View>
      </View>
      <ScrollView className="px-2" contentContainerClassName="pb-4">
        {/* gh can take seconds; the in-flight flag lives in the hook, because an empty list is
            not the same thing as "done". */}
        {v.prsLoading && <View className="py-6"><ActivityIndicator color={MUTED} /></View>}
        {!v.prsLoading && v.prs.length === 0 && (
          <Text className="px-3 py-3 text-[13px] text-muted-foreground">
            No {scope === "all" ? "" : "authored "}PRs found in this repo (needs gh auth + a GitHub remote).
          </Text>
        )}
        {!v.prsLoading && filtered.map((p) => {
          const bucket = prBucket(p.createdAt);
          const header = bucket !== lastBucket ? bucket : null;
          lastBucket = bucket;
          return (
            <View key={p.number}>
              {header && <SectionLabel>{header}</SectionLabel>}
              <Row
                icon={<GitPullRequest size={17} color={MUTED} />}
                title={p.title}
                subtitle={scope === "all" && p.author ? p.author : undefined}
                right={p.isDraft
                  ? <Text className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase text-muted-foreground">draft</Text>
                  : undefined}
                onPress={() => onPick(p)}
              />
            </View>
          );
        })}
      </ScrollView>
    </Sheet>
  );
}
