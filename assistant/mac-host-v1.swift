// Revision 2. Keep user-requested voice capture responsive while the app is in the background.
import AppKit
import AVFoundation
import Foundation

if CommandLine.arguments.contains("--permission-status") {
    print(AVCaptureDevice.authorizationStatus(for: .audio) == .authorized ? "authorized" : "not-authorized")
    exit(0)
}

final class KittHostDelegate: NSObject, NSApplicationDelegate {
    private var host: Process?
    private var termination: DispatchSourceSignal?
    private var voiceActivity: NSObjectProtocol?
    private var stopping = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGTERM, SIG_IGN)
        termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination?.setEventHandler { [weak self] in self?.stop() }
        termination?.resume()
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: startHost(allowed: true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { allowed in
                DispatchQueue.main.async { self.startHost(allowed: allowed) }
            }
        default: startHost(allowed: false)
        }
    }

    private func startHost(allowed: Bool) {
        if CommandLine.arguments.contains("--authorize-only") { NSApp.terminate(nil); return }
        guard !stopping,
              let node = Bundle.main.object(forInfoDictionaryKey: "KittNodeExecutable") as? String,
              let root = Bundle.main.object(forInfoDictionaryKey: "KittProjectDirectory") as? String else {
            exit(1)
        }
        let process = Process()
        voiceActivity = ProcessInfo.processInfo.beginActivity(
            options: .userInitiatedAllowingIdleSystemSleep,
            reason: "Listen for computer and respond to Car Thing voice requests"
        )
        process.qualityOfService = .userInitiated
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [root + "/assistant/kitt-server-v1.mjs"]
        process.currentDirectoryURL = URL(fileURLWithPath: root)
        var environment = ProcessInfo.processInfo.environment
        environment["KITT_MAC_MIC_ALLOWED"] = allowed ? "1" : "0"
        process.environment = environment
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.standardError
        process.terminationHandler = { process in
            DispatchQueue.main.async { exit(process.terminationStatus) }
        }
        do { try process.run(); host = process }
        catch { fputs("The KITT host could not start.\n", stderr); exit(1) }
    }

    private func stop() {
        if stopping { return }
        stopping = true
        if let voiceActivity {
            ProcessInfo.processInfo.endActivity(voiceActivity)
            self.voiceActivity = nil
        }
        guard let host, host.isRunning else { exit(0) }
        host.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
            if host.isRunning { kill(host.processIdentifier, SIGKILL) }
            exit(0)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if host?.isRunning == true { stop(); return .terminateCancel }
        return .terminateNow
    }
}

let app = NSApplication.shared
let delegate = KittHostDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
