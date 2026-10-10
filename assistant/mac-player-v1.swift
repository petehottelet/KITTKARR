// Revision 1. Report the audible PCM clock, including the selected output's presentation latency.
import Foundation
import AVFoundation

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}
do {
    guard CommandLine.arguments.count == 3 else { throw NSError(domain: "KITT", code: 1) }
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: CommandLine.arguments[1]))
    let engine = AVAudioEngine(), player = AVAudioPlayerNode()
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)
    player.volume = max(0, min(1, Float(CommandLine.arguments[2]) ?? 0.7))
    var finished = false
    player.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { _ in
        DispatchQueue.main.async { finished = true }
    }
    engine.prepare()
    try engine.start()
    player.play()
    let duration = Double(file.length) / file.processingFormat.sampleRate
    let deadline = Date().addingTimeInterval(duration + 15)
    while !finished && Date() < deadline {
        if let render = player.lastRenderTime, render.isHostTimeValid,
           let position = player.playerTime(forNodeTime: render) {
            let sinceRender = AVAudioTime.seconds(forHostTime: mach_absolute_time()) - AVAudioTime.seconds(forHostTime: render.hostTime)
            let latency = max(0, player.outputPresentationLatency)
            let audible = Double(position.sampleTime) / position.sampleRate + sinceRender - latency
            emit(["positionMs": audible * 1000, "at": Date().timeIntervalSince1970 * 1000,
                  "outputLatencyMs": latency * 1000, "durationMs": duration * 1000])
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.08))
    }
    player.stop()
    engine.stop()
    if !finished { throw NSError(domain: "KITT playback timeout", code: 2) }
} catch {
    fputs("KITT audio playback failed.\n", stderr)
    exit(1)
}
