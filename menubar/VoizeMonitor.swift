// VoizeMonitor — menu bar indicator for live voizecode sessions.
//
// voizecode.mjs spawns headless `claude -p --input-format stream-json` (or codex)
// children and pipes mic transcripts into their stdin. Those sessions are invisible:
// no window, no dock icon, and they run with --dangerously-skip-permissions. This
// puts them in the menu bar so an unnoticed one can be seen and killed.
//
// Detection is by process, not by asking the agent — an agent that has wedged is
// exactly the case where you want to see its children.

import Cocoa

// MARK: - shelling out

func run(_ launchPath: String, _ args: [String]) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: launchPath)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return "" }
    // Read before waiting: a full pipe buffer would deadlock waitUntilExit().
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(data: data, encoding: .utf8) ?? ""
}

// MARK: - model

struct Session {
    let pid: Int32
    let engine: String   // "claude" | "codex"
    let cwd: String
    let elapsed: String  // as reported by ps, e.g. "12:03"

    var project: String {
        let base = (cwd as NSString).lastPathComponent
        return base.isEmpty ? "unknown" : base
    }
}

enum Scan {
    /// pids of running voizecode.mjs agents (the parent that spawns sessions)
    static func agentPIDs(_ table: [(pid: Int32, ppid: Int32, etime: String, cmd: String)]) -> Set<Int32> {
        Set(table.filter { $0.cmd.contains("voizecode.mjs") && !$0.cmd.contains("caffeinate") }.map { $0.pid })
    }

    static func processTable() -> [(pid: Int32, ppid: Int32, etime: String, cmd: String)] {
        let out = run("/bin/ps", ["-eo", "pid=,ppid=,etime=,command="])
        return out.split(separator: "\n").compactMap { line in
            let f = line.split(separator: " ", omittingEmptySubsequences: true)
            guard f.count >= 4, let pid = Int32(f[0]), let ppid = Int32(f[1]) else { return nil }
            let cmd = f[3...].joined(separator: " ")
            return (pid, ppid, String(f[2]), cmd)
        }
    }

    /// A session is a headless stream-json child. Matched two ways so a reparented
    /// orphan (agent died, child didn't) still shows up rather than going silent.
    static func sessions() -> [Session] {
        let table = processTable()
        let agents = agentPIDs(table)

        return table.compactMap { row -> Session? in
            let isHeadless = row.cmd.contains("--input-format stream-json")
            let isAgentChild = agents.contains(row.ppid)
                && (row.cmd.hasPrefix("claude") || row.cmd.contains("/claude")
                    || row.cmd.hasPrefix("codex") || row.cmd.contains("/codex"))
            guard isHeadless || isAgentChild else { return nil }
            guard !row.cmd.contains("voizecode.mjs") else { return nil }

            let engine = row.cmd.contains("codex") ? "codex" : "claude"
            return Session(pid: row.pid, engine: engine, cwd: cwd(of: row.pid), elapsed: row.etime)
        }
    }

    static func cwd(of pid: Int32) -> String {
        let out = run("/usr/sbin/lsof", ["-a", "-p", "\(pid)", "-d", "cwd", "-Fn"])
        for line in out.split(separator: "\n") where line.hasPrefix("n") {
            return String(line.dropFirst())
        }
        return ""
    }
}

// MARK: - app

class AppDelegate: NSObject, NSApplicationDelegate {
    let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var timer: Timer?
    var sessions: [Session] = []

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem.menu = NSMenu()
        statusItem.menu?.delegate = self
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func refresh() {
        sessions = Scan.sessions()
        guard let button = statusItem.button else { return }

        let active = !sessions.isEmpty
        let name = active ? "waveform.circle.fill" : "waveform.circle"
        button.image = NSImage(systemSymbolName: name, accessibilityDescription: "voizecode")
        button.image?.isTemplate = true
        // Count only when there's something live, so the idle state stays quiet.
        button.title = active ? " \(sessions.count)" : ""
        button.toolTip = active
            ? "\(sessions.count) live voizecode session(s) — mic is driving them"
            : "No voizecode sessions"
    }

    func rebuildMenu() {
        guard let menu = statusItem.menu else { return }
        menu.removeAllItems()

        if sessions.isEmpty {
            let item = NSMenuItem(title: "No live sessions", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        } else {
            let header = NSMenuItem(title: "Live sessions (click to kill)", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)

            for (i, s) in sessions.enumerated() {
                let item = NSMenuItem(
                    title: "\(s.project)  ·  \(s.engine) \(s.pid)  ·  \(s.elapsed)",
                    action: #selector(killOne(_:)),
                    keyEquivalent: ""
                )
                item.target = self
                item.tag = i
                item.toolTip = s.cwd
                menu.addItem(item)
            }

            menu.addItem(.separator())
            let all = NSMenuItem(title: "Kill all sessions", action: #selector(killAll), keyEquivalent: "")
            all.target = self
            menu.addItem(all)
        }

        menu.addItem(.separator())

        // Two different clients, and they do NOT talk to the same relay — see openWeb/openElectron.
        let web = NSMenuItem(title: "Open voizecode.com (web)", action: #selector(openWeb), keyEquivalent: "")
        web.target = self
        web.toolTip = "Deployed app on fly.dev — the relay the running agent is actually on"
        menu.addItem(web)

        let electron = NSMenuItem(
            title: "Open Electron app (local dev stack)",
            action: #selector(openElectron), keyEquivalent: ""
        )
        electron.target = self
        electron.toolTip = "Starts localhost relay+client+a second agent. Won't see the deployed agent's sessions."
        menu.addItem(electron)

        menu.addItem(.separator())
        let stopAgent = NSMenuItem(
            title: "Stop voizecode agent (until next login)",
            action: #selector(stopAgent), keyEquivalent: ""
        )
        stopAgent.target = self
        menu.addItem(stopAgent)

        let quit = NSMenuItem(title: "Quit VoizeMonitor", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    /// SIGINT first so the session can flush its transcript, SIGKILL only if it lingers.
    func terminate(_ pid: Int32) {
        kill(pid, SIGINT)
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            if kill(pid, 0) == 0 { kill(pid, SIGKILL) }
            DispatchQueue.main.async { self.refresh() }
        }
    }

    @objc func killOne(_ sender: NSMenuItem) {
        guard sender.tag < sessions.count else { return }
        terminate(sessions[sender.tag].pid)
    }

    @objc func killAll() {
        sessions.forEach { terminate($0.pid) }
    }

    /// The deployed client, keyed with the same token `bin/voize` prints. This is the one
    /// that reaches the LaunchAgent agent, since that agent is pointed at wss://…fly.dev.
    @objc func openWeb() {
        let tokenPath = NSString(string: "~/.voizecode/token").expandingTildeInPath
        let token = (try? String(contentsOfFile: tokenPath, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let base = "https://voizecode-web.fly.dev/"
        let urlStr = token.isEmpty ? base : "\(base)?key=\(token)"
        if let url = URL(string: urlStr) { NSWorkspace.shared.open(url) }
    }

    /// Electron hardcodes localhost (main.js) and its ensureServices() runs `npm run dev`,
    /// which brings up a local relay + client + a SECOND agent. Deliberately separate from
    /// openWeb: launching this does not give you a view of the deployed agent's sessions.
    /// Goes through a login shell because npm comes from fnm, whose PATH is per-shell.
    @objc func openElectron() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // `npm start` (electron .), not the repo's `npm run app` — that runs electronmon,
        // a file-watching dev restarter. The `|| npm install` covers a fresh clone.
        p.arguments = ["-lc", """
            cd ~/Code/voizecode/electron \
              && { [ -x ./node_modules/.bin/electron ] || npm install; } \
              && npm start >/tmp/voizecode-electron.log 2>&1 &
            """]
        try? p.run()
    }

    @objc func stopAgent() {
        // bootout stops it now and keeps it stopped; KeepAlive would otherwise respawn it
        // immediately. It comes back at next login (or `launchctl bootstrap`).
        let uid = getuid()
        _ = run("/bin/launchctl", ["bootout", "gui/\(uid)/com.voizecode.agent"])
        killAll()
        refresh()
    }
}

extension AppDelegate: NSMenuDelegate {
    // Rescan on open so the list is never stale at the moment it's acted on.
    func menuWillOpen(_ menu: NSMenu) {
        sessions = Scan.sessions()
        rebuildMenu()
        refresh()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // menu bar only, no dock icon
app.run()
