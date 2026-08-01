use std::time::Duration;

use chrono::Local;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::watch;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const WS_URL: &str = "wss://ws.phemex.com";
const SYMBOL: &str = "BTCUSD";
const PRICE_SCALE: f64 = 10_000.0;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);

#[tokio::main]
async fn main() {
    // Install the ring-based crypto provider for rustls (avoids ambiguity
    // when both ring and aws-lc-rs are compiled in)
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    // Install Ctrl+C handler
    tokio::spawn(async move {
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to install signal handler");
        println!("\nShutting down...");
        let _ = shutdown_tx.send(true);
    });

    let mut reconnect_delay = INITIAL_RECONNECT_DELAY;

    while !*shutdown_rx.borrow() {
        match run_session(&mut shutdown_rx).await {
            SessionOutcome::Shutdown => break,
            SessionOutcome::Disconnected => {
                let delay = reconnect_delay;
                reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_DELAY);

                if *shutdown_rx.borrow() {
                    break;
                }
                eprintln!(
                    "Disconnected. Reconnecting in {}s...",
                    delay.as_secs()
                );

                // Wait for either the reconnect delay or a shutdown signal
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = shutdown_rx.changed() => break,
                }
            }
        }
    }
}

enum SessionOutcome {
    Shutdown,
    Disconnected,
}

/// Run one WebSocket session — connect, subscribe, read messages, heartbeat.
async fn run_session(shutdown_rx: &mut watch::Receiver<bool>) -> SessionOutcome {
    eprintln!("Connecting to Phemex...");

    let ws_stream = match connect_async(WS_URL).await {
        Ok((stream, _)) => stream,
        Err(e) => {
            eprintln!("Connection failed: {e}");
            return SessionOutcome::Disconnected;
        }
    };

    let (mut write, mut read) = ws_stream.split();

    // Subscribe to 24h ticker
    let sub = serde_json::json!({"method": "market24h.subscribe", "params": [], "id": 2});
    if write
        .send(Message::Text(sub.to_string().into()))
        .await
        .is_err()
    {
        return SessionOutcome::Disconnected;
    }

    eprintln!("Connected. Subscribed to market24h.");

    // Heartbeat interval — skip the first immediate tick
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.tick().await;

    let mut last_price: Option<f64> = None;

    loop {
        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_message(&text, &mut last_price);
                    }
                    Some(Ok(Message::Ping(data))) => {
                        // Respond to server-initiated ping
                        let _ = write.send(Message::Pong(data)).await;
                    }
                    Some(Ok(_)) => {
                        // Binary, pong, etc — ignore
                    }
                    Some(Err(e)) => {
                        eprintln!("WebSocket error: {e}");
                        return SessionOutcome::Disconnected;
                    }
                    None => {
                        // Stream ended
                        return SessionOutcome::Disconnected;
                    }
                }
            }
            _ = heartbeat.tick() => {
                // Send application-level heartbeat
                let ping = serde_json::json!({"method": "server.ping", "params": [], "id": 0});
                if write.send(Message::Text(ping.to_string().into())).await.is_err() {
                    return SessionOutcome::Disconnected;
                }
            }
            _ = shutdown_rx.changed() => {
                return SessionOutcome::Shutdown;
            }
        }
    }
}

/// Parse and handle an incoming JSON message from Phemex.
fn handle_message(text: &str, last_price: &mut Option<f64>) {
    let msg: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    // Pong — heartbeat response
    if msg.get("result").and_then(|r| r.as_str()) == Some("pong") {
        print!("♥");
        let _ = std::io::Write::flush(&mut std::io::stdout());
        return;
    }

    // Error
    if let Some(err) = msg.get("error") {
        if !err.is_null() {
            eprintln!("Subscription error: {err}");
            return;
        }
    }

    // Ignore subscription acknowledgement
    if msg["result"]["status"].as_str() == Some("success") {
        return;
    }

    // 24h ticker channel — updates every ~1s
    if let Some(market24h) = msg.get("market24h") {
        if market24h["symbol"].as_str() == Some(SYMBOL) {
            if let Some(close_ep) = market24h["close"].as_i64() {
                let price = close_ep as f64 / PRICE_SCALE;
                let changed = match last_price {
                    None => true,
                    Some(lp) => (price - *lp).abs() > f64::EPSILON,
                };
                if changed {
                    let now = Local::now().format("%Y-%m-%d %H:%M:%S");
                    print!("\n{}  {:.2} ", now, price);
                    let _ = std::io::Write::flush(&mut std::io::stdout());
                    *last_price = Some(price);
                }
            }
        }
    }
}