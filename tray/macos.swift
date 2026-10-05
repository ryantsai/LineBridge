import AppKit
import Foundation

final class Tray: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!
    let host = Process(), input = Pipe(), output = Pipe()
    var pending = Data()
    var ending = false
    let smoke = CommandLine.arguments.contains("--smoke-test")
    let smokeStop = CommandLine.arguments.contains("--smoke-stop")
    let status = NSMenuItem(title: "Starting LineBridge...", action: nil, keyEquivalent: "")
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Executable is bundle/LineBridge.app/Contents/MacOS/LineBridge.
        let root = Bundle.main.bundleURL.deletingLastPathComponent()
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "LB"
        item.button?.toolTip = "LineBridge"
        item.isVisible = !smoke
        let menu = NSMenu(); menu.autoenablesItems = false; status.isEnabled = false; menu.addItem(status)
        for (title, action) in [("Open LineBridge", #selector(open)), ("Quit tray (keep service running)", #selector(quit)), ("Stop service and quit", #selector(stop))] {
            let entry = NSMenuItem(title: title, action: action, keyEquivalent: ""); entry.target = self; menu.addItem(entry)
        }
        item.menu = menu
        host.executableURL = root.appendingPathComponent("runtime/node")
        host.arguments = [root.appendingPathComponent("app/server/tray.mjs").path] + CommandLine.arguments.dropFirst().filter { $0 != "--smoke-test" && $0 != "--smoke-stop" }
        host.currentDirectoryURL = root; host.standardInput = input; host.standardOutput = output
        host.standardError = FileHandle.nullDevice
        output.fileHandleForReading.readabilityHandler = { handle in
            let bytes = handle.availableData
            DispatchQueue.main.async {
                if bytes.isEmpty {
                    if !self.ending { self.error("Tray controller exited. The service may still be running; use linebridge status."); self.finish() }
                    return
                }
                self.pending.append(bytes)
                while let end = self.pending.firstIndex(of: 10) {
                    let line = String(decoding: self.pending[..<end], as: UTF8.self)
                    self.pending.removeSubrange(...end); self.receive(line)
                }
            }
        }
        do { try host.run() } catch { self.error(error.localizedDescription); finish() }
    }
    func send(_ action: String) { do { try input.fileHandleForWriting.write(contentsOf: Data((action + "\n").utf8)) } catch { self.error(error.localizedDescription) } }
    @objc func open() { send("open") }
    @objc func quit() { send("quit") }
    @objc func stop() { send("stop") }
    func error(_ text: String) {
        if smoke { print("error\t" + text); return }
        let alert = NSAlert(); alert.messageText = "LineBridge"; alert.informativeText = text; alert.runModal()
    }
    func receive(_ line: String) {
        if smoke { print(line) }
        let parts = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
        let value = parts.count > 1 ? String(parts[1]) : ""
        switch parts[0] {
        case "ready": status.title = "LineBridge running"; open()
        case "state": status.title = value
        case "error": error(value)
        case "quit": finish()
        case "open":
            guard let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1", let port = url.port, port > 1024, port < 65536, url.user == nil, url.password == nil, (url.path == "" || url.path == "/"), url.query == nil, url.fragment == nil else { error("Invalid local dashboard URL."); return }
            if smoke { if smokeStop { stop() } else { quit() } } else if !NSWorkspace.shared.open(url) { error("Open your browser and paste " + value + " into the address bar.") }
        default: break
        }
    }
    func finish() { ending = true; try? input.fileHandleForWriting.close(); output.fileHandleForReading.readabilityHandler = nil; NSApplication.shared.terminate(nil) }
}
let app = NSApplication.shared
let delegate = Tray()
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
