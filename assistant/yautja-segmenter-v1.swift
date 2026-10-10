// Revision 1. Local Vision person masks for Yautja's live low-detail heat field.
import Foundation
import Vision
import CoreGraphics
import CoreVideo

let input = FileHandle.standardInput
let output = FileHandle.standardOutput
let width = 320, height = 192
let request = VNGeneratePersonSegmentationRequest()
request.qualityLevel = .balanced
request.outputPixelFormat = kCVPixelFormatType_OneComponent8

func readFrame(_ size: Int) throws -> Data? {
    var bytes = Data()
    while bytes.count < size {
        guard let part = try input.read(upToCount: size - bytes.count), !part.isEmpty else { return nil }
        bytes.append(part)
    }
    return bytes
}

do {
    while let bytes = try readFrame(width * height * 3) {
        try autoreleasepool {
            guard let provider = CGDataProvider(data: bytes as CFData),
                  let image = CGImage(width: width, height: height, bitsPerComponent: 8,
                    bitsPerPixel: 24, bytesPerRow: width * 3, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
                throw NSError(domain: "Yautja", code: 1)
            }
            try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
            guard let mask = request.results?.first?.pixelBuffer else { throw NSError(domain: "Yautja", code: 2) }
            CVPixelBufferLockBaseAddress(mask, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
            let w = CVPixelBufferGetWidth(mask), h = CVPixelBufferGetHeight(mask)
            let stride = CVPixelBufferGetBytesPerRow(mask)
            guard let base = CVPixelBufferGetBaseAddress(mask) else { throw NSError(domain: "Yautja", code: 3) }
            var dimensions = [UInt32(w).bigEndian, UInt32(h).bigEndian]
            var packet = dimensions.withUnsafeMutableBytes { Data($0) }
            for row in 0..<h { packet.append(base.advanced(by: row * stride).assumingMemoryBound(to: UInt8.self), count: w) }
            try output.write(contentsOf: packet)
        }
    }
} catch {
    FileHandle.standardError.write(Data("Local person segmentation failed: \(error.localizedDescription)\n".utf8))
    exit(1)
}
