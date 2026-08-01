#!/usr/bin/env php
<?php
/**
 * Phemex WebSocket BTCUSD Ticker — PHP version
 *
 * Connects to Phemex WebSocket API, subscribes to the BTCUSD 24h ticker
 * channel, and prints the last price to stdout on each update.
 *
 * Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
 * Sends a heartbeat (server.ping) every 20s and prints ♥ on pong.
 *
 * Usage:  php ticker.php
 */

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use WebSocket\Client;
use WebSocket\TimeoutException;

// ─── Config ────────────────────────────────────────────────────────────────

const WS_URL       = 'wss://ws.phemex.com';
const SYMBOL       = 'BTCUSD';
const PRICE_SCALE  = 10_000;
const HEARTBEAT_INTERVAL = 20; // seconds
const RECEIVE_TIMEOUT = 5;    // seconds
const RECONNECT_DELAY_INITIAL = 1;  // seconds
const RECONNECT_DELAY_MAX     = 30; // seconds

// ─── State ─────────────────────────────────────────────────────────────────

/** @var float|null */
$lastPrintedPrice = null;

/** @var bool */
$shutdown = false;

// ─── Helpers ───────────────────────────────────────────────────────────────

function logPriceIfChanged(float $price): void
{
    global $lastPrintedPrice;
    if ($lastPrintedPrice === null || abs($price - $lastPrintedPrice) > 1e-9) {
        $now = (new DateTimeImmutable())->format('Y-m-d H:i:s');
        fprintf(STDOUT, "\n%s  %s ", $now, number_format($price, 2, '.', ''));
        $lastPrintedPrice = $price;
    }
}

function processMessage(string $text): void
{
    $msg = json_decode($text);
    if (json_last_error() !== JSON_ERROR_NONE) {
        return;
    }

    // Pong — heartbeat response
    if (isset($msg->result) && $msg->result === 'pong') {
        fprintf(STDOUT, "\u{2665}"); // ♥
        return;
    }

    if (isset($msg->error) && $msg->error !== null) {
        fprintf(STDERR, "\nSubscription error: %s\n", json_encode($msg->error));
        return;
    }

    // Ignore subscription ack
    if (isset($msg->result->status) && $msg->result->status === 'success') {
        return;
    }

    // Tick channel — real-time trade price
    if (isset($msg->tick)) {
        $lastEp = $msg->tick->last ?? 0;
        logPriceIfChanged($lastEp / PRICE_SCALE);
        return;
    }

    // 24h ticker channel — updates every ~1s
    if (isset($msg->market24h) && $msg->market24h->symbol === SYMBOL) {
        $closeEp = $msg->market24h->close ?? 0;
        logPriceIfChanged($closeEp / PRICE_SCALE);
    }
}

// ─── Signal Handling ───────────────────────────────────────────────────────

if (extension_loaded('pcntl') && function_exists('pcntl_signal')) {
    pcntl_signal(SIGINT, function () {
        global $shutdown;
        $shutdown = true;
    });
    if (function_exists('pcntl_async_signals')) {
        pcntl_async_signals(true);
    }
} else {
    fprintf(STDERR, "Warning: pcntl extension not available — Ctrl+C won't work cleanly.\n");
}

// ─── Main Loop ─────────────────────────────────────────────────────────────

$reconnectDelay = RECONNECT_DELAY_INITIAL;

while (!$shutdown) {
    try {
        fprintf(STDOUT, "\nConnecting to %s ...\n", WS_URL);
        $client = new Client(WS_URL, [
            'timeout'    => RECEIVE_TIMEOUT,
            'return_obj' => true,  // get Message objects so we control getContent()
        ]);
        $reconnectDelay = RECONNECT_DELAY_INITIAL;

        // Subscribe to 24h ticker
        $client->send(json_encode([
            'method' => 'market24h.subscribe',
            'params' => [],
            'id'     => 2,
        ]));

        $lastHeartbeat = time();

        // ── Message Loop ──────────────────────────────────────────────
        while (!$shutdown) {
            // Check heartbeat and send ping if needed
            $now = time();
            if ($now - $lastHeartbeat >= HEARTBEAT_INTERVAL) {
                $client->send(json_encode([
                    'method' => 'server.ping',
                    'params' => [],
                    'id'     => $now,
                ]));
                $lastHeartbeat = $now;
            }

            // Try to receive a message (non-blocking with timeout)
            try {
                $message = $client->receive();
            } catch (TimeoutException $e) {
                continue;
            }

            // null means connection closed
            if ($message === null) {
                break;
            }

            // With return_obj=true, $message is a Message object
            $text = $message->getContent();
            if ($text === '') {
                continue;
            }

            processMessage($text);
        }

    } catch (TimeoutException $e) {
        // Timeout in the outer scope — likely from connect() or send()
        // Just reconnect
    } catch (\Throwable $e) {
        fprintf(STDERR, "\nError: %s\n  in %s:%d\n", $e->getMessage(), $e->getFile(), $e->getLine());
    }

    if (isset($client)) {
        try {
            $client->close();
        } catch (\Throwable $_) {
            // ignore close errors
        }
        unset($client);
    }

    if ($shutdown) {
        break;
    }

    // ── Exponential backoff reconnect ─────────────────────────────────
    fprintf(STDOUT, "\nReconnecting in %ds ...\n", $reconnectDelay);
    for ($i = 0; $i < $reconnectDelay; $i++) {
        if ($shutdown) {
            break 2;
        }
        sleep(1);
    }
    $reconnectDelay = min($reconnectDelay * 2, RECONNECT_DELAY_MAX);
}

fprintf(STDOUT, "\nShutdown complete.\n");