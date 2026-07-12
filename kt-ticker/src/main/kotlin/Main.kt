import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.*
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.TimeUnit

/**
 * Phemex WebSocket Price — subscribes to the BTCUSD 24h ticker channel,
 * printing the last price to stdout on each update.
 *
 * Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
 * Sends a heartbeat (server.ping) every 20s and prints the pong to stdout.
 *
 * Usage:  ./gradlew run
 */
class TickerClient {

    companion object {
        private const val WS_URL = "wss://ws.phemex.com"
        private const val SYMBOL = "BTCUSD"
        private const val PRICE_SCALE = 10_000
        private const val HEARTBEAT_INTERVAL_MS = 20_000L
        private const val INITIAL_RECONNECT_DELAY_MS = 1_000L
        private const val MAX_RECONNECT_DELAY_MS = 30_000L
    }

    private val httpClient = HttpClient.newBuilder()
        .build()

    private val timeFormatter = DateTimeFormatter.ofPattern("MM/dd/yyyy, HH:mm:ss")

    @Volatile
    private var shuttingDown = false

    private var ws: WebSocket? = null
    private var lastPrice: Double? = null
    private var reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
    private var heartbeatTimer: Timer? = null
    private var reconnectTimer: Timer? = null

    // ------------------------------------------------------------------
    //  Price output
    // ------------------------------------------------------------------

    @Synchronized
    private fun logPriceIfChanged(price: Double) {
        if (lastPrice == null || price != lastPrice) {
            val now = LocalTime.now().format(timeFormatter)
            print("\n$now  ${String.format("%.2f", price)} ")
            System.out.flush()
            lastPrice = price
        }
    }

    // ------------------------------------------------------------------
    //  Connection
    // ------------------------------------------------------------------

    fun connect() {
        if (shuttingDown) return

        // Cancel any pending reconnect
        reconnectTimer?.cancel()
        reconnectTimer = null

        val listener = object : WebSocket.Listener {

            override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*> {
                if (last) {
                    handleMessage(data.toString())
                }
                return CompletableFuture.completedFuture(null)
            }

            override fun onError(webSocket: WebSocket, error: Throwable) {
                if (!shuttingDown) {
                    System.err.println("\nWebSocket error: ${error.message}")
                    System.err.flush()
                }
            }

            override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*> {
                stopHeartbeat()
                if (!shuttingDown) {
                    scheduleReconnect()
                }
                return CompletableFuture.completedFuture(null)
            }
        }

        try {
            System.err.println("DEBUG: building connection...")
            System.err.flush()
            val webSocket = httpClient.newWebSocketBuilder()
                .buildAsync(URI(WS_URL), listener)
                .get(10, TimeUnit.SECONDS)

            ws = webSocket
            reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS // reset backoff

            System.err.println("DEBUG: connected, sending subscription...")
            System.err.flush()

            // Subscribe to 24h ticker (same as working TS/Go/Python/Ruby versions)
            val sub = JSONObject()
                .put("method", "market24h.subscribe")
                .put("params", JSONArray())
                .put("id", 2)
            val subStr = sub.toString()
            System.err.println("DEBUG: sending: $subStr")
            System.err.flush()
            webSocket.sendText(subStr, true).get(5, TimeUnit.SECONDS)
            System.err.println("DEBUG: subscription sent, waiting for data...")
            System.err.flush()

            // Start heartbeat
            startHeartbeat(webSocket)
        } catch (e: Exception) {
            System.err.println("DEBUG: connection error: ${e.javaClass.name}: ${e.message}")
            System.err.flush()
            if (!shuttingDown) {
                scheduleReconnect()
            }
        }
    }

    // ------------------------------------------------------------------
    //  Message handling
    // ------------------------------------------------------------------

    private fun handleMessage(raw: String) {
        System.err.println("DEBUG RECV: $raw")
        System.err.flush()
        try {
            val msg = JSONObject(raw)

            // Pong — heartbeat response
            if (msg.opt("result") == "pong") {
                print("♥")
                System.out.flush()
                return
            }

            // Subscription error
            if (!msg.isNull("error")) {
                System.err.println("Subscription error: ${msg.get("error")}")
                return
            }

            // Ignore subscription ack
            val result = msg.optJSONObject("result")
            if (result != null && result.optString("status") == "success") {
                return
            }

            // 24h ticker channel — updates every ~1s
            val market24h = msg.optJSONObject("market24h")
            if (market24h != null && market24h.optString("symbol") == SYMBOL) {
                val closeEp = market24h.optLong("close", -1L)
                if (closeEp > 0) {
                    logPriceIfChanged(closeEp.toDouble() / PRICE_SCALE)
                }
            }
        } catch (e: Exception) {
            System.err.println("Parse error: ${e.message}")
        }
    }

    // ------------------------------------------------------------------
    //  Heartbeat
    // ------------------------------------------------------------------

    private fun startHeartbeat(ws: WebSocket) {
        stopHeartbeat()
        val timer = Timer("heartbeat", true)
        heartbeatTimer = timer
        timer.schedule(object : TimerTask() {
            override fun run() {
                if (shuttingDown) return
                val ping = JSONObject()
                    .put("method", "server.ping")
                    .put("params", JSONArray())
                    .put("id", System.currentTimeMillis())
                try {
                    ws.sendText(ping.toString(), true).get(5, TimeUnit.SECONDS)
                } catch (e: Exception) {
                    System.err.println("Heartbeat send error: ${e.message}")
                }
            }
        }, HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS)
    }

    private fun stopHeartbeat() {
        heartbeatTimer?.cancel()
        heartbeatTimer = null
    }

    // ------------------------------------------------------------------
    //  Reconnect
    // ------------------------------------------------------------------

    @Synchronized
    private fun scheduleReconnect() {
        if (shuttingDown || reconnectTimer != null) return

        val delay = reconnectDelayMs
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(MAX_RECONNECT_DELAY_MS)

        System.err.println("\nReconnecting in ${delay / 1000}s...")
        System.err.flush()
        val timer = Timer("reconnect", false)
        reconnectTimer = timer
        timer.schedule(object : TimerTask() {
            override fun run() {
                reconnectTimer = null
                connect()
            }
        }, delay)
    }

    // ------------------------------------------------------------------
    //  Shutdown
    // ------------------------------------------------------------------

    fun shutdown() {
        shuttingDown = true
        reconnectTimer?.cancel()
        reconnectTimer = null
        stopHeartbeat()
        ws?.sendClose(1000, "Client shutdown")
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fun main() {
    val client = TickerClient()

    // Graceful shutdown on Ctrl+C
    Runtime.getRuntime().addShutdownHook(Thread {
        print("\nShutting down...")
        System.out.flush()
        client.shutdown()
        println(" done")
    })

    client.connect()

    // Keep the main thread alive
    @Suppress("InfiniteLoopStatement")
    while (true) {
        Thread.sleep(10_000)
    }
}