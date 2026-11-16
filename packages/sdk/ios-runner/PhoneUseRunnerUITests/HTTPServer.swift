import Foundation
import Network

/// A minimal HTTP/1.1 server for the runner's RPC.
///
/// One request per connection (`connection: close`). Bodies are read to their
/// declared Content-Length, so large requests that arrive in several TCP
/// segments are handled; the previous runner read only the first segment.
final class HTTPServer {
    struct Request {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data
    }

    struct Response {
        var status: Int
        var body: Data
        var contentType = "application/json"
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "dev.phoneuse.runner.http", qos: .userInitiated, attributes: .concurrent)
    private let handler: (Request) -> Response
    private static let maxHeaderBytes = 16 * 1024
    private static let maxBodyBytes = 8 * 1024 * 1024

    init(host: String, port: UInt16, handler: @escaping (Request) -> Response) throws {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NSError(domain: "dev.phoneuse.runner", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid port \(port)"])
        }
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        if host != "0.0.0.0" {
            parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(host), port: nwPort)
            listener = try NWListener(using: parameters)
        } else {
            listener = try NWListener(using: parameters, on: nwPort)
        }
        self.handler = handler
    }

    func start(onState: @escaping (NWListener.State) -> Void) {
        listener.stateUpdateHandler = onState
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            connection.start(queue: self.queue)
            self.read(connection, buffer: Data())
        }
        listener.start(queue: queue)
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] chunk, _, isComplete, error in
            guard let self else { return }
            var data = buffer
            if let chunk { data.append(chunk) }
            if error != nil {
                connection.cancel()
                return
            }
            switch Self.parse(data) {
            case .incomplete:
                if isComplete || data.count > Self.maxHeaderBytes + Self.maxBodyBytes {
                    self.send(connection, Response(status: 400, body: Data(#"{"error":{"code":"BAD_REQUEST","message":"incomplete request"}}"#.utf8)))
                } else {
                    self.read(connection, buffer: data)
                }
            case .invalid(let reason):
                let body = try? JSONSerialization.data(withJSONObject: ["error": ["code": "BAD_REQUEST", "message": reason]])
                self.send(connection, Response(status: 400, body: body ?? Data()))
            case .complete(let request):
                self.send(connection, self.handler(request))
            }
        }
    }

    private enum ParseResult {
        case incomplete
        case invalid(String)
        case complete(Request)
    }

    private static func parse(_ data: Data) -> ParseResult {
        let separator = Data("\r\n\r\n".utf8)
        guard let headerEnd = data.range(of: separator) else {
            return data.count > maxHeaderBytes ? .invalid("headers too large") : .incomplete
        }
        guard let head = String(data: data[data.startIndex..<headerEnd.lowerBound], encoding: .utf8) else {
            return .invalid("headers are not UTF-8")
        }
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return .invalid("malformed request line") }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
        let length = Int(headers["content-length"] ?? "0") ?? -1
        guard length >= 0, length <= maxBodyBytes else { return .invalid("bad content-length") }
        let bodyStart = headerEnd.upperBound
        let available = data.count - (bodyStart - data.startIndex)
        if available < length { return .incomplete }
        let body = data.subdata(in: bodyStart..<(bodyStart + length))
        return .complete(Request(method: String(requestLine[0]), path: String(requestLine[1]), headers: headers, body: body))
    }

    private func send(_ connection: NWConnection, _ response: Response) {
        let reason = response.status == 200 ? "OK" : response.status == 401 ? "Unauthorized" : response.status == 404 ? "Not Found" : "Bad Request"
        var head = "HTTP/1.1 \(response.status) \(reason)\r\n"
        head += "content-type: \(response.contentType)\r\n"
        head += "content-length: \(response.body.count)\r\n"
        head += "connection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + response.body, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
