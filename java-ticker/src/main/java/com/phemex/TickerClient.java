package com.phemex;

import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.Date;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;

/**
 * Phemex WebSocket Price — subscribes to the BTCUSD 24h ticker channel,
 * printing the last price to stdout on each update.
 *
 * Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
 * Sends a heartbeat (server.ping) every 20s and prints the pong to stdout.
 *
 * Usage:  ./gradlew run
 */
public class TickerClient {

    private static final String WS_URL = "wss://ws.phemex.com";
    private static final String SYMBOL = "BTCUSD";
    private static final long PRICE_SCALE = 10_000L;
    private static final long HEARTBEAT_INTERVAL_MS = 20_000L;
    private static final long INITIAL_RECONNECT_DELAY_MS = 1_000L;
    private static final long MAX_RECONNECT_DELAY_MS = 30_000L;

    private final HttpClient httpClient = HttpClient.newHttpClient();

    private volatile boolean shuttingDown = false;

    private WebSocket ws;
    private Double lastPrice;
    private long reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    private Timer heartbeatTimer;
    private Timer reconnectTimer;

    // ------------------------------------------------------------------
    //  Price output
    // ------------------------------------------------------------------

    private synchronized void logPriceIfChanged(double price) {
        if (lastPrice == null || price != lastPrice) {
            String now = Date.from(java.time.Instant.now()).toLocaleString();
            System.out.printf("%n%s  %.2f ", now, price);
            System.out.flush();
            lastPrice = price;
        }
    }

    // ------------------------------------------------------------------
    //  Connection
    // ------------------------------------------------------------------

    public void connect() {
        if (shuttingDown) return;

        // Cancel any pending reconnect
        if (reconnectTimer != null) {
            reconnectTimer.cancel();
            reconnectTimer = null;
        }

        WebSocket.Listener listener = new WebSocket.Listener() {

            @Override
            public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                if (last) {
                    handleMessage(data.toString());
                }
                webSocket.request(1);
                return CompletableFuture.completedFuture(null);
            }

            @Override
            public void onError(WebSocket webSocket, Throwable error) {
                if (!shuttingDown) {
                    System.err.printf("%nWebSocket error: %s%n", error.getMessage());
                    System.err.flush();
                }
            }

            @Override
            public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
                stopHeartbeat();
                if (!shuttingDown) {
                    scheduleReconnect();
                }
                return CompletableFuture.completedFuture(null);
            }
        };

        try {
            WebSocket webSocket = httpClient.newWebSocketBuilder()
                    .buildAsync(URI.create(WS_URL), listener)
                    .get(10, TimeUnit.SECONDS);

            ws = webSocket;
            reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS; // reset backoff

            // Subscribe to 24h ticker
            JSONObject sub = new JSONObject()
                    .put("method", "market24h.subscribe")
                    .put("params", new JSONArray())
                    .put("id", 2);
            webSocket.sendText(sub.toString(), true);

            // Start heartbeat
            startHeartbeat(webSocket);
        } catch (Exception e) {
            if (!shuttingDown) {
                System.err.printf("Connection failed: %s%n", e.getMessage());
                System.err.flush();
                scheduleReconnect();
            }
        }
    }

    // ------------------------------------------------------------------
    //  Message handling
    // ------------------------------------------------------------------

    private void handleMessage(String raw) {
        try {
            JSONObject msg = new JSONObject(raw);

            // Pong — heartbeat response
            if ("pong".equals(msg.opt("result"))) {
                System.out.print("\u2665");
                System.out.flush();
                return;
            }

            // Subscription error
            if (!msg.isNull("error")) {
                System.err.println("Subscription error: " + msg.get("error"));
                return;
            }

            // Ignore subscription ack
            JSONObject result = msg.optJSONObject("result");
            if (result != null && "success".equals(result.optString("status"))) {
                return;
            }

            // Tick channel — real-time trade price
            JSONObject tick = msg.optJSONObject("tick");
            if (tick != null) {
                long lastEp = tick.optLong("last", -1L);
                if (lastEp > 0) {
                    logPriceIfChanged((double) lastEp / PRICE_SCALE);
                }
                return;
            }

            // 24h ticker channel — updates every ~1s
            JSONObject market24h = msg.optJSONObject("market24h");
            if (market24h != null && SYMBOL.equals(market24h.optString("symbol"))) {
                long closeEp = market24h.optLong("close", -1L);
                if (closeEp > 0) {
                    logPriceIfChanged((double) closeEp / PRICE_SCALE);
                }
            }
        } catch (Exception e) {
            System.err.println("Parse error: " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------
    //  Heartbeat
    // ------------------------------------------------------------------

    private void startHeartbeat(WebSocket ws) {
        stopHeartbeat();
        Timer timer = new Timer("heartbeat", true);
        heartbeatTimer = timer;
        timer.schedule(new TimerTask() {
            @Override
            public void run() {
                if (shuttingDown) return;
                JSONObject ping = new JSONObject()
                        .put("method", "server.ping")
                        .put("params", new JSONArray())
                        .put("id", System.currentTimeMillis());
                ws.sendText(ping.toString(), true);
            }
        }, HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS);
    }

    private void stopHeartbeat() {
        if (heartbeatTimer != null) {
            heartbeatTimer.cancel();
            heartbeatTimer = null;
        }
    }

    // ------------------------------------------------------------------
    //  Reconnect
    // ------------------------------------------------------------------

    private synchronized void scheduleReconnect() {
        if (shuttingDown || reconnectTimer != null) return;

        long delay = reconnectDelayMs;
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);

        Timer timer = new Timer("reconnect", false);
        reconnectTimer = timer;
        timer.schedule(new TimerTask() {
            @Override
            public void run() {
                reconnectTimer = null;
                connect();
            }
        }, delay);
    }

    // ------------------------------------------------------------------
    //  Shutdown
    // ------------------------------------------------------------------

    public void shutdown() {
        shuttingDown = true;
        if (reconnectTimer != null) {
            reconnectTimer.cancel();
            reconnectTimer = null;
        }
        stopHeartbeat();
        if (ws != null) {
            ws.sendClose(1000, "Client shutdown");
        }
    }

    // -------------------------------------------------------------------
    //  Main entry point
    // -------------------------------------------------------------------

    public static void main(String[] args) {
        TickerClient client = new TickerClient();

        // Graceful shutdown on Ctrl+C
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.print("\nShutting down...");
            System.out.flush();
            client.shutdown();
            System.out.println(" done");
        }));

        client.connect();

        // Keep the main thread alive
        while (true) {
            try {
                Thread.sleep(10_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }
}