package notepad

import (
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"note/model"
)

func testServer(t *testing.T) (*Server, *gin.Engine) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { sqlDB.Close() })
	if err = model.Migrate(db); err != nil {
		t.Fatal(err)
	}
	s := NewServer(db)
	r := gin.New()
	r.SetHTMLTemplate(template.Must(template.ParseGlob("../../templates/*.html")))
	s.RegisterRoutes(r)
	return s, r
}

func request(r http.Handler, method, path string, data url.Values, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(data.Encode()))
	if method == "POST" {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("X-Notepad-Request", "1")
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	r.ServeHTTP(w, req)
	return w
}

func createNote(t *testing.T, r http.Handler, tag string) []*http.Cookie {
	t.Helper()
	w := request(r, "POST", "/api/notes", url.Values{"tag": {tag}, "title": {"My title"}, "text": {"# Hello"}, "document_type": {"markdown"}, "secret": {"apple"}})
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	return w.Result().Cookies()
}

func TestPublicLinkCannotWriteAndDoesNotExposeSecret(t *testing.T) {
	_, r := testServer(t)
	owner := createNote(t, r, "public-note")
	w := request(r, "GET", "/public-note", nil, owner...)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "My title") {
		t.Fatalf("viewer: %d", w.Code)
	}
	if strings.Contains(w.Body.String(), "apple") || strings.Contains(w.Body.String(), "$2a$") || strings.Contains(w.Body.String(), `data-editable="true"`) {
		t.Fatal("public view exposes editor/secret")
	}
	w = request(r, "POST", "/public-note", url.Values{"text": {"hacked"}})
	if w.Code != 403 {
		t.Fatalf("unauthorized save = %d", w.Code)
	}
	w = request(r, "POST", "/public-note", url.Values{"title": {"Changed"}, "text": {"saved"}, "document_type": {"text"}}, owner...)
	if w.Code != 200 {
		t.Fatalf("owner save: %d %s", w.Code, w.Body.String())
	}
	w = request(r, "GET", "/public-note/raw", nil)
	if w.Body.String() != "saved" {
		t.Fatalf("raw = %q", w.Body.String())
	}
}

func TestBrowserGrantAndSecretRotation(t *testing.T) {
	_, r := testServer(t)
	owner := createNote(t, r, "rotate-note")
	w := request(r, "POST", "/rotate-note/unlock", url.Values{"secret": {"apple"}})
	if w.Code != 200 {
		t.Fatalf("unlock: %d", w.Code)
	}
	other := w.Result().Cookies()
	w = request(r, "GET", "/rotate-note/edit", nil, other...)
	if !strings.Contains(w.Body.String(), `data-editable="true"`) {
		t.Fatal("browser not remembered")
	}
	w = request(r, "POST", "/rotate-note", url.Values{"text": {"rotated"}, "document_type": {"markdown"}, "secret": {"orange"}}, owner...)
	if w.Code != 200 {
		t.Fatalf("rotate = %d %s", w.Code, w.Body.String())
	}
	w = request(r, "POST", "/rotate-note", url.Values{"text": {"bad"}}, other...)
	if w.Code != 403 {
		t.Fatalf("old browser still authorized: %d", w.Code)
	}
	w = request(r, "POST", "/rotate-note", url.Values{"text": {"good"}}, owner...)
	if w.Code != 200 {
		t.Fatalf("current browser lost access: %d", w.Code)
	}
}

func TestTenFailuresLockOwnerAndManualUnlock(t *testing.T) {
	s, r := testServer(t)
	owner := createNote(t, r, "locked-note")
	now := time.Date(2026, 10, 15, 4, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	for i := 1; i <= 10; i++ {
		w := request(r, "POST", "/locked-note/unlock", url.Values{"secret": {"wrong"}})
		expected := 403
		if i == 10 {
			expected = 423
		}
		if w.Code != expected {
			t.Fatalf("attempt %d = %d (%s)", i, w.Code, w.Body.String())
		}
	}
	w := request(r, "POST", "/locked-note", url.Values{"text": {"owner save"}}, owner...)
	if w.Code != 423 {
		t.Fatalf("owner bypassed lock: %d", w.Code)
	}
	w = request(r, "GET", "/locked-note", nil)
	if w.Code != 200 {
		t.Fatal("lock prevented reading")
	}
	var n model.NotepadModel
	s.DB.Where("slug = ?", "locked-note").First(&n)
	expected := time.Date(2026, 10, 15, 16, 0, 0, 0, time.UTC).Unix()
	if n.Locked != expected {
		t.Fatalf("lock until %d, want %d", n.Locked, expected)
	}
	s.DB.Model(&n).Update("locked", 0)
	w = request(r, "POST", "/locked-note/unlock", url.Values{"secret": {"apple"}})
	if w.Code != 200 {
		t.Fatalf("SQL unlock failed: %d", w.Code)
	}
	s.DB.First(&n, n.Id)
	if n.FailedAttempts != 0 {
		t.Fatal("SQL unlock did not reset exhausted attempts")
	}
}

func TestLockExpiresAtShanghaiMidnightAndCounterPersists(t *testing.T) {
	s, r := testServer(t)
	owner := createNote(t, r, "expiry-note")
	now := time.Date(2026, 10, 15, 15, 59, 59, 0, time.UTC)
	s.Now = func() time.Time { return now }
	for i := 0; i < 10; i++ {
		request(r, "POST", "/expiry-note/unlock", url.Values{"secret": {"wrong"}})
	}
	// A fresh handler instance shares the same database counters, including across restarts.
	fresh := NewServer(s.DB)
	fresh.Now = s.Now
	rr := gin.New()
	fresh.RegisterRoutes(rr)
	w := request(rr, "POST", "/expiry-note", url.Values{"text": {"bad"}}, owner...)
	if w.Code != 423 {
		t.Fatalf("restart bypassed lock: %d", w.Code)
	}
	now = now.Add(time.Second)
	w = request(r, "POST", "/expiry-note", url.Values{"text": {"after midnight"}}, owner...)
	if w.Code != 200 {
		t.Fatalf("midnight did not unlock: %d %s", w.Code, w.Body.String())
	}
}

func TestMigrationKeepsLegacyTextAndSetsTwinsOnlyOnce(t *testing.T) {
	s, r := testServer(t)
	s.DB.Exec("INSERT INTO notepad (slug,text,secret,document_type) VALUES (?,?,?,?)", "legacy", "old body", "", "")
	if err := model.Migrate(s.DB); err != nil {
		t.Fatal(err)
	}
	var n model.NotepadModel
	s.DB.Where("slug = ?", "legacy").First(&n)
	if n.DocumentType != "text" || n.Text != "old body" {
		t.Fatalf("bad migration: %+v", n)
	}
	w := request(r, "POST", "/legacy/unlock", url.Values{"secret": {"twins"}})
	if w.Code != 200 {
		t.Fatalf("legacy secret: %d", w.Code)
	}
	c := w.Result().Cookies()
	w = request(r, "POST", "/legacy", url.Values{"secret": {"custom"}, "text": {"old body"}}, c...)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if err := model.Migrate(s.DB); err != nil {
		t.Fatal(err)
	}
	w = request(r, "POST", "/legacy/unlock", url.Values{"secret": {"custom"}})
	if w.Code != 200 {
		t.Fatal("migration overwrote custom secret")
	}
}

func TestCreateValidationAndCSRF(t *testing.T) {
	_, r := testServer(t)
	for _, data := range []url.Values{
		{"tag": {"bad"}, "secret": {"abc"}, "document_type": {"markdown"}},
		{"tag": {"bad"}, "secret": {"apple"}, "document_type": {"html"}},
		{"tag": {"bad"}, "secret": {"apple"}, "title": {strings.Repeat("a", 201)}, "document_type": {"markdown"}},
	} {
		w := request(r, "POST", "/api/notes", data)
		if w.Code != 400 {
			t.Fatalf("bad input = %d", w.Code)
		}
	}
	createNote(t, r, "unique-note")
	w := request(r, "POST", "/api/notes", url.Values{"tag": {"unique-note"}, "secret": {"apple"}, "document_type": {"markdown"}})
	if w.Code != 409 {
		t.Fatalf("duplicate = %d", w.Code)
	}
	req := httptest.NewRequest("POST", "/unique-note/unlock", strings.NewReader("secret=apple"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	out := httptest.NewRecorder()
	r.ServeHTTP(out, req)
	if out.Code != 403 {
		t.Fatal("missing request header accepted")
	}
	req = httptest.NewRequest("POST", "/unique-note/unlock", strings.NewReader("secret=apple"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-Notepad-Request", "1")
	req.Header.Set("Origin", "https://evil.test")
	out = httptest.NewRecorder()
	r.ServeHTTP(out, req)
	if out.Code != 403 {
		t.Fatal("cross origin accepted")
	}
}

func TestRandomSecret(t *testing.T) {
	_, r := testServer(t)
	w := request(r, "GET", "/api/secret", nil)
	var data map[string]string
	json.Unmarshal(w.Body.Bytes(), &data)
	secret := data["secret"]
	if len(secret) < 4 {
		t.Fatalf("short word %q", secret)
	}
	for _, c := range secret {
		if c < 'a' || c > 'z' {
			t.Fatal(fmt.Sprintf("not an English word: %q", secret))
		}
	}
}

func TestMigrationFromOriginalSchema(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	defer conn.Close()
	if err = db.Exec(`CREATE TABLE notepad (id INTEGER PRIMARY KEY, tag TEXT, text TEXT, create_time TEXT, update_time TEXT)`).Error; err != nil {
		t.Fatal(err)
	}
	db.Exec("INSERT INTO notepad (tag,text) VALUES (?,?)", "旧笔记", "legacy content")
	if err = model.Migrate(db); err != nil {
		t.Fatal(err)
	}
	var n model.NotepadModel
	db.First(&n)
	if n.DocumentType != "text" || n.Secret == "" || n.Text != "legacy content" || n.Locked != 0 {
		t.Fatalf("legacy migration lost data: %+v", n)
	}
	s := NewServer(db)
	r := gin.New()
	r.SetHTMLTemplate(template.Must(template.ParseGlob("../../templates/*.html")))
	s.RegisterRoutes(r)
	w := request(r, "POST", "/"+url.PathEscape("旧笔记")+"/unlock", url.Values{"secret": {"twins"}})
	if w.Code != 200 {
		t.Fatalf("legacy unicode URL inaccessible: %d %s", w.Code, w.Body.String())
	}
}

func TestMigrationRejectsDuplicateTagsWithoutDeletingData(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	defer conn.Close()
	db.Exec("CREATE TABLE notepad (id INTEGER PRIMARY KEY, tag TEXT, text TEXT)")
	db.Exec("INSERT INTO notepad (tag,text) VALUES ('same','one'), ('same','two')")
	if err = model.Migrate(db); err == nil {
		t.Fatal("ambiguous duplicate tags migrated")
	}
	var count int64
	db.Table("notepad").Count(&count)
	if count != 2 {
		t.Fatal("migration deleted historical data")
	}
}

func TestSuccessfulUnlockDoesNotResetDailyFailures(t *testing.T) {
	s, r := testServer(t)
	createNote(t, r, "cumulative")
	for i := 0; i < 9; i++ {
		request(r, "POST", "/cumulative/unlock", url.Values{"secret": {"wrong"}})
	}
	w := request(r, "POST", "/cumulative/unlock", url.Values{"secret": {"apple"}})
	if w.Code != 200 {
		t.Fatalf("correct key failed: %d", w.Code)
	}
	w = request(r, "POST", "/cumulative/unlock", url.Values{"secret": {"wrong"}})
	if w.Code != 423 {
		t.Fatalf("success cleared cumulative failures: %d", w.Code)
	}
	var n model.NotepadModel
	s.DB.Where("slug = ?", "cumulative").First(&n)
	if n.FailedAttempts != 10 {
		t.Fatal(n.FailedAttempts)
	}
}

func TestGrantExpiryAndPlainTextSwitchPreserveContent(t *testing.T) {
	s, r := testServer(t)
	owner := createNote(t, r, "type-switch")
	text := "# Heading\n\n**keep** <script>hello</script>"
	w := request(r, "POST", "/type-switch", url.Values{"text": {text}, "document_type": {"text"}}, owner...)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = request(r, "GET", "/type-switch/raw", nil)
	if w.Body.String() != text {
		t.Fatal("type switch altered content")
	}
	w = request(r, "GET", "/type-switch", nil)
	if !strings.Contains(w.Body.String(), "&lt;script&gt;hello&lt;/script&gt;") {
		t.Fatal("plain text viewer not escaped")
	}
	s.Now = func() time.Time { return time.Now().Add(grantAge + time.Minute) }
	w = request(r, "POST", "/type-switch", url.Values{"text": {"expired"}}, owner...)
	if w.Code != 403 {
		t.Fatalf("expired browser grant authorized: %d", w.Code)
	}
}

func TestConcurrentFailuresCannotBypassGlobalLock(t *testing.T) {
	s, r := testServer(t)
	owner := createNote(t, r, "parallel-note")
	results := make(chan int, 10)
	for i := 0; i < 10; i++ {
		go func() { results <- request(r, "POST", "/parallel-note/unlock", url.Values{"secret": {"wrong"}}).Code }()
	}
	locked := 0
	for i := 0; i < 10; i++ {
		code := <-results
		if code == 423 {
			locked++
		} else if code != 403 {
			t.Fatalf("failure request = %d", code)
		}
	}
	if locked != 1 {
		t.Fatalf("expected one tenth-attempt lock, got %d", locked)
	}
	var n model.NotepadModel
	s.DB.Where("slug = ?", "parallel-note").First(&n)
	if n.FailedAttempts != 10 || n.Locked <= s.Now().Unix() {
		t.Fatalf("lost concurrent failures: %+v", n)
	}
	if w := request(r, "POST", "/parallel-note", url.Values{"secret": {"newkey"}}, owner...); w.Code != 423 {
		t.Fatal("secret rotation bypassed lock")
	}
}

func TestHistoricalTagIsEscapedInEditURLs(t *testing.T) {
	_, r := testServer(t)
	tag := "old#文档"
	w := request(r, "POST", "/api/notes", url.Values{"tag": {tag}, "secret": {"apple"}, "document_type": {"markdown"}})
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var result map[string]string
	json.Unmarshal(w.Body.Bytes(), &result)
	if result["edit_url"] != "/"+url.PathEscape(tag)+"/edit" {
		t.Fatalf("unsafe edit url: %q", result["edit_url"])
	}
}

func TestSuccessfulUnlockRefreshesBrowserCookie(t *testing.T) {
	s, r := testServer(t)
	now := time.Now().Truncate(time.Second)
	s.Now = func() time.Time { return now }
	owner := createNote(t, r, "cookie-first")
	createNote(t, r, "cookie-second")
	now = now.Add(grantAge - time.Hour)
	w := request(r, "POST", "/cookie-second/unlock", url.Values{"secret": {"apple"}}, owner...)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("successful authorization did not renew browser cookie")
	}
	c := cookies[0]
	if c.Value != owner[0].Value || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.MaxAge != int(grantAge.Seconds()) || !c.Expires.Equal(now.Add(grantAge)) {
		t.Fatalf("invalid renewed cookie: %+v", c)
	}
}

func TestSecretRotationRefreshesBrowserCookie(t *testing.T) {
	s, r := testServer(t)
	now := time.Now().Truncate(time.Second)
	s.Now = func() time.Time { return now }
	owner := createNote(t, r, "cookie-rotation")
	now = now.Add(grantAge - time.Hour)
	w := request(r, "POST", "/cookie-rotation", url.Values{"secret": {"orange"}}, owner...)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) == 0 || !cookies[0].Expires.Equal(now.Add(grantAge)) {
		t.Fatal("secret rotation did not renew current browser cookie")
	}
}

func TestSavingUnchangedSecretKeepsOtherBrowserAuthorized(t *testing.T) {
	s, r := testServer(t)
	owner := createNote(t, r, "same-secret")
	w := request(r, "POST", "/same-secret/unlock", url.Values{"secret": {"apple"}})
	other := w.Result().Cookies()
	var before model.NotepadModel
	s.DB.Where("slug = ?", "same-secret").First(&before)
	w = request(r, "POST", "/same-secret", url.Values{"secret": {"apple"}, "text": {"updated"}}, owner...)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var after model.NotepadModel
	s.DB.First(&after, before.Id)
	if before.Secret != after.Secret {
		t.Fatal("unchanged secret was replaced")
	}
	w = request(r, "POST", "/same-secret", url.Values{"text": {"other browser"}}, other...)
	if w.Code != 200 {
		t.Fatalf("unchanged secret revoked another browser: %d", w.Code)
	}
}

func TestUnlockPlaintext(t *testing.T) {
	s, r := testServer(t)
	// Plaintext secret
	notePlain := model.NotepadModel{
		Slug:         "plain-note",
		Title:        "Plain Note",
		Text:         "Plain Content",
		DocumentType: "markdown",
		Secret:       "mysecret123",
	}
	if err := s.DB.Create(&notePlain).Error; err != nil {
		t.Fatal(err)
	}
	w := request(r, "POST", "/plain-note/unlock", url.Values{"secret": {"mysecret123"}})
	if w.Code != 200 {
		t.Fatalf("plain unlock failed: %d", w.Code)
	}
}

func TestCodeDocumentType(t *testing.T) {
	_, r := testServer(t)
	w := request(r, "POST", "/api/notes", url.Values{
		"tag":           {"code-test"},
		"title":         {"Code Example"},
		"text":          {"fmt.Println(\"Hello, World!\")"},
		"document_type": {"code"},
		"secret":        {"code-secret"},
	})
	if w.Code != 201 {
		t.Fatalf("create code note failed: %d %s", w.Code, w.Body.String())
	}
	cookies := w.Result().Cookies()

	// View page
	w = request(r, "GET", "/code-test", nil)
	if w.Code != 200 {
		t.Fatalf("view code note failed: %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, `data-kind="code"`) {
		t.Fatalf("expected data-kind=code in view page, got body: %s", body)
	}
	if !strings.Contains(body, "fmt.Println(&#34;Hello, World!&#34;)") && !strings.Contains(body, "fmt.Println(\"Hello, World!\")") {
		t.Fatalf("expected code content in view page")
	}
	if !strings.Contains(body, `id="reader-copy-content"`) || !strings.Contains(body, `id="reader-copy-link"`) {
		t.Fatalf("expected reader copy buttons in view page")
	}

	// Update to another code text
	w = request(r, "POST", "/code-test", url.Values{
		"title":         {"Updated Code"},
		"text":          {"function add(a, b) { return a + b; }"},
		"document_type": {"code"},
	}, cookies...)
	if w.Code != 200 {
		t.Fatalf("update code note failed: %d %s", w.Code, w.Body.String())
	}

	// Verify raw endpoint
	w = request(r, "GET", "/code-test/raw", nil)
	if w.Body.String() != "function add(a, b) { return a + b; }" {
		t.Fatalf("raw code content mismatch: %q", w.Body.String())
	}
}

