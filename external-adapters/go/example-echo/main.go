// Package main is a minimal AHAP adapter that proves the protocol works
// end-to-end. It implements ListSessions, GetSession, SendMessage and
// event emission; everything else returns -32601 (unsupported).
//
// Build:
//   cd external-adapters/go/example-echo
//   go build -o echo-adapter .
//
// Wire into agent-herder via a drop-in (see deploy notes in the spec):
//   Environment=AHAP_ECHO_BIN=/home/roomhacker/.../echo-adapter
//
// This adapter is intentionally tiny: ~150 lines, ~5 MB RSS.
package main

import (
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/agent-herder/ahap-go"
)

type echoAdapter struct {
	mu     sync.Mutex
	emit   func(ahap.Event) error
	titles map[string]string
}

func (a *echoAdapter) Initialize(harness string) (*ahap.InitializeResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.titles == nil {
		a.titles = map[string]string{"echo-1": "Echo session 1", "echo-2": "Echo session 2"}
	}
	return &ahap.InitializeResult{
		Harness: harness,
		Name:    "Echo (Go)",
		Capabilities: ahap.Capabilities{
			Methods: []string{"init", "listSessions", "getSession", "sendMessage", "subscribeEvents"},
			ControlCapabilities: ahap.ControlCapabilities{
				CancelTurn: true, Resume: false, Events: true,
			},
		},
	}, nil
}

func (a *echoAdapter) Init() error {
	// Demonstrate event emission: announce that the adapter connected.
	if a.emit != nil {
		_ = a.emit(ahap.Event{
			Kind:    "process.connected",
			Harness: "echo",
			At:      time.Now().UTC().Format(time.RFC3339),
			Data:    map[string]interface{}{"transport": "ahap-stdio"},
		})
	}
	return nil
}

func (a *echoAdapter) SetEmitter(emit func(ahap.Event) error) { a.emit = emit }

func (a *echoAdapter) ListSessions() ([]map[string]interface{}, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]map[string]interface{}, 0, len(a.titles))
	now := time.Now().UTC().Format(time.RFC3339)
	for id, title := range a.titles {
		out = append(out, map[string]interface{}{
			"id":          id,
			"harness":     "echo",
			"status":      "idle",
			"title":       title,
			"cwd":         "/tmp",
			"updatedAt":   now,
			"sourceRoute": "echo://" + id,
		})
	}
	return out, nil
}

func (a *echoAdapter) GetSession(id string) (map[string]interface{}, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	title, ok := a.titles[id]
	if !ok {
		return nil, nil
	}
	return map[string]interface{}{
		"id":        id,
		"harness":   "echo",
		"status":    "idle",
		"title":     title,
		"cwd":       "/tmp",
		"updatedAt": time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func (a *echoAdapter) SendMessage(id string, options []byte) (map[string]interface{}, error) {
	// Echo back: pretend the assistant said "echo: <message>".
	if a.emit != nil {
		_ = a.emit(ahap.Event{
			Kind:      "turn.started",
			Harness:   "echo",
			SessionID: id,
			At:        time.Now().UTC().Format(time.RFC3339),
		})
	}
	// resolve to "ok": true
	return map[string]interface{}{"ok": true}, nil
}

func main() {
	adapter := &echoAdapter{}
	if err := ahap.ServeWithEmitter(adapter); err != nil {
		fmt.Fprintln(os.Stderr, "[echo-adapter] fatal:", err)
		os.Exit(1)
	}
}
