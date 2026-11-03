// Package ahap is the Agent-Herder Adapter Protocol SDK for Go.
//
// AHAP is JSON-RPC 2.0 over newline-delimited JSON on stdio. The
// supervisor (agent-herder) spawns this subprocess, sends an
// `initialize` request, then calls HarnessAdapter methods as needed.
// The adapter may emit `event` notifications at any time.
//
// Implement the Handler interface and call Serve. Serve blocks until
// the supervisor sends `shutdown` or stdin closes.
//
//	func main() {
//	    ahap.Serve(&MyAdapter{})
//	}
package ahap

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
)

// Handler is implemented by an external adapter. Methods that the
// adapter does not support should return ErrUnsupportedMethod, which
// the SDK reports to the supervisor as JSON-RPC error -32601. The
// supervisor then treats the method as absent (same path as a TS
// adapter that leaves a method undefined).
type Handler interface {
	// Initialize is called once at startup. The handler returns its
	// capabilities (which methods it implements + controlCapabilities
	// that the supervisor mirrors on HarnessAdapter).
	Initialize(harness string) (*InitializeResult, error)

	// Init is optional; called after Initialize if the capabilities
	// list includes "init". Return ErrUnsupportedMethod to skip it.
	Init() error
}

// ErrUnsupportedMethod tells the SDK to return -32601.
var ErrUnsupportedMethod = errors.New("ahap: unsupported method")

// InitializeResult is the response to the `initialize` request.
type InitializeResult struct {
	Harness       string              `json:"harness"`
	Name          string              `json:"name"`
	Capabilities  Capabilities        `json:"capabilities"`
}

// Capabilities mirrors the supervisor's HarnessAdapter capability sets.
type Capabilities struct {
	Methods             []string               `json:"methods"`
	ControlCapabilities ControlCapabilities    `json:"controlCapabilities"`
	BrowserFeatures     *BrowserFeatures       `json:"browserFeatures,omitempty"`
	RuntimeCapabilities map[string]interface{} `json:"runtimeCapabilities,omitempty"`
}

// ControlCapabilities mirrors src/types/common.ts HarnessCapabilities.
type ControlCapabilities struct {
	CancelTurn  bool `json:"cancelTurn"`
	Detach      bool `json:"detach"`
	Resume      bool `json:"resume"`
	Terminate   bool `json:"terminate"`
	Recover     bool `json:"recover"`
	Fork        bool `json:"fork"`
	ModelSwitch bool `json:"modelSwitch"`
	Subagents   bool `json:"subagents"`
	Events      bool `json:"events"`
}

// BrowserFeatures mirrors BrowserChatDriver.browserFeatures.
type BrowserFeatures struct {
	NativeConversationIds bool `json:"nativeConversationIds"`
	QueueAfterGeneration  bool `json:"queueAfterGeneration"`
	ChatCreation          bool `json:"chatCreation"`
	AccountArchiveViaCdp  bool `json:"accountArchiveViaCdp"`
}

// Event is a notification emitted to the supervisor. Kind must be one
// of the HarnessEventKind values (session.created, permission.requested,
// etc.). The supervisor wraps the event and fans it out to every
// listener.
type Event struct {
	Kind         string                 `json:"kind"`
	Harness      string                 `json:"harness"`
	SessionID    string                 `json:"sessionId,omitempty"`
	At           string                 `json:"at,omitempty"`
	PermissionID string                 `json:"permissionId,omitempty"`
	Data         map[string]interface{} `json:"data,omitempty"`
}

// Serve runs the AHAP loop on stdin/stdout until shutdown or EOF.
// stderr is left for the adapter to use freely (line-by-line logging
// is echoed by the supervisor).
func Serve(h Handler) error {
	srv := &server{handler: h, out: bufio.NewWriter(os.Stdout)}
	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		line = line[:len(line)-1] // strip newline
		if len(line) == 0 {
			continue
		}
		if err := srv.handleLine(line); err != nil {
			return err
		}
	}
}

type server struct {
	handler Handler
	out     *bufio.Writer
	mu      sync.Mutex // serializes writes to stdout
	harness string
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (s *server) handleLine(line string) error {
	var req rpcRequest
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		return s.respondRaw(nil, -32700, "parse error: "+err.Error())
	}
	// Notification (no id): only "event" is expected from the supervisor,
	// and that direction is outgoing only. Ignore any other notification.
	if len(req.ID) == 0 || string(req.ID) == "null" {
		return nil
	}
	var result interface{}
	var err error
	switch req.Method {
	case "initialize":
		var p struct {
			Harness string `json:"harness"`
		}
		_ = json.Unmarshal(req.Params, &p)
		s.harness = p.Harness
		result, err = s.handler.Initialize(p.Harness)
	case "init":
		err = s.handler.Init()
		if errors.Is(err, ErrUnsupportedMethod) {
			err = nil // not declared -> treat as no-op success
		}
	case "subscribeEvents":
		// No state needed: the SDK forwards every event the handler emits
		// through EmitEvent. The supervisor subscribes implicitly.
		result = struct{}{}
	case "shutdown":
		_ = s.writeResponse(req.ID, struct{}{}, nil)
		return io.EOF // clean exit
	case "listSessions":
		if h, ok := s.handler.(ListSessionsHandler); ok {
			result, err = h.ListSessions()
		} else {
			err = ErrUnsupportedMethod
		}
	case "getSession":
		if h, ok := s.handler.(GetSessionHandler); ok {
			var p struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal(req.Params, &p)
			result, err = h.GetSession(p.ID)
		} else {
			err = ErrUnsupportedMethod
		}
	case "getSessionMessages":
		if h, ok := s.handler.(GetMessagesHandler); ok {
			var p struct {
				ID    string `json:"id"`
				Limit int    `json:"limit,omitempty"`
			}
			_ = json.Unmarshal(req.Params, &p)
			result, err = h.GetSessionMessages(p.ID, p.Limit)
		} else {
			err = ErrUnsupportedMethod
		}
	case "sendMessage":
		if h, ok := s.handler.(SendMessageHandler); ok {
			var p struct {
				ID      string `json:"id"`
				Options []byte `json:"-"` // raw subslice, populated below
			}
			var raw struct {
				ID      string          `json:"id"`
				Options json.RawMessage `json:"options"`
			}
			_ = json.Unmarshal(req.Params, &raw)
			p.ID = raw.ID
			p.Options = []byte(raw.Options)
			result, err = h.SendMessage(p.ID, p.Options)
		} else {
			err = ErrUnsupportedMethod
		}
	case "stopTurn":
		if h, ok := s.handler.(StopTurnHandler); ok {
			var p struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal(req.Params, &p)
			result, err = h.StopTurn(p.ID)
		} else {
			err = ErrUnsupportedMethod
		}
	case "listModels":
		if h, ok := s.handler.(ListModelsHandler); ok {
			result, err = h.ListModels()
		} else {
			err = ErrUnsupportedMethod
		}
	default:
		return s.respondRaw(req.ID, -32601, "method not found: "+req.Method)
	}
	if errors.Is(err, ErrUnsupportedMethod) {
		return s.respondRaw(req.ID, -32601, "method not implemented: "+req.Method)
	}
	if err != nil {
		return s.respondRaw(req.ID, -32603, err.Error())
	}
	return s.writeResponse(req.ID, result, nil)
}

// EmitEvent sends a notification to the supervisor. Safe to call from
// any goroutine. The handler obtains the emitter by asserting that its
// handler value also implements EventEmittingHandler; the supervisor
// calls subscribeEvents first, so emissions are always delivered.
func (s *server) EmitEvent(e Event) error {
	if e.Harness == "" {
		e.Harness = s.harness
	}
	notif := struct {
		JSONRPC string `json:"jsonrpc"`
		Method  string `json:"method"`
		Params  Event  `json:"params"`
	}{"2.0", "event", e}
	body, err := json.Marshal(notif)
	if err != nil {
		return err
	}
	body = append(body, '\n')
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.out.Write(body)
	if err != nil {
		return err
	}
	return s.out.Flush()
}

func (s *server) writeResponse(id json.RawMessage, result interface{}, e *rpcError) error {
	resp := rpcResponse{JSONRPC: "2.0", ID: id, Result: result, Error: e}
	body, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	body = append(body, '\n')
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.out.Write(body); err != nil {
		return err
	}
	return s.out.Flush()
}

func (s *server) respondRaw(id json.RawMessage, code int, msg string) error {
	return s.writeResponse(id, nil, &rpcError{Code: code, Message: msg})
}

// Optional method interfaces: an adapter implements whichever subset
// it supports. The SDK checks at runtime and returns -32601 for the
// rest, so the supervisor sees exactly the same shape as a TS adapter
// that leaves methods undefined.

type ListSessionsHandler interface {
	ListSessions() ([]map[string]interface{}, error)
}
type GetSessionHandler interface {
	GetSession(id string) (map[string]interface{}, error)
}
type GetMessagesHandler interface {
	GetSessionMessages(id string, limit int) ([]map[string]interface{}, error)
}
type SendMessageHandler interface {
	SendMessage(id string, options []byte) (map[string]interface{}, error)
}
type StopTurnHandler interface {
	StopTurn(id string) (map[string]interface{}, error)
}
type ListModelsHandler interface {
	ListModels() ([]string, error)
}

// EventEmittingHandler is an OPTIONAL interface an adapter implements
// if it wants to push events to the supervisor. The SDK calls
// SetEmitter once at startup with a function the adapter can call
// from any goroutine.
type EventEmittingHandler interface {
	SetEmitter(emit func(Event) error)
}

// ServeWithEmitter is like Serve but the adapter receives an Emit
// function it can call from any goroutine.
func ServeWithEmitter(h Handler) error {
	srv := &server{handler: h, out: bufio.NewWriter(os.Stdout)}
	if eh, ok := h.(EventEmittingHandler); ok {
		eh.SetEmitter(srv.EmitEvent)
	}
	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		line = line[:len(line)-1]
		if len(line) == 0 {
			continue
		}
		if err := srv.handleLine(line); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

// Must panics if err is non-nil. Convenience for adapter mains.
func Must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "[ahap] fatal:", err)
		os.Exit(1)
	}
}
