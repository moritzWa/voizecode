// Menu bar indicator for live voizecode chats.
//
// The launchd agent (com.voizecode.agent) is RunAtLoad + KeepAlive and calls
// createChat() at module load, so a headless `claude -p` in $HOME exists from
// login onward with no desktop app involved. Its stdin is fed by an open mic,
// so anything the room says can become a prompt. This makes that visible and
// killable.
//
// The icon is present ONLY while at least one chat is live.

import AppKit

// MARK: - shell

@discardableResult
func run(_ path: String, _ args: [String]) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return "" }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(data: data, encoding: .utf8) ?? ""
}

// MARK: - model

struct Chat {
    let pid: Int32
    let cwd: String
    let elapsed: String
    let model: String
    var label: String { (cwd as NSString).lastPathComponent }
}

enum Probe {
    /// pid -> (ppid, command) for every process we can see.
    private static func processTable() -> [Int32: (ppid: Int32, command: String)] {
        var table: [Int32: (Int32, String)] = [:]
        for line in run("/bin/ps", ["-axo", "pid=,ppid=,command="]).split(separator: "\n") {
            let f = line.split(separator: " ", omittingEmptySubsequences: true)
            guard f.count >= 3, let pid = Int32(f[0]), let ppid = Int32(f[1]) else { continue }
            // rebuild the command tail; splitting collapsed its internal spacing, which is
            // fine because we only ever substring-match against it.
            table[pid] = (ppid, f.dropFirst(2).joined(separator: " "))
        }
        return table
    }

    /// The node process running voizecode.mjs (not the caffeinate wrapper, whose
    /// argv also contains the script path).
    static func agentPIDs(_ table: [Int32: (ppid: Int32, command: String)]) -> Set<Int32> {
        Set(table.filter { _, v in
            v.command.contains("voizecode.mjs") && !v.command.contains("caffeinate")
        }.keys)
    }

    static func liveChats() -> [Chat] {
        let table = processTable()
        let agents = agentPIDs(table)
        guard !agents.isEmpty else { return [] }

        let pids = table.filter { _, v in
            agents.contains(v.ppid) && v.command.contains("claude")
        }

        return pids.map { pid, v in
            Chat(pid: pid, cwd: cwd(of: pid), elapsed: elapsed(of: pid), model: model(in: v.command))
        }.sorted { $0.pid < $1.pid }
    }

    private static func cwd(of pid: Int32) -> String {
        for line in run("/usr/sbin/lsof", ["-a", "-p", "\(pid)", "-d", "cwd", "-Fn"]).split(separator: "\n")
        where line.hasPrefix("n") {
            return String(line.dropFirst())
        }
        return "unknown"
    }

    private static func elapsed(of pid: Int32) -> String {
        let raw = run("/bin/ps", ["-o", "etime=", "-p", "\(pid)"]).trimmingCharacters(in: .whitespacesAndNewlines)
        return raw.isEmpty ? "?" : raw
    }

    private static func model(in command: String) -> String {
        let parts = command.split(separator: " ").map(String.init)
        guard let i = parts.firstIndex(of: "--model"), i + 1 < parts.count else { return "?" }
        return parts[i + 1]
    }
}

// MARK: - controller

final class Controller: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem?
    private var timer: Timer?
    private var chats: [Chat] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    private func refresh() {
        chats = Probe.liveChats()
        if chats.isEmpty {
            // no live chat -> no menu bar clutter
            if let item { NSStatusBar.system.removeStatusItem(item) }
            item = nil
            return
        }
        if item == nil {
            item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        }
        guard let item, let button = item.button else { return }

        // isTemplate must stay false: as a template the symbol renders invisibly here
        // (verified). contentTintColor is therefore ignored, so the "this is live and
        // listening" signal comes from the red attributed title rather than the glyph.
        let symbol = NSImage(systemSymbolName: "waveform.circle.fill", accessibilityDescription: "voizecode live")
        symbol?.isTemplate = false
        button.image = symbol
        button.imagePosition = .imageLeading

        let text = chats.count > 1 ? " live \(chats.count)" : " live"
        button.attributedTitle = NSAttributedString(string: text, attributes: [
            .foregroundColor: NSColor.systemRed,
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
        ])
        button.toolTip = "voizecode: \(chats.count) live chat\(chats.count == 1 ? "" : "s") listening on the mic"

        item.menu = buildMenu()
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()

        let header = NSMenuItem(title: "voizecode: \(chats.count) live chat\(chats.count == 1 ? "" : "s")", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        for (i, chat) in chats.enumerated() {
            let title = "\(chat.label) — \(chat.elapsed) — \(chat.model)"
            let parent = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let sub = NSMenu()

            let dir = NSMenuItem(title: chat.cwd, action: nil, keyEquivalent: "")
            dir.isEnabled = false
            sub.addItem(dir)

            let pidItem = NSMenuItem(title: "pid \(chat.pid)", action: nil, keyEquivalent: "")
            pidItem.isEnabled = false
            sub.addItem(pidItem)

            sub.addItem(.separator())

            let kill = NSMenuItem(title: "End this chat", action: #selector(endChat(_:)), keyEquivalent: "")
            kill.target = self
            kill.tag = i
            sub.addItem(kill)

            parent.submenu = sub
            menu.addItem(parent)
        }

        menu.addItem(.separator())

        let killAll = NSMenuItem(title: "End all chats", action: #selector(endAll), keyEquivalent: "")
        killAll.target = self
        menu.addItem(killAll)

        let stopAgent = NSMenuItem(title: "Stop voizecode agent…", action: #selector(stopAgent), keyEquivalent: "")
        stopAgent.target = self
        menu.addItem(stopAgent)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit this menu bar item", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        return menu
    }

    // MARK: actions

    @objc private func endChat(_ sender: NSMenuItem) {
        guard sender.tag < chats.count else { return }
        kill(chats[sender.tag].pid, SIGTERM)
        refresh()
    }

    @objc private func endAll() {
        for chat in chats { kill(chat.pid, SIGTERM) }
        refresh()
    }

    @objc private func stopAgent() {
        let alert = NSAlert()
        alert.messageText = "Stop the voizecode agent?"
        alert.informativeText = "Ends every chat and unloads com.voizecode.agent. It stays off until you start it again (this menu will offer that) or you log in again."
        alert.addButton(withTitle: "Stop it")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let uid = getuid()
        run("/bin/launchctl", ["bootout", "gui/\(uid)/com.voizecode.agent"])
        refresh()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

// MARK: - main

let app = NSApplication.shared
let controller = Controller()
app.delegate = controller
app.setActivationPolicy(.accessory)
app.run()
