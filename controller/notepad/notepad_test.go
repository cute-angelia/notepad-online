package notepad

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestProcessHandleValidations(t *testing.T) {
	_, r := testServer(t)

	// Case 1: Reserved tag "favicon.ico"
	w1 := httptest.NewRecorder()
	req1, _ := http.NewRequest(http.MethodGet, "/favicon.ico", nil)
	r.ServeHTTP(w1, req1)
	if w1.Code != http.StatusNotFound {
		t.Errorf("expected 404 for favicon.ico, got %d", w1.Code)
	}

	// Case 2: Reserved tag "robots.txt"
	w2 := httptest.NewRecorder()
	req2, _ := http.NewRequest(http.MethodGet, "/robots.txt", nil)
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusNotFound {
		t.Errorf("expected 404 for robots.txt, got %d", w2.Code)
	}

	// Case 3: Overly long slug (> 32 characters)
	longSlug := strings.Repeat("a", 33)
	w3 := httptest.NewRecorder()
	req3, _ := http.NewRequest(http.MethodGet, "/"+longSlug, nil)
	r.ServeHTTP(w3, req3)
	if w3.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for overly long slug, got %d", w3.Code)
	}

	// Case 4: Overly long text payload (> 100,000 characters)
	longText := strings.Repeat("x", 100001)
	form := url.Values{}
	form.Set("text", longText)
	w4 := httptest.NewRecorder()
	req4, _ := http.NewRequest(http.MethodPost, "/testnote", strings.NewReader(form.Encode()))
	req4.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req4.Header.Set("X-Notepad-Request", "1")
	r.ServeHTTP(w4, req4)
	if w4.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for text exceeding max limit, got %d", w4.Code)
	}
}

func TestRawHandleReserved(t *testing.T) {
	_, r := testServer(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/favicon.ico/raw", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for favicon.ico/raw, got %d", w.Code)
	}
}

func TestMarkdownHandleReserved(t *testing.T) {
	_, r := testServer(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/robots.txt/md", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for robots.txt/md, got %d", w.Code)
	}
}

func TestRobotsHandle(t *testing.T) {
	r := gin.New()
	r.GET("/robots.txt", RobotsHandle)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/robots.txt", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for robots.txt, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "User-agent") {
		t.Errorf("expected robots.txt content, got %s", w.Body.String())
	}
}
