import Foundation
import XCTest

/// The phone-use runner: an XCTest UI test that never finishes and serves the
/// device verbs over HTTP.
///
/// An XCTest runner is the one kind of process iOS lets drive other apps, so
/// this is what the host (or, on a real phone, a relay) talks to. Settings come
/// from the environment, which the host sets per launch:
///
/// - `PHONE_USE_RUNNER_PORT`  (default 45678)
/// - `PHONE_USE_RUNNER_BIND`  (default 127.0.0.1; `0.0.0.0` to accept LAN clients)
/// - `PHONE_USE_RUNNER_TOKEN` (when set, every RPC needs `Authorization: Bearer <token>`)
final class PhoneUseRunner: XCTestCase {
    private var server: HTTPServer?
    private var engine: Engine?

    override func setUp() {
        super.setUp()
        // A failed gesture must never end the serving session.
        continueAfterFailure = true
    }

    /// XCTest reports UI failures (an element that cannot be tapped, focus that
    /// never arrived) as test issues, not Swift errors. Capture them so the
    /// verb that caused them fails with that message instead of succeeding.
    override func record(_ issue: XCTIssue) {
        let text = issue.compactDescription
        MainActor.assumeIsolated {
            if let engine, engine.pendingIssue == nil { engine.pendingIssue = text }
        }
        NSLog("[phone-use] XCTest issue: %@", text)
    }

    @MainActor
    func testServe() throws {
        let env = ProcessInfo.processInfo.environment
        let port = UInt16(env["PHONE_USE_RUNNER_PORT"] ?? "") ?? 45678
        let host = env["PHONE_USE_RUNNER_BIND"] ?? "127.0.0.1"
        let token = env["PHONE_USE_RUNNER_TOKEN"].flatMap { $0.isEmpty ? nil : $0 }
        let engine = Engine()
        self.engine = engine

        let server = try HTTPServer(host: host, port: port) { request in
            Self.respond(to: request, engine: engine, token: token)
        }
        self.server = server
        server.start { state in
            switch state {
            case .ready: NSLog("[phone-use] runner ready on %@:%d", host, Int(port))
            case .failed(let error): NSLog("[phone-use] runner listener failed: %@", "\(error)")
            default: break
            }
        }
        // Park the test: the automation session lives as long as this run loop.
        while true {
            RunLoop.current.run(mode: .default, before: .distantFuture)
        }
    }

    // MARK: - request handling (HTTP queue)

    private static func respond(to request: HTTPServer.Request, engine: Engine, token: String?) -> HTTPServer.Response {
        if request.method == "GET", request.path == "/health" {
            return json(200, ["ok": true, "protocol": 2])
        }
        if let token {
            let presented = request.headers["authorization"] ?? ""
            guard constantTimeEquals(presented, "Bearer \(token)") else {
                return json(401, ["error": ["code": "UNAUTHORIZED", "message": "missing or wrong runner token"]])
            }
        }
        guard request.method == "POST", request.path == "/" || request.path == "/rpc" else {
            return json(404, ["error": ["code": "NOT_FOUND", "message": "POST /rpc"]])
        }
        guard let envelope = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any],
              let method = envelope["method"] as? String else {
            return json(400, ["error": ["code": "BAD_REQUEST", "message": "body must be {method, params}"]])
        }
        let params = envelope["params"] as? [String: Any] ?? [:]
        let id = envelope["id"] ?? NSNull()
        let timeoutMs = (params["timeoutMs"] as? Double ?? 0) + 30_000
        let started = Date()

        var outcome: Result<Any, RunnerError>?
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                outcome = run(method: method, params: params, engine: engine)
            }
            done.signal()
        }
        guard done.wait(timeout: .now() + .milliseconds(Int(timeoutMs))) == .success else {
            return json(200, ["id": id, "error": ["code": "TIMEOUT", "message": "\(method) did not finish within \(Int(timeoutMs))ms",
                                                   "hint": "the app may be busy animating; later calls queue behind this one"]])
        }
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        switch outcome! {
        case .success(let result):
            return json(200, ["id": id, "result": result, "ms": ms])
        case .failure(let error):
            var body: [String: Any] = ["code": error.code, "message": error.message]
            if let hint = error.hint { body["hint"] = hint }
            return json(200, ["id": id, "error": body, "ms": ms])
        }
    }

    @MainActor
    private static func run(method: String, params: [String: Any], engine: Engine) -> Result<Any, RunnerError> {
        engine.pendingIssue = nil
        var result: Any?
        var thrown: Error?
        var exception: NSError?
        let ok = PURunCatching({
            do { result = try engine.handle(method: method, params: params) } catch { thrown = error }
        }, &exception)
        if !ok {
            return .failure(.actionFailed(exception?.localizedDescription ?? "XCTest raised an exception",
                                          hint: "the element may have disappeared mid-gesture; take a new snapshot"))
        }
        if let error = thrown as? RunnerError { return .failure(error) }
        if let error = thrown { return .failure(.actionFailed("\(error)")) }
        if let issue = engine.pendingIssue {
            engine.pendingIssue = nil
            return .failure(.actionFailed(issue))
        }
        return .success(result ?? ["ok": true])
    }

    private static func json(_ status: Int, _ object: [String: Any]) -> HTTPServer.Response {
        // JSONSerialization raises an Objective-C exception (not a Swift error)
        // on NaN or infinity, which would end the serving test. Check first.
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else {
            return HTTPServer.Response(status: status, body: Data(#"{"error":{"code":"ENCODE","message":"the reply contained a non-finite number"}}"#.utf8))
        }
        return HTTPServer.Response(status: status, body: data)
    }

    private static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<x.count { diff |= x[i] ^ y[i] }
        return diff == 0
    }
}
