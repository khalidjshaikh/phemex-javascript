# phemex-ticker — C++ WebSocket Ticker

A C++17 WebSocket client that subscribes to the Phemex **BTCUSD** 24h ticker
channel (`market24h.subscribe`) and prints the last price to stdout on every
change.

## Features

- Connects to `wss://ws.phemex.com`
- Subscribes to the `market24h.subscribe` channel
- Prints the BTCUSD last price when it changes (with timestamp)
- Sends a heartbeat (`server.ping`) every 20s; prints `♥` on pong
- Auto-reconnects on disconnect with exponential backoff (1s → 30s max)
- Graceful shutdown on Ctrl+C / SIGINT

## Prerequisites

- **CMake** ≥ 3.20
- A C++17 compiler (GCC ≥ 8, Clang ≥ 7, Apple Clang ≥ 14, MSVC ≥ 2019)
- **OpenSSL** development headers (for TLS / `wss://`)

  **macOS:** `brew install openssl` (already present on most systems)

  **Ubuntu/Debian:** `sudo apt install libssl-dev`

  **Fedora:** `sudo dnf install openssl-devel`

## Build

```bash
cd cpp-ticker
mkdir build && cd build
cmake ..
make -j$(nproc)
```

CMake will automatically download the two header-only dependencies
(websocketpp and nlohmann/json) via `FetchContent`.

## Usage

```bash
./build/phemex-ticker
```

Sample output:

```
2026-07-12 09:15:03  98452.30 ♥
2026-07-12 09:15:04  98453.10
2026-07-12 09:15:05  98452.30 ♥
```

Press **Ctrl+C** to stop.

## Directory structure

```
cpp-ticker/
├── CMakeLists.txt      # CMake build with FetchContent
├── src/
│   └── main.cpp        # WebSocket client application
└── README.md           # This file
```