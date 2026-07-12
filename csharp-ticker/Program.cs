using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

const string WsUrl = "wss://ws.phemex.com";
const string Symbol = "BTCUSD";
const decimal PriceScale = 10_000m;
const int HeartbeatIntervalMs = 20_000; // 20s
const int InitialReconnectDelayMs = 1_000;
const int MaxReconnectDelayMs = 30_000;

var cts = new CancellationTokenSource();

// Graceful shutdown on Ctrl+C
Console.CancelKeyPress += (_, args) =>
{
    args.Cancel = true;
    Console.WriteLine("\nShutting down...");
    cts.Cancel();
};

decimal? lastPrintedPrice = null;

void LogPriceIfChanged(decimal price)
{
    if (lastPrintedPrice is null || price != lastPrintedPrice)
    {
        var now = DateTime.Now.ToString("MM/dd/yyyy h:mm:ss tt");
        Console.Write($"\n{now}  {price:F2} ");
        lastPrintedPrice = price;
    }
}

async Task ConnectWithRetryAsync()
{
    var reconnectDelay = InitialReconnectDelayMs;

    while (!cts.IsCancellationRequested)
    {
        try
        {
            using var ws = new ClientWebSocket();
            await ws.ConnectAsync(new Uri(WsUrl), cts.Token);
            Console.WriteLine("Connected.");

            reconnectDelay = InitialReconnectDelayMs; // reset backoff

            // Subscribe to 24h ticker channel
            var subscribeMsg = JsonSerializer.Serialize(new
            {
                method = "market24h.subscribe",
                @params = new object[] { },
                id = 2
            });
            await SendAsync(ws, subscribeMsg, cts.Token);

            // Heartbeat task
            using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(cts.Token);
            var heartbeatTask = HeartbeatLoopAsync(ws, heartbeatCts.Token);

            // Receive loop
            await ReceiveLoopAsync(ws, heartbeatCts.Token);

            // If ReceiveLoopAsync completes normally (connection closed), cancel heartbeat
            heartbeatCts.Cancel();
            await heartbeatTask; // ensure it finishes

            Console.WriteLine("Disconnected.");
        }
        catch (OperationCanceledException) when (cts.IsCancellationRequested)
        {
            break;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"\nConnection error: {ex.Message}");
        }

        if (cts.IsCancellationRequested) break;

        // Exponential backoff reconnect
        Console.WriteLine($"Reconnecting in {reconnectDelay / 1000}s...");
        try
        {
            await Task.Delay(reconnectDelay, cts.Token);
        }
        catch (OperationCanceledException)
        {
            break;
        }
        reconnectDelay = Math.Min(reconnectDelay * 2, MaxReconnectDelayMs);
    }
}

async Task HeartbeatLoopAsync(ClientWebSocket ws, CancellationToken token)
{
    while (!token.IsCancellationRequested && ws.State == WebSocketState.Open)
    {
        try
        {
            await Task.Delay(HeartbeatIntervalMs, token);
            if (ws.State != WebSocketState.Open) break;

            var pingMsg = JsonSerializer.Serialize(new
            {
                method = "server.ping",
                @params = new object[] { },
                id = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            });
            await SendAsync(ws, pingMsg, token);
        }
        catch (OperationCanceledException)
        {
            break;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"\nHeartbeat error: {ex.Message}");
            break;
        }
    }
}

async Task ReceiveLoopAsync(ClientWebSocket ws, CancellationToken token)
{
    var buffer = new byte[8192];
    var messageBuffer = new StringBuilder();

    while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
    {
        try
        {
            var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), token);

            if (result.MessageType == WebSocketMessageType.Close)
            {
                Console.WriteLine("Server closed connection.");
                break;
            }

            messageBuffer.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));

            if (result.EndOfMessage)
            {
                var json = messageBuffer.ToString();
                messageBuffer.Clear();
                ProcessMessage(json);
            }
        }
        catch (WebSocketException ex)
        {
            Console.Error.WriteLine($"\nWebSocket receive error: {ex.Message}");
            break;
        }
        catch (OperationCanceledException)
        {
            break;
        }
    }
}

void ProcessMessage(string json)
{
    using var doc = JsonDocument.Parse(json);
    var root = doc.RootElement;

    // Pong — heartbeat response
    if (root.TryGetProperty("result", out var resultProp) &&
        resultProp.ValueKind == JsonValueKind.String &&
        resultProp.GetString() == "pong")
    {
        Console.Write("\u2665"); // ♥
        return;
    }

    // Subscription error
    if (root.TryGetProperty("error", out var errorProp) && errorProp.ValueKind != JsonValueKind.Null)
    {
        Console.Error.WriteLine($"Subscription error: {errorProp}");
        return;
    }

    // Subscription ack — ignore
    if (root.TryGetProperty("result", out var ackResult) &&
        ackResult.ValueKind == JsonValueKind.Object &&
        ackResult.TryGetProperty("status", out var statusProp) &&
        statusProp.GetString() == "success")
    {
        return;
    }

    // 24h ticker channel
    if (root.TryGetProperty("market24h", out var market24h) &&
        market24h.TryGetProperty("symbol", out var symProp) &&
        symProp.GetString() == Symbol &&
        market24h.TryGetProperty("close", out var closeProp))
    {
        var price = closeProp.GetDecimal() / PriceScale;
        LogPriceIfChanged(price);
    }
}

async Task SendAsync(ClientWebSocket ws, string message, CancellationToken token)
{
    var bytes = Encoding.UTF8.GetBytes(message);
    await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, token);
}

await ConnectWithRetryAsync();