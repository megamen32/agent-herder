// Package main is the generic Go session-reader adapter: the extension of
// the Phase B minimax-code Go adapter to every driver with an on-disk
// session store (codex, opencode, zcode, hermes, claude).
//
// One binary serves every harness: the supervisor names the harness through
// the AHAP_HARNESS environment variable (or the initialize parameter) and the
// adapter picks the matching reader. Every reader is strictly read-only and
// bounded, mirroring the corresponding TypeScript discovery paths:
//
//   codex    ~/.codex/state_5.sqlite threads + rollout .jsonl files
//   opencode opencode.db session/message/part tables
//   zcode    ~/.zcode/cli/db/db.sqlite session/message/part tables
//   hermes   hermes state.db sessions/messages tables
//   claude   ~/.claude/projects/**/<session>.jsonl transcripts
//
// The adapter advertises exactly the read surface it implements
// (init, listSessions, getSession, getSessionMessages); control and delivery
// stay with the harness's full adapter until a Go port implements them.
package main

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/agent-herder/ahap-go"
)

const (
	maxSessions       = 500
	maxMessages       = 5000
	maxMessageChars   = 64 * 1024
	maxTitleLength    = 120
	maxLastMessageLen = 400
	readBufferLimit   = 8 * 1024 * 1024
)

// ---------------------------------------------------------------------------
// Session row construction
// ---------------------------------------------------------------------------

func agentSession(harness, id, title, status, cwd, lastActivity string, extra map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{
		"id":           id,
		"harness":      harness,
		"status":       status,
		"title":        title,
		"cwd":          cwd,
		"lastActivity": lastActivity,
		"hostId":       "", // the supervisor stamps localSessionHostId()
		"meta": map[string]interface{}{
			"sourceRoute": harness + "://" + id,
		},
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func truncateText(value string, limit int) string {
	flat := strings.TrimSpace(strings.Join(strings.Fields(value), " "))
	if len(flat) <= limit {
		return flat
	}
	return flat[:limit-1] + "…"
}

// ---------------------------------------------------------------------------
// Reader interface
// ---------------------------------------------------------------------------

type sessionReader interface {
	Init() error
	ListSessions() ([]map[string]interface{}, error)
	GetSession(id string) (map[string]interface{}, error)
	GetSessionMessages(id string, limit int) ([]map[string]interface{}, error)
}

// ---------------------------------------------------------------------------
// SQLite reader (opencode, zcode, hermes)
// ---------------------------------------------------------------------------

type sqliteStore struct {
	harness string
	path    string
	hermes  bool // sessions/messages table names instead of session/message
	listSQL    string
	messageSQL string
	partSQL    string
}

func newSqliteStore(harness, path string, hermes bool) *sqliteStore {
	s := &sqliteStore{harness: harness, path: path, hermes: hermes}
	if hermes {
		s.listSQL = "SELECT id, title, cwd FROM sessions ORDER BY id"
		s.messageSQL = "SELECT id, content FROM messages WHERE session_id = ? ORDER BY timestamp, id"
		s.partSQL = ""
	} else {
		s.listSQL = "SELECT id, title, directory AS cwd FROM session ORDER BY id"
		s.messageSQL = "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id"
		s.partSQL = "SELECT id, data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created, id"
	}
	return s
}

func (s *sqliteStore) open() (*sql.DB, error) {
	db, err := sql.Open("sqlite", "file:"+s.path+"?mode=ro")
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec("PRAGMA busy_timeout=1000"); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func (s *sqliteStore) Init() error {
	info, err := os.Stat(s.path)
	if err != nil {
		return fmt.Errorf("%s session database not found at %s: %w", s.harness, s.path, err)
	}
	if info.IsDir() {
		return fmt.Errorf("%s session database is a directory: %s", s.harness, s.path)
	}
	return nil
}

type sqliteSessionRow struct {
	id    string
	title string
	cwd   string
}

func (s *sqliteStore) rows(db *sql.DB) ([]sqliteSessionRow, error) {
	result, err := db.Query(s.listSQL)
	if err != nil {
		return nil, err
	}
	defer result.Close()
	var rows []sqliteSessionRow
	for result.Next() {
		var id, title, cwd sql.NullString
		if err := result.Scan(&id, &title, &cwd); err != nil {
			return nil, err
		}
		if !id.Valid || id.String == "" {
			continue
		}
		rows = append(rows, sqliteSessionRow{id: id.String, title: title.String, cwd: cwd.String})
		if len(rows) >= maxSessions {
			break
		}
	}
	return rows, result.Err()
}

func (s *sqliteStore) lastActivity(db *sql.DB, id string) string {
	query := "SELECT MAX(time_created) FROM message WHERE session_id = ?"
	if s.hermes {
		query = "SELECT MAX(timestamp) FROM messages WHERE session_id = ?"
	}
	var last sql.NullFloat64
	if err := db.QueryRow(query, id).Scan(&last); err != nil || !last.Valid {
		return time.Now().UTC().Format(time.RFC3339)
	}
	raw := int64(last.Float64)
	if raw <= 0 {
		return time.Now().UTC().Format(time.RFC3339)
	}
	// Native schemas store either epoch seconds or epoch milliseconds; the
	// magnitude separates them (1e11 seconds would be year 5138, 1e11
	// milliseconds is 1973).
	if raw > 1e11 {
		return time.UnixMilli(raw).UTC().Format(time.RFC3339)
	}
	return time.Unix(raw, 0).UTC().Format(time.RFC3339)
}

func (s *sqliteStore) toSession(row sqliteSessionRow, lastActivity string) map[string]interface{} {
	title := row.title
	if strings.TrimSpace(title) == "" {
		title = row.id
	}
	return agentSession(s.harness, row.id, truncateText(title, maxTitleLength), "idle", row.cwd, lastActivity, map[string]interface{}{
		"needsPermission": false,
	})
}

func (s *sqliteStore) ListSessions() ([]map[string]interface{}, error) {
	db, err := s.open()
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := s.rows(db)
	if err != nil {
		return nil, err
	}
	sessions := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		sessions = append(sessions, s.toSession(row, s.lastActivity(db, row.id)))
	}
	return sessions, nil
}

func (s *sqliteStore) GetSession(id string) (map[string]interface{}, error) {
	db, err := s.open()
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := s.rows(db)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if row.id == id {
			return s.toSession(row, s.lastActivity(db, row.id)), nil
		}
	}
	return nil, nil
}

func textOfJSON(raw string) string {
	var value interface{}
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return raw
	}
	return textOfValue(value)
}

func textOfValue(value interface{}) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []interface{}:
		var parts []string
		for _, item := range typed {
			if text := textOfValue(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	case map[string]interface{}:
		if text, ok := typed["text"].(string); ok {
			return text
		}
		if content, ok := typed["content"]; ok {
			return textOfValue(content)
		}
		return ""
	default:
		return ""
	}
}

func (s *sqliteStore) GetSessionMessages(id string, limit int) ([]map[string]interface{}, error) {
	if limit <= 0 || limit > maxMessages {
		limit = maxMessages
	}
	db, err := s.open()
	if err != nil {
		return nil, err
	}
	defer db.Close()
	messages, err := db.Query(s.messageSQL, id)
	if err != nil {
		return nil, err
	}
	defer messages.Close()
	var out []map[string]interface{}
	for messages.Next() {
		var messageID, payload sql.NullString
		if err := messages.Scan(&messageID, &payload); err != nil {
			return nil, err
		}
		if !messageID.Valid {
			continue
		}
		if s.hermes {
			body := textOfJSON(payload.String)
			if body == "" {
				continue
			}
			out = append(out, map[string]interface{}{"id": messageID.String, "role": "user", "text": truncateText(body, maxMessageChars)})
		} else {
			var envelope struct {
				Role string `json:"role"`
			}
			_ = json.Unmarshal([]byte(payload.String), &envelope)
			if s.partSQL == "" {
				continue
			}
			parts, err := db.Query(s.partSQL, id, messageID.String)
			if err != nil {
				return nil, err
			}
			for parts.Next() {
				var partID, partData sql.NullString
				if err := parts.Scan(&partID, &partData); err != nil {
					parts.Close()
					return nil, err
				}
				if !partID.Valid {
					continue
				}
				var part struct {
					Type string `json:"type"`
					Text string `json:"text"`
				}
				_ = json.Unmarshal([]byte(partData.String), &part)
				if strings.TrimSpace(part.Text) == "" {
					continue
				}
				role := envelope.Role
				if role == "" {
					role = "user"
				}
				out = append(out, map[string]interface{}{"id": partID.String, "role": role, "text": truncateText(part.Text, maxMessageChars)})
				if len(out) >= limit {
					break
				}
			}
			parts.Close()
		}
		if len(out) >= limit {
			break
		}
	}
	return out, messages.Err()
}

// ---------------------------------------------------------------------------
// Codex reader (state_5.sqlite threads + rollout jsonl)
// ---------------------------------------------------------------------------

type codexStore struct {
	home string
}

func (c *codexStore) dbPath() string {
	if value := os.Getenv("CODEX_STATE_DB"); value != "" {
		return value
	}
	return filepath.Join(c.home, "state_5.sqlite")
}

type codexThread struct {
	id          string
	title       string
	cwd         string
	rolloutPath string
}

func (c *codexStore) threads() ([]codexThread, error) {
	path := c.dbPath()
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("codex state database not found at %s: %w", path, err)
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()
	if _, err := db.Exec("PRAGMA busy_timeout=1000"); err != nil {
		return nil, err
	}
	rows, err := db.Query("SELECT id, title, cwd, rollout_path FROM threads ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var threads []codexThread
	for rows.Next() {
		var id, title, cwd, rollout sql.NullString
		if err := rows.Scan(&id, &title, &cwd, &rollout); err != nil {
			return nil, err
		}
		if !id.Valid || id.String == "" || !rollout.Valid || rollout.String == "" {
			continue
		}
		threads = append(threads, codexThread{id: id.String, title: title.String, cwd: cwd.String, rolloutPath: rollout.String})
		if len(threads) >= maxSessions {
			break
		}
	}
	return threads, rows.Err()
}

func (c *codexStore) Init() error {
	_, err := c.threads()
	return err
}

func codexLastActivity(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return time.Now().UTC().Format(time.RFC3339)
	}
	return info.ModTime().UTC().Format(time.RFC3339)
}

func (c *codexStore) toSession(t codexThread) map[string]interface{} {
	title := t.title
	if strings.TrimSpace(title) == "" {
		title = t.id
	}
	return agentSession("codex", t.id, truncateText(title, maxTitleLength), "idle", t.cwd, codexLastActivity(t.rolloutPath), map[string]interface{}{
		"needsPermission": false,
		"rolloutPath":     t.rolloutPath,
	})
}

func (c *codexStore) ListSessions() ([]map[string]interface{}, error) {
	threads, err := c.threads()
	if err != nil {
		return nil, err
	}
	sessions := make([]map[string]interface{}, 0, len(threads))
	for _, t := range threads {
		if _, err := os.Stat(t.rolloutPath); err != nil {
			continue // a missing rollout cannot be read back
		}
		sessions = append(sessions, c.toSession(t))
	}
	return sessions, nil
}

func (c *codexStore) GetSession(id string) (map[string]interface{}, error) {
	threads, err := c.threads()
	if err != nil {
		return nil, err
	}
	for _, t := range threads {
		if t.id == id {
			if _, err := os.Stat(t.rolloutPath); err != nil {
				return nil, nil
			}
			return c.toSession(t), nil
		}
	}
	return nil, nil
}

func (c *codexStore) GetSessionMessages(id string, limit int) ([]map[string]interface{}, error) {
	if limit <= 0 || limit > maxMessages {
		limit = maxMessages
	}
	threads, err := c.threads()
	if err != nil {
		return nil, err
	}
	var rollout string
	for _, t := range threads {
		if t.id == id {
			rollout = t.rolloutPath
			break
		}
	}
	if rollout == "" {
		return nil, nil
	}
	file, err := os.Open(rollout)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 64*1024)
	var out []map[string]interface{}
	var consumed int64
	for len(out) < limit {
		line, err := reader.ReadString('\n')
		consumed += int64(len(line))
		if consumed > readBufferLimit {
			break
		}
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			var record struct {
				Type    string `json:"type"`
				Payload struct {
					Type    string      `json:"type"`
					Role    string      `json:"role"`
					Content interface{} `json:"content"`
				} `json:"payload"`
			}
			if json.Unmarshal([]byte(trimmed), &record) == nil &&
				record.Type == "response_item" && record.Payload.Type == "message" {
				text := textOfValue(record.Payload.Content)
				if strings.TrimSpace(text) != "" {
					role := record.Payload.Role
					if role == "" {
						role = "user"
					}
					out = append(out, map[string]interface{}{"id": fmt.Sprintf("%s:%d", id, len(out)), "role": role, "text": truncateText(text, maxMessageChars)})
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Claude reader (~/.claude/projects/**/*.jsonl)
// ---------------------------------------------------------------------------

type claudeStore struct {
	root string
}

type claudeSession struct {
	id    string
	title string
	cwd   string
	path  string
	modAt time.Time
}

func (c *claudeStore) Init() error {
	info, err := os.Stat(c.root)
	if err != nil {
		return fmt.Errorf("claude projects directory not found at %s: %w", c.root, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("claude projects path is not a directory: %s", c.root)
	}
	return nil
}

func (c *claudeStore) scan() ([]claudeSession, error) {
	var sessions []claudeSession
	seen := map[string]bool{}
	err := filepath.WalkDir(c.root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable subtrees are skipped, not fatal
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		id, title, cwd := claudeIdentity(path)
		if id == "" {
			return nil
		}
		if seen[id] {
			return nil
		}
		seen[id] = true
		sessions = append(sessions, claudeSession{id: id, title: title, cwd: cwd, path: path, modAt: info.ModTime()})
		if len(sessions) >= maxSessions {
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].modAt.After(sessions[j].modAt) })
	return sessions, nil
}

func claudeIdentity(path string) (id, title, cwd string) {
	file, err := os.Open(path)
	if err != nil {
		return "", "", ""
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 64*1024)
	var consumed int64
	for consumed < readBufferLimit {
		line, err := reader.ReadString('\n')
		consumed += int64(len(line))
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			var record struct {
				SessionID string `json:"sessionId"`
				Cwd       string `json:"cwd"`
				Type      string `json:"type"`
				Message   struct {
					Role    string      `json:"role"`
					Content interface{} `json:"content"`
				} `json:"message"`
			}
			if json.Unmarshal([]byte(trimmed), &record) == nil {
				if record.SessionID != "" && id == "" {
					id = record.SessionID
				}
				if record.Cwd != "" && cwd == "" {
					cwd = record.Cwd
				}
				if title == "" && record.Message.Role == "user" {
					if text := textOfValue(record.Message.Content); strings.TrimSpace(text) != "" {
						title = truncateText(text, maxTitleLength)
					}
				}
				if id != "" && title != "" {
					break
				}
			}
		}
		if err != nil {
			break
		}
	}
	if id == "" {
		id = strings.TrimSuffix(filepath.Base(path), ".jsonl")
	}
	return id, title, cwd
}

func (c *claudeStore) toSession(s claudeSession) map[string]interface{} {
	title := s.title
	if strings.TrimSpace(title) == "" {
		title = s.id
	}
	return agentSession("claude", s.id, title, "idle", s.cwd, s.modAt.UTC().Format(time.RFC3339), map[string]interface{}{
		"needsPermission": false,
	})
}

func (c *claudeStore) ListSessions() ([]map[string]interface{}, error) {
	sessions, err := c.scan()
	if err != nil {
		return nil, err
	}
	out := make([]map[string]interface{}, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, c.toSession(s))
	}
	return out, nil
}

func (c *claudeStore) GetSession(id string) (map[string]interface{}, error) {
	sessions, err := c.scan()
	if err != nil {
		return nil, err
	}
	for _, s := range sessions {
		if s.id == id {
			return c.toSession(s), nil
		}
	}
	return nil, nil
}

func (c *claudeStore) GetSessionMessages(id string, limit int) ([]map[string]interface{}, error) {
	if limit <= 0 || limit > maxMessages {
		limit = maxMessages
	}
	sessions, err := c.scan()
	if err != nil {
		return nil, err
	}
	var path string
	for _, s := range sessions {
		if s.id == id {
			path = s.path
			break
		}
	}
	if path == "" {
		return nil, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 64*1024)
	var out []map[string]interface{}
	var consumed int64
	for len(out) < limit {
		line, err := reader.ReadString('\n')
		consumed += int64(len(line))
		if consumed > readBufferLimit {
			break
		}
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			var record struct {
				Message struct {
					Role    string      `json:"role"`
					Content interface{} `json:"content"`
				} `json:"message"`
			}
			if json.Unmarshal([]byte(trimmed), &record) == nil && record.Message.Role != "" {
				text := textOfValue(record.Message.Content)
				if strings.TrimSpace(text) != "" {
					out = append(out, map[string]interface{}{"id": fmt.Sprintf("%s:%d", id, len(out)), "role": record.Message.Role, "text": truncateText(text, maxMessageChars)})
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

type sessionReaderAdapter struct {
	harness string
	reader  sessionReader
}

func homeDir() string {
	if value := os.Getenv("HOME"); value != "" {
		return value
	}
	return "/root"
}

func readerFor(harness string) (sessionReader, error) {
	home := homeDir()
	switch harness {
	case "codex":
		codexHome := os.Getenv("CODEX_HOME")
		if codexHome == "" {
			codexHome = filepath.Join(home, ".codex")
		}
		return &codexStore{home: codexHome}, nil
	case "opencode":
		path := os.Getenv("OPENCODE_DB_PATH")
		if path == "" {
			path = filepath.Join(home, ".local/share/opencode/opencode.db")
		}
		return newSqliteStore("opencode", path, false), nil
	case "zcode":
		path := os.Getenv("ZCODE_DB_PATH")
		if path == "" {
			path = filepath.Join(home, ".zcode/cli/db/db.sqlite")
		}
		return newSqliteStore("zcode", path, false), nil
	case "hermes":
		path := os.Getenv("HERMES_STATE_DB")
		if path == "" {
			hermesHome := os.Getenv("HERMES_HOME")
			if hermesHome == "" {
				hermesHome = filepath.Join(home, ".hermes")
			}
			path = filepath.Join(hermesHome, "state.db")
		}
		return newSqliteStore("hermes", path, true), nil
	case "claude":
		root := os.Getenv("CLAUDE_PROJECTS_DIR")
		if root == "" {
			root = filepath.Join(home, ".claude/projects")
		}
		return &claudeStore{root: root}, nil
	default:
		return nil, fmt.Errorf("unsupported harness for the session reader: %s (supported: codex, opencode, zcode, hermes, claude)", harness)
	}
}

func (a *sessionReaderAdapter) Initialize(harness string) (*ahap.InitializeResult, error) {
	if a.reader == nil {
		reader, err := readerFor(harness)
		if err != nil {
			return nil, err
		}
		a.reader = reader
		a.harness = harness
	}
	return &ahap.InitializeResult{
		Harness: a.harness,
		Name:    a.harness + " session reader (Go)",
		Capabilities: ahap.Capabilities{
			Methods: []string{"init", "listSessions", "getSession", "getSessionMessages", "subscribeEvents"},
			ControlCapabilities: ahap.ControlCapabilities{
				CancelTurn: false,
				Resume:     false,
				Events:     true,
			},
		},
	}, nil
}

func (a *sessionReaderAdapter) Init() error { return a.reader.Init() }

func (a *sessionReaderAdapter) ListSessions() ([]map[string]interface{}, error) { return a.reader.ListSessions() }

func (a *sessionReaderAdapter) GetSession(id string) (map[string]interface{}, error) {
	return a.reader.GetSession(id)
}

func (a *sessionReaderAdapter) GetSessionMessages(id string, limit int) ([]map[string]interface{}, error) {
	return a.reader.GetSessionMessages(id, limit)
}

func main() {
	harness := os.Getenv("AHAP_HARNESS")
	adapter := &sessionReaderAdapter{}
	if harness != "" {
		// The environment names the harness before initialize arrives.
		if reader, err := readerFor(harness); err == nil {
			adapter.reader = reader
			adapter.harness = harness
		}
	}
	if err := ahap.Serve(adapter); err != nil {
		fmt.Fprintln(os.Stderr, "[session-reader-adapter] fatal:", err)
		os.Exit(1)
	}
}
