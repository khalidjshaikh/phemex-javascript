import Foundation
import Dispatch

// MARK: - Constants

let wsURL = URL(string: "wss://ws.phemex.com")!
let symbol = "BTCUSD"
let priceScale: Double = 10_000
let heartbeatInterval: TimeInterval = 20.0 // seconds

let maxReconnectDelay: TimeInterval = 30.0
var reconnectDelay: TimeInterval = 1.0
var reconnectTimer: DispatchSourceTimer? = nil

var webSocketTask: URLSessionWebSocketTask? = nil
var heartbeatTimer: DispatchSourceTimer? = nil
var lastPrintedPrice: Double? = nil

let session = URLSession(configuration: .default)
let queue = DispatchQueue(label: "phemex.ws", qos: .utility)
let mainQueue = DispatchQueue.main

// MARK: - Helpers

func logPriceIfChanged(_ price: Double) {
    if lastPrintedPrice == nil || price != lastPrintedPrice {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let now = formatter.string(from: Date())
        print("\(now)  \(String(format: "%.2f", price))")
        fflush(stdout)
        lastPrintedPrice = price
    }
}

func stopHeartbeat() {
    heartbeatTimer?.cancel()
    heartbeatTimer = nil
}

func startHeartbeat() {
    stopHeartbeat()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + heartbeatInterval, repeating: heartbeatInterval)
    timer.setEventHandler { [weak timer] in
        guard let task = webSocketTask, task.state == .running else {
            timer?.cancel()
            return
        }
        let ping: [String: Any] = [
            "method": "server.ping",
            "params": [],
            "id": Int(Date().timeIntervalSince1970 * 1000)
        ]
        if let data = try? JSONSerialization.data(withJSONObject: ping) {
            task.send(.data(data)) { _ in }
        }
    }
    timer.resume()
    heartbeatTimer = timer
}

func scheduleReconnect() {
    reconnectTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + reconnectDelay)
    timer.setEventHandler { connect() }
    timer.resume()
    reconnectTimer = timer
    reconnectDelay = min(reconnectDelay * 2, maxReconnectDelay)
}

// MARK: - Message handling

func handleMessage(_ text: String) {
    guard let data = text.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return
    }

    // Pong — heartbeat response
    if let result = json["result"] as? String, result == "pong" {
        print("♥", terminator: "")
        fflush(stdout)
        return
    }

    // Subscription error (skip when value is NSNull)
    if let err = json["error"], !(err is NSNull) {
        print("Subscription error: \(err)")
        return
    }

    // Subscription ack
    if let result = json["result"] as? [String: Any],
       let status = result["status"] as? String, status == "success" {
        return
    }

    // 24h ticker channel
    if let market24h = json["market24h"] as? [String: Any],
       let sym = market24h["symbol"] as? String, sym == symbol,
       let lastEp = market24h["close"] as? Int64 {
        let price = Double(lastEp) / priceScale
        logPriceIfChanged(price)
    }
}

// MARK: - WebSocket connection

func connect() {
    reconnectTimer?.cancel()
    reconnectTimer = nil
    reconnectDelay = 1.0

    let request = URLRequest(url: wsURL)
    let task = session.webSocketTask(with: request)
    webSocketTask = task

    task.resume()

    // Subscribe on open
    let subscribe: [String: Any] = [
        "method": "market24h.subscribe",
        "params": [],
        "id": 2
    ]
    if let data = try? JSONSerialization.data(withJSONObject: subscribe) {
        task.send(.data(data)) { error in
            if let error = error {
                print("Subscribe send error: \(error)")
            }
        }
    }

    // Start heartbeat
    startHeartbeat()

    // Start receiving messages
    receiveMessage(task)

    // Monitor for disconnect
    queue.asyncAfter(deadline: .now() + 0.5) { [weak task] in
        if task?.state == .canceling || task?.state == .completed {
            stopHeartbeat()
            scheduleReconnect()
        }
    }
}

func receiveMessage(_ task: URLSessionWebSocketTask) {
    task.receive { [weak task] result in
        switch result {
        case .success(let message):
            switch message {
            case .string(let text):
                handleMessage(text)
            case .data(let data):
                if let text = String(data: data, encoding: .utf8) {
                    handleMessage(text)
                }
            @unknown default:
                break
            }
            // Continue receiving
            if let task = task {
                receiveMessage(task)
            }
        case .failure(let error):
            print("Receive error: \(error)")
            stopHeartbeat()
            scheduleReconnect()
        }
    }
}

// MARK: - Graceful shutdown

func shutdown() {
    reconnectTimer?.cancel()
    reconnectTimer = nil
    stopHeartbeat()
    webSocketTask?.cancel(with: .normalClosure, reason: nil)
    exit(0)
}

signal(SIGINT) { _ in
    shutdown()
}

// MARK: - Start

connect()

// Keep the main thread alive
dispatchMain()