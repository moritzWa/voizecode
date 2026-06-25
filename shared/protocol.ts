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
  | { t: "hello"; role: "client"; since?: number } // since = last seq seen (replay)
  | { t: "audio"; sessionId: string; pcm: string } // base64 16kHz mono PCM16 mic chunk
  | { t: "barge_in"; sessionId: string }           // user started talking over the agent
  | { t: "text"; sessionId: string; text: string } // typed input fallback
  | { t: "set_narration"; mode: NarrationMode }
  | { t: "set_model"; sessionId: string; model: ClaudeModel }
  | { t: "set_voice"; voice: string }               // TTS voice (global)
  | { t: "reset"; sessionId: string }               // clear UI + fresh claude context (same tab)
  // create a chat: in cwd (new) and/or resuming a past Claude Code session. sessionId routes to the agent.
  | { t: "new_session"; sessionId: string; cwd?: string; resumeId?: string; label?: string }
  | { t: "close_session"; sessionId: string }       // close a chat (kills its claude subprocess)
  | { t: "list_sessions"; sessionId: string }       // ask the agent for past sessions + projects
  | { t: "ping" };                                  // heartbeat; relay replies { t: "pong" }

// ---- agent (laptop) -> relay ----
export type AgentToRelay =
  | { t: "hello"; role: "agent"; sessionId: string; label: string }
  | { t: "init"; sessionId: string; model: string; label?: string }
  | { t: "delta"; text: string }                   // claude assistant text delta
  | { t: "tool_use"; name: string; summary: string; speak: boolean } // tool call started; speak=worth voicing
  | { t: "turn_end"; fullText: string }            // assistant turn finished; fullText = whole reply
  | { t: "exit"; code: number }
  | { t: "meta"; claudeSessionId: string; cwd: string }                      // claude session uuid + cwd (debug)
  | { t: "sessions_list"; sessions: SavedSession[]; projects: ProjectInfo[] } // past sessions + project dirs
  | { t: "history"; sessionId: string; messages: HistoryMsg[] }              // resumed transcript for the viewer
  | { t: "ping" };                                  // heartbeat; relay replies { t: "pong" }

export interface SpokenWord { text: string; start: number } // start = media-time seconds
export interface SavedSession { id: string; cwd: string; label: string; preview: string; mtime: number }
export interface HistoryMsg { role: "user" | "assistant"; text: string }
export interface ProjectInfo { cwd: string; label: string; count: number; mtime: number }

// ---- relay -> client ---- (all carry sessionId)
export type RelayToClient =
  | { t: "transcript"; sessionId: string; text: string; final: boolean } // live STT
  | { t: "user_echo"; sessionId: string; text: string; seq: number }     // committed user turn
  | { t: "status"; sessionId: string; text: string; seq: number }        // progress ("editing auth.ts")
  | { t: "speech_text"; sessionId: string; text: string; seq: number; clip: number } // text being spoken (clip = its audio id)
  | { t: "words"; sessionId: string; clip: number; words: SpokenWord[]; seq: number } // per-word start times (ElevenLabs) for highlight
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
  | { t: "history"; sessionId: string; messages: HistoryMsg[] }          // resumed transcript for the viewer
  | { t: "meta"; sessionId: string; claudeSessionId: string; cwd: string }   // claude session uuid + cwd (debug)
  | { t: "pong" };                                                       // heartbeat reply

export interface SessionInfo { sessionId: string; label: string; model: string }

// ---- relay -> agent (laptop) ----
export type RelayToAgent =
  | { t: "user_message"; text: string } // deliver a (spoken or typed) user turn to claude
  | { t: "interrupt" }                  // stop claude mid-turn
  | { t: "set_model"; model: ClaudeModel }
  | { t: "reset" }                      // respawn claude = fresh context
  | { t: "new_chat"; cwd?: string; resumeId?: string; label?: string } // spawn a chat (in cwd, maybe resuming)
  | { t: "close" }                      // kill this chat (claude + socket)
  | { t: "list_sessions" }              // scan + return past sessions/projects
  | { t: "pong" };                      // heartbeat reply

export type NarrationMode = "narrate" | "final-only" | "silent";
export type ClaudeModel = "haiku" | "sonnet" | "opus";

export interface AudioFormat {
  encoding: "pcm_s16le" | "mp3";
  sampleRate: number; // e.g. 24000
}

export const RELAY_PORT = 8787;
