// Package main is the Go port of src/adapters/minimax-code.ts.
//
// Phase A scope: listSessions + getSession + getSessionMessages via the
// on-disk store. The HTTP control transport (sendMessage/steer/queue) and
// the SQLite runtime-state reads are Phase B; until they land, the adapter
// advertises only read-only methods in its capabilities.
//
// The TS adapter is stateless: every call reads from disk. This Go port
// keeps the same shape — no in-process state survives across requests
// except the bounded caches that mirror the TS indexCache/contentCache.
package main

import (
        "bufio"
        "context"
        "crypto/sha256"
        "encoding/base64"
        "encoding/json"
        "errors"
        "fmt"
        "io"
        "net/http"
        "os"
        "path/filepath"
        "sort"
        "strconv"
        "strings"
        "sync"
        "time"

        "github.com/agent-herder/ahap-go"
)

// ---------------------------------------------------------------------------
// Constants (mirror src/adapters/minimax-code.ts)
// ---------------------------------------------------------------------------

const (
        maxManifestBytes     = 64 * 1024
        maxModelBytes        = 512 * 1024
        titleWindowBytes     = 64 * 1024
        titleFallbackBytes   = 256 * 1024
        tailWindowBytes      = 32 * 1024
        maxTranscriptBytes   = 8 * 1024 * 1024
        maxTranscriptText    = 2 * 1024 * 1024
        maxMessageChars      = 64 * 1024
        maxRetainedChars     = 4 * 1024 * 1024
        maxMessageLimit      = 5000
        maxTitleLength       = 120
        maxLastMessageLength = 400
        indexTTLMS           = 10_000
        liveProofTTLMS       = 15_000
        maxEnumeratedDirs    = 4096
        defaultMaxSessions   = 500
)

// ---------------------------------------------------------------------------
// Types (mirror src/adapters/minimax-code.ts)
// ---------------------------------------------------------------------------

type minimaxManifest struct {
        SchemaVersion int               `json:"schemaVersion,omitempty"`
        SessionID     string            `json:"sessionId,omitempty"`
        CreatedAtMs   int64             `json:"createdAtMs,omitempty"`
        UpdatedAtMs   int64             `json:"updatedAtMs,omitempty"`
        Source        string            `json:"source,omitempty"`
        Layout        string            `json:"layout,omitempty"`
        Paths         map[string]string `json:"paths,omitempty"`
}

type minimaxMessageRecord struct {
        MessageID      string          `json:"message_id,omitempty"`
        TurnID         string          `json:"turn_id,omitempty"`
        Message        json.RawMessage `json:"message,omitempty"`
        HistoryArtifact string         `json:"history_artifact,omitempty"`
}

type minimaxStoredSession struct {
        ID          string
        Dir         string
        Manifest    minimaxManifest
        CreatedAtMs int64
        UpdatedAtMs int64
}

type fileStamp struct {
        MtimeMs int64
        Size    int64
}

// agentSession mirrors the JSON shape the supervisor expects for an
// AgentSession. It is intentionally a map[string]interface{} at the boundary
// so the supervisor can add fields without bumping the SDK.
func agentSession(id, title, status, cwd, lastActivity, sourceRoute string, extra map[string]interface{}) map[string]interface{} {
        out := map[string]interface{}{
                "id":           id,
                "harness":      "minimax-code",
                "status":       status,
                "title":        title,
                "cwd":          cwd,
                "updatedAt":    lastActivity,
                "sourceRoute":  sourceRoute,
                "hostId":       "", // supervisor stamps localSessionHostId()
        }
        for k, v := range extra {
                out[k] = v
        }
        return out
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

type minimaxAdapter struct {
        sessionStore string
        cwd          string
        maxSessions  int

        mu         sync.Mutex
        indexCache *indexCacheEntry
}

type indexCacheEntry struct {
        at      time.Time
        entries []minimaxStoredSession
}

func newAdapter() *minimaxAdapter {
        store := os.Getenv("MINIMAX_CODE_SESSION_STORE")
        if store == "" {
                store = filepath.Join(homeDir(), ".minimax", "v2", "sessions")
        }
        cwd := os.Getenv("MINIMAX_CODE_CWD")
        if cwd == "" {
                cwd = "/home/roomhacker/.minimax"
        }
        max := defaultMaxSessions
        if v := os.Getenv("MINIMAX_CODE_MAX_SESSIONS"); v != "" {
                if n, err := strconv.Atoi(v); err == nil && n > 0 {
                        max = n
                }
        }
        return &minimaxAdapter{sessionStore: store, cwd: cwd, maxSessions: max}
}

func homeDir() string {
        if h, err := os.UserHomeDir(); err == nil {
                return h
        }
        return "/root"
}

// ---------------------------------------------------------------------------
// AHAP Handler
// ---------------------------------------------------------------------------

func (a *minimaxAdapter) Initialize(harness string) (*ahap.InitializeResult, error) {
        return &ahap.InitializeResult{
                Harness: "minimax-code",
                Name:    "MiniMax Code (Go)",
                Capabilities: ahap.Capabilities{
                        Methods: []string{"init", "listSessions", "getSession", "getSessionMessages", "subscribeEvents"},
                        ControlCapabilities: ahap.ControlCapabilities{
                                CancelTurn: false, Resume: false, Events: true,
                        },
                },
        }, nil
}

func (a *minimaxAdapter) Init() error {
        info, err := os.Stat(a.sessionStore)
        if err != nil {
                return fmt.Errorf("MiniMax Code session store not found at %s: %w", a.sessionStore, err)
        }
        if !info.IsDir() {
                return fmt.Errorf("MiniMax Code session store is not a directory: %s", a.sessionStore)
        }
        return nil
}

func (a *minimaxAdapter) ListSessions() ([]map[string]interface{}, error) {
        entries, err := a.readStoredSessions()
        if err != nil {
                return nil, err
        }
        limit := a.maxSessions
        if limit > len(entries) {
                limit = len(entries)
        }
        out := make([]map[string]interface{}, 0, limit)
        for i := 0; i < limit; i++ {
                s, err := a.toSession(entries[i])
                if err != nil {
                        continue
                }
                out = append(out, s)
        }
        return out, nil
}

func (a *minimaxAdapter) GetSession(id string) (map[string]interface{}, error) {
        entries, err := a.readStoredSessions()
        if err != nil {
                return nil, err
        }
        for _, e := range entries {
                if e.ID == id {
                        return a.toSession(e)
                }
        }
        return nil, nil
}

// GetSessionMessages streams messages.jsonl line by line, parses each line as
// JSON, extracts the text, and returns the last `limit` messages.
func (a *minimaxAdapter) GetSessionMessages(id string, limit int) ([]map[string]interface{}, error) {
        if limit <= 0 {
                limit = maxMessageLimit
        }
        if limit > maxMessageLimit {
                limit = maxMessageLimit
        }
        entries, err := a.readStoredSessions()
        if err != nil {
                return nil, err
        }
        var entry *minimaxStoredSession
        for i := range entries {
                if entries[i].ID == id {
                        entry = &entries[i]
                        break
                }
        }
        if entry == nil {
                return nil, nil
        }
        views, err := readTranscriptViews(filepath.Join(entry.Dir, "messages.jsonl"), limit)
        if err != nil {
                return nil, err
        }
        return views, nil
}

// ---------------------------------------------------------------------------
// Directory walking + manifest parsing
// ---------------------------------------------------------------------------

// readStoredSessions walks the session store, decodes directory names to
// session ids, parses each manifest.json, and caches the result for indexTTLMS.
func (a *minimaxAdapter) readStoredSessions() ([]minimaxStoredSession, error) {
        a.mu.Lock()
        if a.indexCache != nil && time.Since(a.indexCache.at) < indexTTLMS {
                entries := a.indexCache.entries
                a.mu.Unlock()
                return entries, nil
        }
        a.mu.Unlock()

        dirs, err := collectSessionDirectories(a.sessionStore, maxEnumeratedDirs)
        if err != nil {
                return nil, err
        }
        entries := make([]minimaxStoredSession, 0, len(dirs))
        for _, dir := range dirs {
                entry, err := loadStoredSession(dir)
                if err != nil || entry == nil {
                        continue
                }
                entries = append(entries, *entry)
        }
        // Newest first by UpdatedAtMs
        sort.Slice(entries, func(i, j int) bool { return entries[i].UpdatedAtMs > entries[j].UpdatedAtMs })

        a.mu.Lock()
        a.indexCache = &indexCacheEntry{at: time.Now(), entries: entries}
        a.mu.Unlock()
        return entries, nil
}

func loadStoredSession(dir string) (*minimaxStoredSession, error) {
        id := decodeSessionKey(filepath.Base(dir))
        if id == "" {
                return nil, nil
        }
        manifestPath := filepath.Join(dir, "manifest.json")
        manifestBytes, err := readBoundedFile(manifestPath, maxManifestBytes)
        if err != nil {
                return nil, err
        }
        var manifest minimaxManifest
        if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
                return nil, err
        }
        if manifest.SessionID != "" && manifest.SessionID != id {
                return nil, nil
        }
        info, err := os.Stat(manifestPath)
        if err != nil {
                return nil, err
        }
        updatedAt := info.ModTime().UnixMilli()
        if manifest.UpdatedAtMs > 0 {
                updatedAt = manifest.UpdatedAtMs
        }
        createdAt := manifest.CreatedAtMs
        if createdAt == 0 {
                createdAt = updatedAt
        }
        return &minimaxStoredSession{
                ID:          id,
                Dir:         dir,
                Manifest:    manifest,
                CreatedAtMs: createdAt,
                UpdatedAtMs: updatedAt,
        }, nil
}

// decodeSessionKey mirrors src/adapters/minimax-code.ts:decodeSessionKey.
// Directory names look like: <timestamp>-session_<base64url(sessionId)>
// where sessionId starts with "mvs_".
func decodeSessionKey(dirName string) string {
        const marker = "-session_"
        idx := strings.LastIndex(dirName, marker)
        if idx < 0 {
                return ""
        }
        encoded := dirName[idx+len(marker):]
        if encoded == "" {
                return ""
        }
        decoded, err := base64.RawURLEncoding.DecodeString(encoded)
        if err != nil {
                return ""
        }
        s := string(decoded)
        if !strings.HasPrefix(s, "mvs_") {
                return ""
        }
        return s
}

// collectSessionDirectories walks the store root looking for directories
// whose name contains "-session_". Walk is breadth-limited to depth 3 and
// total count `limit`.
func collectSessionDirectories(root string, limit int) ([]string, error) {
        var found []string
        type item struct {
                dir   string
                depth int
        }
        queue := []item{{root, 0}}
        for len(queue) > 0 && len(found) < limit {
                it := queue[0]
                queue = queue[1:]
                if it.depth > 3 {
                        continue
                }
                entries, err := os.ReadDir(it.dir)
                if err != nil {
                        continue
                }
                // Visit newest dated paths first (lexicographic = chronological
                // because dir names start with a timestamp).
                sort.Slice(entries, func(i, j int) bool { return entries[i].Name() > entries[j].Name() })
                for _, entry := range entries {
                        if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
                                continue
                        }
                        full := filepath.Join(it.dir, entry.Name())
                        if strings.Contains(entry.Name(), "-session_") {
                                found = append(found, full)
                                if len(found) >= limit {
                                        break
                                }
                        } else {
                                queue = append(queue, item{full, it.depth + 1})
                        }
                }
        }
        return found, nil
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

func readBoundedFile(path string, maxBytes int) ([]byte, error) {
        f, err := os.Open(path)
        if err != nil {
                return nil, err
        }
        defer f.Close()
        info, err := f.Stat()
        if err != nil {
                return nil, err
        }
        if info.Size() > int64(maxBytes) {
                // Reject rather than truncate: a manifest larger than the bound is
                // suspicious and the TS adapter refuses it too.
                return nil, fmt.Errorf("file exceeds bound: %d > %d", info.Size(), int64(maxBytes))
        }
        buf := make([]byte, 0, int(info.Size()))
        r := bufio.NewReader(f)
        for {
                chunk := make([]byte, 4096)
                n, err := r.Read(chunk)
                if n > 0 {
                        if len(buf)+n > maxBytes {
                                return nil, fmt.Errorf("file exceeds bound during read")
                        }
                        buf = append(buf, chunk[:n]...)
                }
                if err == io.EOF {
                        break
                }
                if err != nil {
                        return nil, err
                }
        }
        return buf, nil
}

// ---------------------------------------------------------------------------
// Transcript streaming
// ---------------------------------------------------------------------------

func readTranscriptViews(path string, limit int) ([]map[string]interface{}, error) {
        f, err := os.Open(path)
        if err != nil {
                return nil, nil // missing transcript => empty list, not an error
        }
        defer f.Close()
        info, err := f.Stat()
        if err != nil {
                return nil, nil
        }
        if info.Size() == 0 {
                return nil, nil
        }
        // Stream with a bounded reader so a 17MiB log does not become one buffer.
        total := info.Size()
        if total > int64(maxTranscriptBytes) {
                total = int64(maxTranscriptBytes)
        }
        reader := io.LimitReader(f, total)
        scanner := bufio.NewScanner(reader)
        // Allow long lines: a single message record can carry several KB of text.
        scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)

        var views []map[string]interface{}
        retained := 0
        totalCount := 0
        for scanner.Scan() {
                line := strings.TrimSpace(scanner.Text())
                if line == "" || !strings.HasPrefix(line, "{") {
                        continue
                }
                var rec minimaxMessageRecord
                if err := json.Unmarshal([]byte(line), &rec); err != nil {
                        continue // truncated/partial record: skip, never fatal
                }
                // rec.Message is json.RawMessage; parse the bits we need.
                role, text, model, timestamp := extractMessageFields(rec.Message)
                if role == "" || strings.TrimSpace(text) == "" {
                        continue
                }
                totalCount++
                if len(text) > maxMessageChars {
                        text = text[:maxMessageChars]
                }
                view := map[string]interface{}{
                        "id":       rec.MessageID,
                        "role":     normalizeRole(role),
                        "text":     text,
                        "parts":    []map[string]interface{}{{"type": "text", "text": text}},
                        "turnId":   rec.TurnID,
                        "model":    model,
                        "timestamp": timestamp,
                }
                if view["id"] == "" {
                        view["id"] = fmt.Sprintf("msg:%d", totalCount)
                }
                views = append(views, view)
                retained += len(text)
                // Keep the tail bounded: drop the oldest while over retention.
                for len(views) > limit || (retained > maxRetainedChars && len(views) > 1) {
                        dropped := views[0]
                        if t, ok := dropped["text"].(string); ok {
                                retained -= len(t)
                        }
                        views = views[1:]
                }
        }
        if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
                return nil, err
        }
        return views, nil
}

func normalizeRole(role string) string {
        switch role {
        case "user", "assistant", "tool":
                return role
        default:
                return "system"
        }
}

// extractMessageFields pulls role/content/model/timestamp out of the raw
// message JSON, tolerating either a string content or an array of parts
// (mirrors src/adapters/minimax-code.ts:extractText).
func extractMessageFields(raw []byte) (role, text, model, timestamp string) {
        if len(raw) == 0 {
                return
        }
        var msg struct {
                Role      string          `json:"role"`
                Content   json.RawMessage `json:"content"`
                Provider  string          `json:"provider"`
                Model     string          `json:"model"`
                Timestamp string          `json:"timestamp"`
        }
        if err := json.Unmarshal(raw, &msg); err != nil {
                return
        }
        role = msg.Role
        model = msg.Model
        timestamp = msg.Timestamp
        // content: string OR array of {text: string} | string parts
        if len(msg.Content) > 0 {
                if msg.Content[0] == '"' {
                        var s string
                        if err := json.Unmarshal(msg.Content, &s); err == nil {
                                text = s
                        }
                } else if msg.Content[0] == '[' {
                        var parts []json.RawMessage
                        if err := json.Unmarshal(msg.Content, &parts); err == nil {
                                var b strings.Builder
                                for _, p := range parts {
                                        if len(p) > 0 && p[0] == '"' {
                                                var s string
                                                if err := json.Unmarshal(p, &s); err == nil {
                                                        if b.Len() > 0 {
                                                                b.WriteString("\n")
                                                        }
                                                        b.WriteString(s)
                                                }
                                                continue
                                        }
                                        var obj struct {
                                                Text string `json:"text"`
                                        }
                                        if err := json.Unmarshal(p, &obj); err == nil && obj.Text != "" {
                                                if b.Len() > 0 {
                                                        b.WriteString("\n")
                                                }
                                                b.WriteString(obj.Text)
                                        }
                                }
                                text = b.String()
                        }
                }
        }
        // Strip runtime reminders injected into user messages.
        text = stripRuntimeReminders(text)
        return
}

func stripRuntimeReminders(text string) string {
        for {
                start := strings.Index(text, "<system-reminder>")
                if start < 0 {
                        break
                }
                end := strings.Index(text[start:], "</system-reminder>")
                if end < 0 {
                        break
                }
                text = text[:start] + text[start+end+len("</system-reminder>"):]
        }
        return strings.TrimSpace(text)
}

// ---------------------------------------------------------------------------
// toSession: render a stored session as an AgentSession map
// ---------------------------------------------------------------------------

func (a *minimaxAdapter) toSession(s minimaxStoredSession) (map[string]interface{}, error) {
        title := deriveTitle(s)
        lastMessage := deriveLastMessage(s)
        status := "idle"
        updatedAt := time.UnixMilli(s.UpdatedAtMs).UTC().Format(time.RFC3339)
        return agentSession(s.ID, title, status, a.cwd, updatedAt, "minimax://"+s.ID, map[string]interface{}{
                "unread":          false,
                "working":         false,
                "stopVisible":     false,
                "lastMessageText": lastMessage,
                "createdAt":       time.UnixMilli(s.CreatedAtMs).UTC().Format(time.RFC3339),
        }), nil
}

// deriveTitle reads the first user message from messages.jsonl (head window)
// and truncates it. Mirrors src/adapters/minimax-code.ts title derivation.
func deriveTitle(s minimaxStoredSession) string {
        path := filepath.Join(s.Dir, "messages.jsonl")
        head, err := readTextWindow(path, titleWindowBytes, false)
        if err != nil || head == "" {
                head, _ = readTextWindow(path, titleFallbackBytes, false)
        }
        if head == "" {
                return s.Manifest.Layout
        }
        for _, line := range strings.Split(head, "\n") {
                line = strings.TrimSpace(line)
                if line == "" || !strings.HasPrefix(line, "{") {
                        continue
                }
                var rec minimaxMessageRecord
                if err := json.Unmarshal([]byte(line), &rec); err != nil {
                        continue
                }
                role, text, _, _ := extractMessageFields(rec.Message)
                if role != "user" || strings.TrimSpace(text) == "" {
                        continue
                }
                return truncate(text, maxTitleLength)
        }
        return s.Manifest.Layout
}

func deriveLastMessage(s minimaxStoredSession) string {
        path := filepath.Join(s.Dir, "messages.jsonl")
        tail, err := readTextWindow(path, tailWindowBytes, true)
        if err != nil || tail == "" {
                return ""
        }
        lines := strings.Split(tail, "\n")
        for i := len(lines) - 1; i >= 0; i-- {
                line := strings.TrimSpace(lines[i])
                if line == "" || !strings.HasPrefix(line, "{") {
                        continue
                }
                var rec minimaxMessageRecord
                if err := json.Unmarshal([]byte(line), &rec); err != nil {
                        continue
                }
                _, text, _, _ := extractMessageFields(rec.Message)
                if strings.TrimSpace(text) == "" {
                        continue
                }
                return truncate(text, maxLastMessageLength)
        }
        return ""
}

func readTextWindow(path string, maxBytes int64, fromEnd bool) (string, error) {
        f, err := os.Open(path)
        if err != nil {
                return "", err
        }
        defer f.Close()
        info, err := f.Stat()
        if err != nil {
                return "", err
        }
        length := maxBytes
        if info.Size() < length {
                length = info.Size()
        }
        if length <= 0 {
                return "", nil
        }
        buf := make([]byte, length)
        var pos int64
        if fromEnd {
                pos = info.Size() - length
                if pos < 0 {
                        pos = 0
                }
        }
        n, err := f.ReadAt(buf, pos)
        if err != nil && !errors.Is(err, io.EOF) {
                return "", err
        }
        return string(buf[:n]), nil
}

func truncate(value string, limit int) string {
        flat := strings.TrimSpace(strings.Join(strings.Fields(value), " "))
        if len(flat) <= limit {
                return flat
        }
        return flat[:limit-1] + "…"
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

func main() {
        adapter := newAdapter()
        if err := ahap.Serve(adapter); err != nil {
                fmt.Fprintln(os.Stderr, "[minimax-code-adapter] fatal:", err)
                os.Exit(1)
        }
}

// silence unused-import for the http/sha256 packages we will need in Phase B
var (
        _ = http.MethodPost
        _ = sha256.New
        _ = context.Background
        _ = base64.StdEncoding
)
