package notepad

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/spf13/viper"
)

func init() {
	gin.SetMode(gin.TestMode)
}

func TestIndex(t *testing.T) {
	viper.Set("note.keylength", 8)

	r := gin.New()
	r.GET("/", Index)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.ServeHTTP(w, req)

	// Verify Status 302 Found (not 301)
	if w.Code != http.StatusFound {
		t.Fatalf("expected status 302, got %d", w.Code)
	}

	// Verify Location header has expected length (/ + 8 chars = 9)
	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, "/") {
		t.Errorf("expected location to start with '/', got %q", loc)
	}
	tag := strings.TrimPrefix(loc, "/")
	if len(tag) != 8 {
		t.Errorf("expected generated tag length 8, got %d (location %q)", len(tag), loc)
	}

	// Verify no-cache headers
	if cc := w.Header().Get("Cache-Control"); cc != "no-cache, no-store, must-revalidate" {
		t.Errorf("expected Cache-Control no-cache, got %q", cc)
	}
}
