package notepad

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"note/model"
)

func TestSaveVersionRejectsStaleBrowserWithoutChangingDocument(t *testing.T) {
	s, r := testServer(t)
	owner := createNote(t, r, "versioned")
	other := request(r, "POST", "/versioned/unlock", url.Values{"secret": {"apple"}}).Result().Cookies()
	// Both browsers start with the same version, even when saves share a timestamp.
	now := time.Now()
	s.Now = func() time.Time { return now }
	for _, cookies := range [][]*http.Cookie{owner, other} {
		w := request(r, "GET", "/versioned/edit", nil, cookies...)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `data-version="1"`) {
			t.Fatalf("initial version: %d %s", w.Code, w.Body.String())
		}
	}
	w := request(r, "POST", "/versioned", url.Values{"version": {"1"}, "text": {"first browser"}}, owner...)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"version":2`) {
		t.Fatalf("first save: %d %s", w.Code, w.Body.String())
	}
	w = request(r, "POST", "/versioned", url.Values{
		"version": {"1"}, "text": {"stale browser"}, "title": {"stale title"},
		"secret": {"orange"}, "is_private": {"1"}, "view_secret": {"guest"}, "document_type": {"code"},
	}, other...)
	if w.Code != 409 || !strings.Contains(w.Body.String(), `"code":"version_conflict"`) {
		t.Fatalf("stale save: %d %s", w.Code, w.Body.String())
	}
	var n model.NotepadModel
	if err := s.DB.Where("slug = ?", "versioned").First(&n).Error; err != nil {
		t.Fatal(err)
	}
	if n.Text != "first browser" || n.Title != "My title" || n.Secret != "apple" || n.IsPrivate != 0 || n.ViewSecret != "" || n.DocumentType != "markdown" || n.Version != 2 {
		t.Fatalf("stale save changed document: %+v", n)
	}
	// Reloading obtains the new version; the stale attempt did not revoke authorization.
	w = request(r, "GET", "/versioned/edit", nil, other...)
	if !strings.Contains(w.Body.String(), `data-version="2"`) {
		t.Fatal("reload did not expose current version")
	}
	w = request(r, "POST", "/versioned", url.Values{"version": {"2"}, "text": {"second browser"}}, other...)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"version":3`) {
		t.Fatalf("fresh save: %d %s", w.Code, w.Body.String())
	}
	if err := model.Migrate(s.DB); err != nil {
		t.Fatal(err)
	}
	s.DB.First(&n, n.Id)
	if n.Version != 3 {
		t.Fatal("migration reset existing version")
	}
}

func TestSaveRequiresValidVersion(t *testing.T) {
	s, r := testServer(t)
	owner := createNote(t, r, "required")
	for _, tc := range []struct {
		version string
		status  int
	}{{"", 428}, {"0", 400}, {"-1", 400}, {"invalid", 400}, {"1.5", 400}, {"9223372036854775808", 400}, {"2", 409}} {
		t.Run(fmt.Sprintf("version=%s", tc.version), func(t *testing.T) {
			w := request(r, "POST", "/required", url.Values{"version": {tc.version}, "text": {"must not save"}}, owner...)
			if w.Code != tc.status {
				t.Fatalf("status: %d %s", w.Code, w.Body.String())
			}
		})
	}
	var n model.NotepadModel
	s.DB.Where("slug = ?", "required").First(&n)
	if n.Version != 1 || n.Text != "# Hello" {
		t.Fatalf("invalid request changed document: %+v", n)
	}
}

func TestConcurrentSavesOfSameVersionOnlyOneSucceeds(t *testing.T) {
	s, r := testServer(t)
	owner := createNote(t, r, "concurrent-save")
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func(i int) {
			results <- request(r, "POST", "/concurrent-save", url.Values{"version": {"1"}, "text": {fmt.Sprintf("browser %d", i)}}, owner...).Code
		}(i)
	}
	counts := map[int]int{}
	for i := 0; i < 2; i++ {
		counts[<-results]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("concurrent responses: %v", counts)
	}
	var n model.NotepadModel
	s.DB.Where("slug = ?", "concurrent-save").First(&n)
	if n.Version != 2 {
		t.Fatalf("version = %d", n.Version)
	}
}

func TestCreateReturnsInitialVersion(t *testing.T) {
	_, r := testServer(t)
	w := request(r, "POST", "/api/notes", url.Values{"slug": {"initial-version"}, "secret": {"apple"}, "document_type": {"markdown"}})
	var result struct {
		Version int64 `json:"version"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != 201 || result.Version != 1 {
		t.Fatalf("create: %d %s (%v)", w.Code, w.Body.String(), err)
	}
}
