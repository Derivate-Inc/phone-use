// Framebuffer access and copy pattern adapted from SimUtil SimStream.swift
// (c) 2026 dungngminh, MIT; and Evan Bacon's serve-sim, Apache-2.0.
// See THIRD_PARTY_NOTICES.md. Modified: standalone headless H.264 encoder,
// bounded synchronous submission, 30fps capture, framed Annex-B stdout.
import Foundation
import CoreVideo
import CoreMedia
import IOSurface
import VideoToolbox

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1)
}
@objc protocol DisplayDescriptor {
    @objc(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:)
    func registerScreenCallbacks(uuid: UUID, callbackQueue: DispatchQueue,
        frameCallback: @convention(block) @escaping () -> Void,
        surfacesChangedCallback: @convention(block) @escaping () -> Void,
        propertiesChangedCallback: @convention(block) @escaping () -> Void)
}
let args = CommandLine.arguments
if args.count != 2 { fail("usage: phone-video <simulator-udid>") }
let dev: String = {
    if let value = ProcessInfo.processInfo.environment["DEVELOPER_DIR"] { return value }
    let p = Process(); let pipe = Pipe()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select"); p.arguments = ["-p"]; p.standardOutput = pipe
    try? p.run(); p.waitUntilExit()
    return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines)
}()
for path in ["/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", "\(dev)/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", "\(dev)/../SharedFrameworks/SimulatorKit.framework/SimulatorKit", "\(dev)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"] { _ = dlopen(path, RTLD_NOW) }
guard let cls = NSClassFromString("SimServiceContext") as? NSObject.Type,
    let context = cls.perform(NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"), with: dev, with: nil)?.takeUnretainedValue() as? NSObject,
    let set = context.perform(NSSelectorFromString("defaultDeviceSetWithError:"), with: nil)?.takeUnretainedValue() as? NSObject,
    let devices = set.value(forKey: "devices") as? [NSObject],
    let device = devices.first(where: { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == args[1] }),
    let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject
else { fail("Cannot access simulator framebuffer; check Xcode and device UDID") }
// A launchd worker inherits background scheduling; keep capture timers responsive.
let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical], reason: "Live simulator video")
let queue = DispatchQueue(label: "phone-video.capture", qos: .userInteractive)
io.perform(NSSelectorFromString("updateIOPorts"))
let ports = io.value(forKey: "deviceIOPorts") as? [NSObject] ?? []
var descriptors: [NSObject] = []
for port in ports {
    guard let id = port.perform(NSSelectorFromString("portIdentifier"))?.takeUnretainedValue(), "\(id)" == "com.apple.framebuffer.display",
        let desc = port.perform(NSSelectorFromString("descriptor"))?.takeUnretainedValue() as? NSObject,
        desc.responds(to: NSSelectorFromString("framebufferSurface")),
        desc.responds(to: #selector(DisplayDescriptor.registerScreenCallbacks)) else { continue }
    unsafeBitCast(desc, to: DisplayDescriptor.self).registerScreenCallbacks(uuid: UUID(), callbackQueue: queue, frameCallback: {}, surfacesChangedCallback: {}, propertiesChangedCallback: {})
    descriptors.append(desc)
}
if descriptors.isEmpty { fail("Simulator has no framebuffer descriptors") }
var expected = CGSize.zero
if let type = device.value(forKey: "deviceType") as? NSObject {
    let sel = NSSelectorFromString("mainScreenSize")
    if type.responds(to: sel) {
        typealias SizeFunc = @convention(c) (AnyObject, Selector) -> CGSize
        expected = unsafeBitCast(type.method(for: sel), to: SizeFunc.self)(type, sel)
    }
}
var session: VTCompressionSession?
var pool: CVPixelBufferPool?
var dimensions = (0, 0)
var frame: Int64 = 0
let start = DispatchTime.now().uptimeNanoseconds
// Strict deadlines avoid ~100ms timer coalescing in launchd daemon context.
let timer = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
timer.schedule(deadline: .now(), repeating: .milliseconds(33), leeway: .milliseconds(1))
timer.setEventHandler {
    autoreleasepool {
        let surfaces: [IOSurface] = descriptors.compactMap { desc in
            guard let value = desc.perform(NSSelectorFromString("framebufferSurface"))?.takeUnretainedValue() else { return nil }
            let surface = unsafeBitCast(value, to: IOSurface.self)
            return IOSurfaceGetWidth(surface) > 0 ? surface : nil
        }
        let surface = surfaces.first { s in
            let w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s)
            return (w == Int(expected.width) && h == Int(expected.height)) || (h == Int(expected.width) && w == Int(expected.height))
        } ?? surfaces.max { IOSurfaceGetWidth($0) * IOSurfaceGetHeight($0) < IOSurfaceGetWidth($1) * IOSurfaceGetHeight($1) }
        guard let surface else { return }
        let w = IOSurfaceGetWidth(surface), h = IOSurfaceGetHeight(surface)
        if dimensions != (w, h) {
            if let session { VTCompressionSessionInvalidate(session) }
            session = nil; pool = nil; dimensions = (w, h); frame = 0
            let spec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary
            let result = VTCompressionSessionCreate(allocator: kCFAllocatorDefault, width: Int32(w), height: Int32(h), codecType: kCMVideoCodecType_H264, encoderSpecification: spec, imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &session)
            guard result == noErr, let session else { fail("VideoToolbox session failed: \(result)") }
            for (key, value): (CFString, Any) in [
                (kVTCompressionPropertyKey_RealTime, true),
                (kVTCompressionPropertyKey_AllowFrameReordering, false),
                (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Baseline_AutoLevel),
                (kVTCompressionPropertyKey_AverageBitRate, 6_000_000),
                (kVTCompressionPropertyKey_ExpectedFrameRate, 30),
                (kVTCompressionPropertyKey_MaxKeyFrameInterval, 30)
            ] { VTSessionSetProperty(session, key: key, value: value as CFTypeRef) }
            VTCompressionSessionPrepareToEncodeFrames(session)
            let attrs: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h, kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
            CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
        }
        var wrapped: Unmanaged<CVPixelBuffer>?
        guard CVPixelBufferCreateWithIOSurface(nil, surface, nil, &wrapped) == kCVReturnSuccess, let source = wrapped?.takeRetainedValue(), let pool, let session else { return }
        var copy: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &copy) == kCVReturnSuccess, let copy else { return }
        CVPixelBufferLockBaseAddress(source, .readOnly); CVPixelBufferLockBaseAddress(copy, [])
        if let src = CVPixelBufferGetBaseAddress(source), let dst = CVPixelBufferGetBaseAddress(copy) {
            let ss = CVPixelBufferGetBytesPerRow(source), ds = CVPixelBufferGetBytesPerRow(copy)
            for row in 0..<h { memcpy(dst + row * ds, src + row * ss, min(ss, ds)) }
        }
        CVPixelBufferUnlockBaseAddress(copy, []); CVPixelBufferUnlockBaseAddress(source, .readOnly)
        frame += 1
        let pts = Int64((DispatchTime.now().uptimeNanoseconds - start) / 1000)
        let done = DispatchSemaphore(value: 0)
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: copy, presentationTimeStamp: CMTime(value: pts, timescale: 1_000_000), duration: CMTime(value: 1, timescale: 30), frameProperties: nil, infoFlagsOut: nil) { status, flags, sample in
            defer { done.signal() }
            guard status == noErr, let sample, !flags.contains(.frameDropped), let format = CMSampleBufferGetFormatDescription(sample), let block = CMSampleBufferGetDataBuffer(sample) else { return }
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]]
            let key = attachments?.first?[kCMSampleAttachmentKey_NotSync as String] == nil
            var payload = Data([key ? 1 : 2])
            var timestamp = UInt64(pts).bigEndian
            withUnsafeBytes(of: &timestamp) { payload.append(contentsOf: $0) }
            let marker = Data([0, 0, 0, 1])
            if key {
                for index in 0..<2 {
                    var ptr: UnsafePointer<UInt8>?; var size = 0
                    if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &ptr, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let ptr { payload.append(marker); payload.append(ptr, count: size) }
                }
            }
            var size = 0; var ptr: UnsafeMutablePointer<Int8>?
            guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &size, dataPointerOut: &ptr) == noErr, let ptr else { return }
            let data = Data(bytes: ptr, count: size)
            var offset = 0
            while offset + 4 <= size {
                let length = data[offset..<offset+4].reduce(0) { ($0 << 8) | Int($1) }; offset += 4
                guard length > 0, offset + length <= size else { return }
                payload.append(marker); payload.append(data[offset..<offset+length]); offset += length
            }
            var length = UInt32(payload.count).bigEndian
            var packet = Data(); withUnsafeBytes(of: &length) { packet.append(contentsOf: $0) }; packet.append(payload)
            FileHandle.standardOutput.write(packet)
        }
        if status != noErr { fail("VideoToolbox encode failed: \(status)") }
        if done.wait(timeout: .now() + 5) == .timedOut { fail("Video encoder stalled") }
    }
}
timer.resume()
dispatchMain()
