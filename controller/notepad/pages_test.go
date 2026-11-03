package notepad

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"note/model"
	"note/pkg/middleware"
)

func pageFixture(t *testing.T) (*Server, http.Handler, model.NotepadModel, model.NotepadModel, []*http.Cookie) {
	t.Helper()
	s, r := testServer(t)
	owner := createNote(t, r, "target")
	var target model.NotepadModel
	s.DB.Where("slug = ?", "target").First(&target)
	w := request(r, "POST", "/api/notes", url.Values{"tag": {"source"}, "secret": {"apple"}, "document_type": {"markdown"}, "text": {fmt.Sprintf("[[page:%d]] ![[page:%d]]", target.Id, target.Id)}}, owner...)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var source model.NotepadModel
	s.DB.Where("slug = ?", "source").First(&source)
	return s, r, target, source, owner
}

func TestPageReferencesFollowCreateSaveAndModes(t *testing.T) {
	s, r, target, source, owner := pageFixture(t)
	count := func(want int64) {
		t.Helper()
		var got int64
		if err := s.DB.Model(&model.NoteLink{}).Where("source_note_id = ?", source.Id).Count(&got).Error; err != nil || got != want {
			t.Fatalf("edges=%d want=%d err=%v", got, want, err)
		}
	}
	count(2)
	w := request(r, "POST", "/source", url.Values{"text": {fmt.Sprintf("[[page:%d]] [[page:%d]] [[page:2147483647]]", target.Id, target.Id)}}, owner...)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	count(1)
	w = request(r, "POST", "/source", url.Values{"text": {"removed"}})
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	count(1)
	w = request(r, "POST", "/source", url.Values{"document_type": {"code"}}, owner...)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	count(0)
	w = request(r, "POST", "/source", url.Values{"document_type": {"markdown"}}, owner...)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	count(1)
	w = request(r, "POST", "/source", url.Values{"text": {""}}, owner...)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	count(0)
}

func TestPageReadResolveStableRouteAndSafeDTO(t *testing.T) {
	s, r, target, _, _ := pageFixture(t)
	for _, path := range []string{fmt.Sprintf("/api/pages/%d", target.Id), "/api/pages/resolve?slug=target"} {
		w := request(r, "GET", path, nil)
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result["id"] != float64(target.Id) || result["title"] != "My title" || result["text"] != "# Hello" {
			t.Fatal(result)
		}
		for _, key := range []string{"secret", "view_secret", "failed_attempts", "failure_day"} {
			if _, ok := result[key]; ok {
				t.Fatalf("leaked %s", key)
			}
		}
		if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
			t.Fatal("response must not be cached")
		}
	}
	s.DB.Model(&target).Updates(map[string]any{"title": "Renamed", "slug": "new-address"})
	w := request(r, "GET", fmt.Sprintf("/api/pages/%d/view", target.Id), nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Renamed") {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(r, "GET", fmt.Sprintf("/api/pages/%d", target.Id), nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Renamed") {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, id := range []string{"0", "-1", "01", "2147483648", "no"} {
		if w := request(r, "GET", "/api/pages/"+id, nil); w.Code != 404 {
			t.Fatalf("%s: %d", id, w.Code)
		}
	}
}

func TestPagePrivacyAndBacklinks(t *testing.T) {
	s, r, target, source, owner := pageFixture(t)
	s.DB.Model(&source).Updates(map[string]any{"title": "Hidden source", "is_private": 1})
	backlinks := fmt.Sprintf("/api/pages/%d/backlinks", target.Id)
	w := request(r, "GET", backlinks, nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "Hidden source") || strings.Contains(w.Body.String(), "source") {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(r, "GET", backlinks, nil, owner...)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Hidden source") {
		t.Fatal(w.Code, w.Body.String())
	}
	s.DB.Model(&target).Updates(map[string]any{"is_private": 1, "view_secret": "viewer"})
	for _, path := range []string{fmt.Sprintf("/api/pages/%d", target.Id), "/api/pages/resolve?slug=target", backlinks} {
		w = request(r, "GET", path, nil)
		if w.Code != 403 || strings.Contains(w.Body.String(), "My title") || strings.Contains(w.Body.String(), "Hello") {
			t.Fatal(path, w.Code, w.Body.String())
		}
	}
	w = request(r, "GET", fmt.Sprintf("/api/pages/%d/view", target.Id), nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "# Hello") {
		t.Fatal(w.Code, w.Body.String())
	}
	viewer := request(r, "POST", "/target/unlock", url.Values{"secret": {"viewer"}}).Result().Cookies()
	w = request(r, "GET", fmt.Sprintf("/api/pages/%d", target.Id), nil, viewer...)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "# Hello") {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(r, "GET", backlinks, nil, viewer...)
	if w.Code != 200 || strings.Contains(w.Body.String(), "Hidden source") {
		t.Fatal(w.Code, w.Body.String())
	}
	s.DB.Model(&target).Update("view_secret", "changed")
	w = request(r, "GET", fmt.Sprintf("/api/pages/%d", target.Id), nil, viewer...)
	if w.Code != 403 {
		t.Fatal("revoked viewer access", w.Code)
	}
}

func TestPageReferenceIndexRollsBackWithSave(t *testing.T) {
	s, r, _, source, owner := pageFixture(t)
	if err := s.DB.Exec("CREATE TRIGGER reject_link_delete BEFORE DELETE ON note_links BEGIN SELECT RAISE(ABORT, 'test failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	w := request(r, "POST", "/source", url.Values{"text": {"must rollback"}}, owner...)
	if w.Code != 500 {
		t.Fatal(w.Code, w.Body.String())
	}
	var got model.NotepadModel
	s.DB.First(&got, source.Id)
	if got.Text != source.Text {
		t.Fatal("source text committed without reference index")
	}
}

func TestExpectedReferenceMissesDoNotTriggerProductionScanBan(t *testing.T) {
	s, _, target, _, _ := pageFixture(t)
	r := gin.New()
	r.Use(middleware.NewIPScanBanLimiter(10, time.Minute, 10*time.Minute).Middleware())
	s.RegisterRoutes(r)
	for i := 0; i < 15; i++ {
		w := request(r, "GET", fmt.Sprintf("/api/pages/%d", 10000+i), nil)
		if w.Code != 404 {
			t.Fatalf("expected resource miss, got %d: %s", w.Code, w.Body.String())
		}
	}
	w := request(r, "GET", fmt.Sprintf("/api/pages/%d", target.Id), nil)
	if w.Code != 200 {
		t.Fatal("legitimate reader was banned", w.Code, w.Body.String())
	}
}

func TestBacklinksFilterPrivateSourcesInBoundedQueries(t *testing.T) {
	s, r, target, _, owner := pageFixture(t)
	for i := 0; i < 120; i++ {
		n := model.NotepadModel{Slug: fmt.Sprintf("hidden-%d", i), Title: "Hidden", IsPrivate: 1, Secret: "other"}
		if err := s.DB.Create(&n).Error; err != nil {
			t.Fatal(err)
		}
		if err := s.DB.Create(&model.NoteLink{SourceNoteID: n.Id, TargetNoteID: target.Id, Kind: "link"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	queries := 0
	if err := s.DB.Callback().Query().Before("gorm:query").Register("test:count-backlink-queries", func(_ *gorm.DB) { queries++ }); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.DB.Callback().Query().Remove("test:count-backlink-queries") })
	w := request(r, "GET", fmt.Sprintf("/api/pages/%d/backlinks", target.Id), nil, owner...)
	if w.Code != 200 || strings.Contains(w.Body.String(), "Hidden") {
		t.Fatal(w.Code, w.Body.String())
	}
	if queries > 4 {
		t.Fatalf("backlinks issued %d queries for hidden sources", queries)
	}
}

func TestReferenceBackfillRetriesAfterFailure(t *testing.T) {
	s, _, _, source, _ := pageFixture(t)
	if err := s.DB.Migrator().DropTable(&model.NoteLink{}, "data_migrations"); err != nil {
		t.Fatal(err)
	}
	if err := s.DB.AutoMigrate(&model.NoteLink{}); err != nil {
		t.Fatal(err)
	}
	if err := s.DB.Exec("CREATE TRIGGER fail_backfill BEFORE INSERT ON note_links BEGIN SELECT RAISE(ABORT, 'test failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if err := model.Migrate(s.DB); err == nil {
		t.Fatal("expected backfill error")
	}
	if err := s.DB.Exec("DROP TRIGGER fail_backfill").Error; err != nil {
		t.Fatal(err)
	}
	if err := model.Migrate(s.DB); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := s.DB.Model(&model.NoteLink{}).Where("source_note_id = ?", source.Id).Count(&count).Error; err != nil || count != 2 {
		t.Fatalf("backfill edges=%d err=%v", count, err)
	}
}
