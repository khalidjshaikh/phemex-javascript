/**
 * phemex-ticker — C++ WebSocket client for the Phemex BTCUSD 24h ticker.
 *
 * Subscribes to the market24h channel, prints the last price to stdout on
 * each change.  Auto-reconnects on disconnect with exponential backoff
 * (1s → 30s max).  Sends a heartbeat (server.ping) every 20s and prints
 * a heart symbol (♥) on pong.
 *
 * Build:  mkdir build && cd build && cmake .. && make
 * Usage:  ./phemex-ticker
 */

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <functional>
#include <iomanip>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>

#include <boost/asio/connect.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/ssl/context.hpp>
#include <boost/asio/ssl/stream.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/ssl.hpp>
#include <boost/beast/websocket.hpp>
#include <nlohmann/json.hpp>

// OpenSSL (for setting SNI hostname)
#include <openssl/ssl.h>

namespace beast = boost::beast;
namespace http  = beast::http;
namespace websocket = beast::websocket;
namespace net   = boost::asio;
namespace ssl   = net::ssl;
using tcp       = net::ip::tcp;
using json      = nlohmann::json;

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

constexpr auto WS_HOST     = "ws.phemex.com";
constexpr auto WS_PORT     = "443";
constexpr auto SYMBOL      = "BTCUSD";
constexpr int64_t PRICE_SCALE = 10'000;

constexpr auto HEARTBEAT_INTERVAL     = std::chrono::seconds(20);
constexpr auto INITIAL_RECONNECT_DELAY = std::chrono::milliseconds(1'000);
constexpr auto MAX_RECONNECT_DELAY    = std::chrono::milliseconds(30'000);

/* ------------------------------------------------------------------ */
/*  Global state                                                       */
/* ------------------------------------------------------------------ */

static std::atomic<bool> g_running{true};
static std::mutex        g_price_mtx;
static double            g_last_price        = 0;
static bool              g_price_initialized = false;

/* ------------------------------------------------------------------ */
/*  Signal handler (Ctrl+C)                                            */
/* ------------------------------------------------------------------ */

extern "C" void signal_handler(int /*sig*/) { g_running = false; }

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

static std::string timestamp() {
  auto now = std::chrono::system_clock::now();
  auto t   = std::chrono::system_clock::to_time_t(now);
  std::tm bt{};
  localtime_r(&t, &bt);
  std::ostringstream os;
  os << std::put_time(&bt, "%Y-%m-%d %H:%M:%S");
  return os.str();
}

static void log_price_if_changed(double price) {
  std::lock_guard<std::mutex> lock(g_price_mtx);
  if (!g_price_initialized || price != g_last_price) {
    std::cout << "\n" << timestamp() << "  " << std::fixed
              << std::setprecision(2) << price << " " << std::flush;
    g_last_price        = price;
    g_price_initialized = true;
  }
}

/* ------------------------------------------------------------------ */
/*  Reconnectable WebSocket client (synchronous, TLS)                  */
/* ------------------------------------------------------------------ */

using WsStream = websocket::stream<ssl::stream<tcp::socket>>;

struct WsClient {
  std::unique_ptr<WsStream> ws;
  ssl::context              ctx{ssl::context::tls};

  std::atomic<bool>         connected{false};

  WsClient() {
    ctx.set_options(ssl::context::default_workarounds |
                    ssl::context::no_sslv2 | ssl::context::no_sslv3 |
                    ssl::context::single_dh_use);
    ctx.load_verify_file("/etc/ssl/cert.pem");
    // Temporarily disable verification to debug handshake
    ctx.set_verify_mode(ssl::verify_none);
  }

  ~WsClient() { disconnect(); }

  bool connect() {
    disconnect();
    try {
      net::io_context ioc;

      tcp::resolver resolver(ioc);
      auto const results = resolver.resolve(WS_HOST, WS_PORT);

      // Create TCP socket and connect
      tcp::socket socket(ioc);
      net::connect(socket, results.begin(), results.end());

      // Wrap in SSL stream
      ssl::stream<tcp::socket> ssl_sock(std::move(socket), ctx);

      // Set SNI hostname (required by many CDN-terminated hosts)
      SSL_set_tlsext_host_name(ssl_sock.native_handle(), WS_HOST);

      // SSL handshake
      ssl_sock.handshake(ssl::stream_base::client);

      // Wrap in WebSocket stream
      WsStream ws_stream(std::move(ssl_sock));
      ws_stream.handshake(WS_HOST, "/");

      ws = std::make_unique<WsStream>(std::move(ws_stream));
      connected = true;
      return true;
    } catch (std::exception const &e) {
      std::cerr << "\n[connect] " << e.what() << std::endl;
      connected = false;
      return false;
    }
  }

  void disconnect() {
    connected = false;
    if (ws) {
      beast::error_code ec;
      ws->close(websocket::close_code::normal, ec);
      ws.reset();
    }
  }

  bool send(std::string const &data) {
    if (!connected || !ws) return false;
    try {
      ws->write(net::buffer(data));
      return true;
    } catch (std::exception const &e) {
      std::cerr << "\n[send] " << e.what() << std::endl;
      connected = false;
      return false;
    }
  }

  /** Read one message.  Returns empty string on error/disconnect. */
  std::string read() {
    if (!connected || !ws) return {};
    beast::flat_buffer buffer;
    try {
      ws->read(buffer);
      return beast::buffers_to_string(buffer.data());
    } catch (std::exception const &e) {
      std::cerr << "\n[read] " << e.what() << std::endl;
      connected = false;
      return {};
    }
  }
};

/* ------------------------------------------------------------------ */
/*  Message handling                                                    */
/* ------------------------------------------------------------------ */

static void handle_message(std::string const &raw) {
  json j;
  try {
    j = json::parse(raw);
  } catch (...) {
    return;
  }

  // Pong — heartbeat response
  if (j.contains("result") && j["result"].is_string() &&
      j["result"] == "pong") {
    std::cout << "♥" << std::flush;
    return;
  }

  // Error
  if (!j.is_null() && j.contains("error") && !j["error"].is_null()) {
    return;
  }

  // Subscription ack
  if (j.contains("result") && j["result"].is_object() &&
      j["result"].value("status", "") == "success") {
    return;
  }

  // 24h ticker channel
  if (j.contains("market24h") && j["market24h"].is_object() &&
      j["market24h"].value("symbol", "") == SYMBOL) {
    auto const &m = j["market24h"];
    if (m.contains("close") && m["close"].is_number()) {
      int64_t close_ep = m["close"].get<int64_t>();
      double price     = static_cast<double>(close_ep) / PRICE_SCALE;
      log_price_if_changed(price);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

int main() {
  std::signal(SIGINT, signal_handler);
  std::signal(SIGTERM, signal_handler);

  WsClient client;
  auto reconnect_delay = INITIAL_RECONNECT_DELAY;

  auto do_connect = [&]() -> bool {
    if (!client.connect()) return false;
    reconnect_delay = INITIAL_RECONNECT_DELAY;

    // Subscribe
    json sub;
    sub["method"] = "market24h.subscribe";
    sub["params"] = json::array();
    sub["id"]     = 2;
    client.send(sub.dump());
    return true;
  };

  // Initial connection
  if (!do_connect()) {
    // Will retry in the loop below
  }

  auto last_heartbeat = std::chrono::steady_clock::now();

  // Read loop in background thread
  std::thread reader([&]() {
    while (g_running) {
      if (!client.connected) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        continue;
      }
      auto msg = client.read();
      if (msg.empty()) continue; // disconnected — handled via connected flag
      handle_message(msg);
    }
  });

  // Main loop: heartbeat + reconnection
  while (g_running) {
    auto now = std::chrono::steady_clock::now();

    // Heartbeat
    if (client.connected &&
        (now - last_heartbeat) >= HEARTBEAT_INTERVAL) {
      json ping;
      ping["method"] = "server.ping";
      ping["params"] = json::array();
      ping["id"]     = std::chrono::system_clock::to_time_t(
                          std::chrono::system_clock::now()) *
                      1000;
      client.send(ping.dump());
      last_heartbeat = now;
    }

    // Reconnect
    if (!client.connected && g_running) {
      std::cerr << "\n[reconnect] waiting " << reconnect_delay.count() / 1000
                << "s..." << std::endl;
      auto deadline = std::chrono::steady_clock::now() + reconnect_delay;
      while (std::chrono::steady_clock::now() < deadline && g_running) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
      }
      if (!g_running) break;
      reconnect_delay = std::min(reconnect_delay * 2, MAX_RECONNECT_DELAY);
      do_connect();
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }

  // Shutdown
  std::cout << "\n[shutdown] cleaning up..." << std::endl;
  client.disconnect();
  if (reader.joinable()) reader.join();
  std::cout << "[shutdown] done." << std::endl;
  return 0;
}