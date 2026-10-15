package notepad

import (
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func init() { gin.SetMode(gin.TestMode) }
func TestIndex(t *testing.T) {
	_, r := testServer(t)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if w.Code != 200 {
		t.Fatalf("new draft = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), `data-new="true"`) {
		t.Fatal("new document not editable")
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-cache, no-store, must-revalidate" {
		t.Fatalf("cache = %q", cc)
	}
}
