#!/usr/bin/env ruby
# frozen_string_literal: true

# Phemex WebSocket Price — subscribes to the BTCUSD 24h ticker channel,
# printing the last price to stdout on each update.
#
# Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
# Sends a heartbeat (server.ping) every 20s and prints the pong to stdout.
#
# Usage:  bundle exec ruby ticker.rb

require "json"
require "websocket-client-simple"

WS_URL = "wss://ws.phemex.com"
SYMBOL = "BTCUSD"
PRICE_SCALE = 10_000
HEARTBEAT_INTERVAL = 20 # seconds
INITIAL_RECONNECT_DELAY = 1
MAX_RECONNECT_DELAY = 30

# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class TickerClient
  def initialize
    @ws = nil
    @last_price = nil
    @reconnect_delay = INITIAL_RECONNECT_DELAY
    @heartbeat_thread = nil
    @heartbeat_stop = false
    @running = true
    @reconnect_timer = nil
    @price_mutex = Mutex.new
  end

  def connect
    @ws&.close

    captured_ws = WebSocket::Client::Simple.connect(WS_URL)
    @ws = captured_ws
    client = self

    captured_ws.on :open do
      client.instance_variable_set(:@reconnect_delay, INITIAL_RECONNECT_DELAY)
      $stderr.puts "Connected to Phemex WebSocket"

      captured_ws.send(JSON.generate({ method: "market24h.subscribe", params: [], id: 2 }))

      client.start_heartbeat
    end

    captured_ws.on :message do |event|
      client.handle_message(event.data)
    end

    captured_ws.on :close do |_event|
      $stderr.puts "Connection closed"
      client.stop_heartbeat
      client.schedule_reconnect
    end

    captured_ws.on :error do |event|
      $stderr.puts "WebSocket error: #{event.message}" if event.message
    end
  end

  def running?
    @running
  end

  def shutdown
    @running = false
    @reconnect_timer&.kill
    stop_heartbeat
    @ws&.close
  end

  # Make these accessible from the blocks via the `client` reference
  public

  def start_heartbeat
    stop_heartbeat
    @heartbeat_stop = false
    @heartbeat_thread = Thread.new do
      until @heartbeat_stop
        sleep HEARTBEAT_INTERVAL
        break if @heartbeat_stop
        @ws&.send(JSON.generate({ method: "server.ping", params: [], id: (Time.now.to_f * 1000).to_i }))
      end
    end
  end

  def stop_heartbeat
    @heartbeat_stop = true
    @heartbeat_thread&.kill
    @heartbeat_thread = nil
  end

  def schedule_reconnect
    return unless @running

    delay = @reconnect_delay
    @reconnect_delay = [@reconnect_delay * 2, MAX_RECONNECT_DELAY].min

    $stderr.puts "Reconnecting in #{delay}s..."
    @reconnect_timer = Thread.new do
      sleep delay
      connect if @running
    end
  end

  def handle_message(raw)
    msg = JSON.parse(raw)

    # Pong — heartbeat response
    if msg["result"] == "pong"
      print "♥"
      $stdout.flush
      return
    end

    if msg["error"]
      $stderr.puts "Subscription error: #{msg["error"]}"
      return
    end

    # Ignore subscription ack
    return if msg.dig("result", "status") == "success"

    # 24h ticker channel — updates every ~1s
    market24h = msg["market24h"]
    if market24h.is_a?(Hash) && market24h["symbol"] == SYMBOL
      close_ep = market24h["close"]
      if close_ep.is_a?(Integer)
        price = close_ep.to_f / PRICE_SCALE
        log_price_if_changed(price)
      end
    end
  end

  private

  def log_price_if_changed(price)
    @price_mutex.synchronize do
      if @last_price.nil? || price != @last_price
        now = Time.now.strftime("%Y-%m-%d %H:%M:%S")
        print "\n#{now}  #{format("%.2f", price)} "
        $stdout.flush
        @last_price = price
      end
    end
  end
end

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

client = TickerClient.new
client.connect

Signal.trap("INT") do
  print "\nShutting down..."
  $stdout.flush
  client.shutdown
end

# Keep the main thread alive
loop do
  sleep 1
  break unless client.running?
end

puts " done"