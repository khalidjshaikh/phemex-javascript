package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"os/signal"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	wsURL             = "wss://ws.phemex.com"
	symbol            = "BTCUSD"
	priceScale        = 10_000
	heartbeatInterval = 20 * time.Second
	initialReconnect  = 1 * time.Second
	maxReconnectDelay = 30 * time.Second
)

// ---------------------------------------------------------------------------
// Incoming message structures
// ---------------------------------------------------------------------------

type subscriptionResult struct {
	Status string `json:"status"`
}

type tickData struct {
	LastEp int64 `json:"lastEp"`
}

type market24hData struct {
	Symbol string `json:"symbol"`
	Close  int64  `json:"close"`
}

type incomingMessage struct {
	Error     interface{}          `json:"error,omitempty"`
	Result    *subscriptionResult  `json:"result,omitempty"`
	Tick      *tickData            `json:"tick,omitempty"`
	Market24h *market24hData       `json:"market24h,omitempty"`
}

// ---------------------------------------------------------------------------
// Price change detection
// ---------------------------------------------------------------------------

var (
	mu             sync.Mutex
	lastPrice      float64
	priceSeen      bool
)

func logPriceIfChanged(price float64) {
	mu.Lock()
	defer mu.Unlock()

	if !priceSeen || math.Abs(price-lastPrice) > 1e-9 {
		now := time.Now().Format("2006-01-02 15:04:05")
		fmt.Printf("\n%s  %.2f ", now, price)
		lastPrice = price
		priceSeen = true
	}
}

// ---------------------------------------------------------------------------
// Reconnecting WebSocket client
// ---------------------------------------------------------------------------

type client struct {
	conn           *websocket.Conn
	mu             sync.Mutex
	reconnectDelay time.Duration
	done           chan struct{}
	wg             sync.WaitGroup
}

func newClient() *client {
	return &client{
		reconnectDelay: initialReconnect,
		done:           make(chan struct{}),
	}
}

func (c *client) connect() {
	c.mu.Lock()
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
	c.mu.Unlock()

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		log.Printf("Dial error: %v — reconnecting in %v", err, c.reconnectDelay)
		c.scheduleReconnect()
		return
	}

	c.mu.Lock()
	c.conn = conn
	delay := c.reconnectDelay
	c.reconnectDelay = initialReconnect // reset backoff
	c.mu.Unlock()

	if delay > initialReconnect {
		log.Printf("Reconnected after %v", delay)
	} else {
		log.Println("Connected to Phemex WebSocket")
	}

	// Subscribe to 24h ticker
	c.writeJSON(map[string]interface{}{
		"method": "market24h.subscribe",
		"params": []interface{}{},
		"id":     2,
	})

	c.wg.Add(2)
	go c.heartbeatLoop()
	go c.readLoop()
}

func (c *client) writeJSON(v interface{}) {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()

	if conn == nil {
		return
	}

	if err := conn.WriteJSON(v); err != nil {
		log.Printf("Write error: %v", err)
	}
}

func (c *client) heartbeatLoop() {
	defer c.wg.Done()

	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			c.mu.Lock()
			conn := c.conn
			c.mu.Unlock()

			if conn == nil {
				return
			}

			if err := conn.WriteJSON(map[string]interface{}{
				"method": "server.ping",
				"params": []interface{}{},
				"id":     time.Now().UnixMilli(),
			}); err != nil {
				log.Printf("Heartbeat write error: %v", err)
				return
			}
		}
	}
}

func (c *client) readLoop() {
	defer c.wg.Done()

	for {
		c.mu.Lock()
		conn := c.conn
		c.mu.Unlock()

		if conn == nil {
			return
		}

		_, raw, err := conn.ReadMessage()
		if err != nil {
			// If we're shutting down, don't reconnect
			select {
			case <-c.done:
				return
			default:
			}

			log.Printf("Read error: %v — reconnecting", err)
			c.scheduleReconnect()
			return
		}

		c.handleMessage(raw)
	}
}

func (c *client) handleMessage(raw []byte) {
	// Check for pong first (Phemex returns top-level "result":"pong")
	var resultField string
	if err := json.Unmarshal(raw, &struct {
		Result *string `json:"result"`
	}{Result: &resultField}); err == nil && resultField == "pong" {
		fmt.Print("♥")
		return
	}

	var msg incomingMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		log.Printf("Unmarshal error: %v", err)
		return
	}

	if msg.Error != nil {
		log.Printf("Subscription error: %v", msg.Error)
		return
	}

	// Subscription ack
	if msg.Result != nil && msg.Result.Status == "success" {
		return
	}

	// Tick channel — real-time trade price
	if msg.Tick != nil {
		price := float64(msg.Tick.LastEp) / priceScale
		logPriceIfChanged(price)
		return
	}

	// 24h ticker channel — updates every ~1s
	if msg.Market24h != nil && msg.Market24h.Symbol == symbol {
		price := float64(msg.Market24h.Close) / priceScale
		logPriceIfChanged(price)
	}
}

func (c *client) scheduleReconnect() {
	c.mu.Lock()
	delay := c.reconnectDelay
	if delay < maxReconnectDelay {
		c.reconnectDelay = delay * 2
		if c.reconnectDelay > maxReconnectDelay {
			c.reconnectDelay = maxReconnectDelay
		}
	}
	c.mu.Unlock()

	select {
	case <-c.done:
		return
	default:
	}

	time.AfterFunc(delay, func() {
		select {
		case <-c.done:
			return
		default:
			c.connect()
		}
	})
}

func (c *client) close() {
	close(c.done)

	c.mu.Lock()
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
	c.mu.Unlock()

	c.wg.Wait()
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	log.SetFlags(0)
	log.SetOutput(os.Stderr)

	cl := newClient()
	cl.connect()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt)
	<-sigCh

	fmt.Println("\nShutting down...")
	cl.close()
}