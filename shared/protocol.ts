// voizecode WebSocket message protocol — shared by relay, laptop CLI, and client.
//
// Two kinds of peers connect to the relay:
//   - "agent"  = the laptop CLI (voizecode) wrapping a live `claude` session
//   - "client" = the browser / phone (mic in, audio + text out)
//
// The relay is a dumb-ish hub: it routes text between client<->agent, runs
// STT (client audio -> text), narration (claude events -> short spoken text),
// and TTS (spoken text -> audio), and buffers agent output with seq numbers so
// a reconnecting client can catch up.

export type Role = "agent" | "client";

// All session-scoped messages carry sessionId (the repo name). The client talks
// to multiple sessions over one socket; each agent socket is bound to one session.

// ---- client -> relay ----
export type ClientToRelay =
  | { t: "hello"; role: "client"; since?: number; token?: string } // since = last seq seen (replay); token = access code (when relay auth is on)
  | { t: "audio"; sessionId: string; pcm: string } // base64 16kHz mono PCM16 mic chunk
  | { t: "barge_in"; sessionId: string }           // user started talking over the agent
  | { t: "text"; sessionId: string; text: string } // typed input fallback
  | { t: "set_narration"; mode: NarrationMode }
  | { t: "set_model"; sessionId: string; model: ClaudeModel }
  | { t: "set_voice"; voice: string }               // TTS voice (global)
  | { t: "reset"; sessionId: string }               // clear UI + fresh claude context (same tab)
  // create a chat: in cwd (new) and/or resuming a past Claude Code session. sessionId routes to the agent.
  | { t: "new_session"; sessionId: string; cwd?: string; resumeId?: string; label?: string; engine?: string }
  | { t: "close_session"; sessionId: string }       // close a chat (kills its claude subprocess)
  | { t: "list_sessions"; sessionId: string }       // ask the agent for past sessions + projects
  | { t: "list_prs"; sessionId: string; scope?: "mine" | "all" } // ask the agent for the chat repo's PRs (yours, or all)
  | { t: "get_clip"; key: string }                  // replay a persisted clip: fetch its stored audio + words
  // Read existing transcript text aloud. For turns that were never narrated (a resumed session's
  // history, or a raw reply), so there is no stored clip to replay — the relay synthesizes fresh.
  | { t: "speak"; sessionId: string; texts: string[] }
  // hold/dictation mode: on = accumulate (no auto-commit); off = flush the buffer as one turn,
  // or drop it entirely when discard is set (changed your mind mid-ramble).
  | { t: "ramble"; sessionId: string; on: boolean; discard?: boolean }
  | { t: "fork"; sessionId: string; userIndex: number; text: string } // fork in place: truncate this chat's context before the userIndex-th user turn, delete the old thread, continue with `text` (Claude only)
  | { t: "ping" };                                  // heartbeat; relay replies { t: "pong" }

// Bring-your-own-keys. A self-hosted or open-source user puts their own provider keys on their
// laptop (~/.voizecode/keys.json) and the agent hands them to the relay at hello, so the relay
// never stores anyone's credentials — they live in the session object for as long as the socket
// does and vanish with it. Sending *any* key marks the session BYOK: the relay's own env keys are
// then not used at all for that session, so a half-filled config bills the user, never the host.
export interface ProviderKeys {
  deepgram?: string;    // STT, and TTS when no ElevenLabs key is present
  openai?: string;      // narration (gpt-4.1-nano) + fallback TTS
  elevenlabs?: string;  // TTS with per-word timestamps (drives the reading highlight)
  elVoice?: string;     // default ElevenLabs voice id
  elModel?: string;     // default ElevenLabs model id
  ttsVoice?: string;    // default Deepgram Aura voice
}

// ---- agent (laptop) -> relay ----
export type AgentToRelay =
  | { t: "hello"; role: "agent"; sessionId: string; label: string; token?: string; keys?: ProviderKeys } // token = this laptop's access code (relay adopts it as the required token); keys = BYOK, see below
  | { t: "init"; sessionId: string; model: string; label?: string; engine?: string }
  | { t: "delta"; text: string }                   // claude assistant text delta
  | { t: "tool_use"; name: string; summary: string; speak: boolean } // tool call started; speak=worth voicing
  | { t: "turn_end"; fullText: string }            // assistant turn finished; fullText = whole reply
  | { t: "exit"; code: number }
  | { t: "meta"; claudeSessionId: string; cwd: string }                      // claude session uuid + cwd (debug)
  | { t: "sessions_list"; sessions: SavedSession[]; projects: ProjectInfo[] } // past sessions + project dirs
  | { t: "prs"; prs: PullRequest[] }                                         // authored PRs in the chat's repo
  | { t: "history"; sessionId: string; messages: HistoryMsg[] }              // resumed transcript for the viewer
  | { t: "ping" };                                  // heartbeat; relay replies { t: "pong" }

export interface SpokenWord { text: string; start: number } // start = media-time seconds
export interface SavedSession { id: string; cwd: string; label: string; preview: string; mtime: number }
export interface HistoryMsg { role: "user" | "assistant"; text: string }
export interface ProjectInfo { cwd: string; label: string; count: number; mtime: number }
export interface PullRequest { number: number; title: string; url: string; createdAt: string; isDraft: boolean; author?: string }

// ---- relay -> client ---- (all carry sessionId)
export type RelayToClient =
  | { t: "transcript"; sessionId: string; text: string; final: boolean } // live STT
  | { t: "user_echo"; sessionId: string; text: string; seq: number }     // committed user turn
  | { t: "status"; sessionId: string; text: string; seq: number }        // progress ("editing auth.ts")
  // text being spoken (clip = its audio id; key = persisted-clip handle for replay).
  // readback = this is existing transcript text being read on request, so the client attaches the
  // clip to the line it already has instead of appending a new one.
  | { t: "speech_text"; sessionId: string; text: string; seq: number; clip: number; key?: string; readback?: boolean }
  | { t: "words"; sessionId: string; clip: number; words: SpokenWord[]; seq: number } // per-word start times (ElevenLabs) for highlight
  | { t: "clip_audio"; key: string; b64: string; words: SpokenWord[]; format: AudioFormat } // replay payload for a persisted clip
  | { t: "utterance_discarded"; sessionId: string }                      // a backchannel/noise was ignored -> resume audio
  // Audio streams as ordered mp3 byte chunks grouped by `clip` (one spoken utterance),
  // so the client can append to a MediaSource and start playing before synthesis finishes.
  | { t: "audio_chunk"; sessionId: string; clip: number; b64: string; seq: number; format: AudioFormat }
  | { t: "audio_end"; sessionId: string; clip: number; seq: number }
  | { t: "agent_text"; sessionId: string; text: string; seq: number }    // claude reply for display
  | { t: "stop_audio"; sessionId: string }                               // barge-in: flush playback
  | { t: "thinking"; sessionId: string; on: boolean }                    // agent busy indicator
  | { t: "model"; sessionId: string; model: string }                     // current claude model
  | { t: "sessions"; sessions: SessionInfo[] }                           // active session list (tabs)
  | { t: "sessions_list"; sessions: SavedSession[]; projects: ProjectInfo[] } // past sessions + projects (browser)
  | { t: "prs"; prs: PullRequest[] }                                     // authored PRs (PR-context modal)
  | { t: "history"; sessionId: string; messages: HistoryMsg[] }          // resumed transcript for the viewer
  | { t: "meta"; sessionId: string; claudeSessionId: string; cwd: string }   // claude session uuid + cwd (debug)
  | { t: "unauthorized" }                                                // access code missing/wrong; socket will close
  | { t: "pong" };                                                       // heartbeat reply

export interface SessionInfo { sessionId: string; label: string; model: string }

// ---- relay -> agent (laptop) ----
export type RelayToAgent =
  | { t: "user_message"; text: string } // deliver a (spoken or typed) user turn to claude
  | { t: "interrupt" }                  // stop claude mid-turn
  | { t: "set_model"; model: ClaudeModel }
  | { t: "reset" }                      // respawn claude = fresh context
  | { t: "new_chat"; cwd?: string; resumeId?: string; label?: string; engine?: string } // spawn a chat (cwd, resume, engine)
  | { t: "fork"; userIndex: number; text: string } // fork this chat in place at a turn boundary, continue with `text`
  | { t: "close" }                      // kill this chat (claude + socket)
  | { t: "list_sessions" }              // scan + return past sessions/projects
  | { t: "list_prs"; scope?: "mine" | "all" } // list the repo's PRs (yours, or all)
  | { t: "pong" };                      // heartbeat reply

export type NarrationMode = "narrate" | "final-only" | "silent";
export type ClaudeModel = "haiku" | "sonnet" | "opus";

export interface AudioFormat {
  encoding: "pcm_s16le" | "mp3";
  sampleRate: number; // e.g. 24000
}

export const RELAY_PORT = 8787;
