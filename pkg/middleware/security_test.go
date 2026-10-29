package middleware

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func init() {
	gin.SetMode(gin.TestMode)
}

func TestSecurityHeaders(t *testing.T) {
	r := gin.New()
	r.Use(SecurityHeaders())
	r.GET("/ping", func(c *gin.Context) {
		c.String(http.StatusOK, "pong")
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/ping", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	expectedHeaders := map[string]string{
		"X-Frame-Options":        "SAMEORIGIN",
		"X-Content-Type-Options": "nosniff",
		"X-XSS-Protection":       "1; mode=block",
		"Referrer-Policy":        "strict-origin-when-cross-origin",
	}

	for key, expected := range expectedHeaders {
		if val := w.Header().Get(key); val != expected {
			t.Errorf("header %s: expected %q, got %q", key, expected, val)
		}
	}
}

func TestMaxBodySize(t *testing.T) {
	r := gin.New()
	r.Use(MaxBodySize(50)) // 50 bytes limit

	r.POST("/upload", func(c *gin.Context) {
		_, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.String(http.StatusRequestEntityTooLarge, "too large")
			return
		}
		c.String(http.StatusOK, "ok")
	})

	// Case 1: Body within limit (20 bytes)
	w1 := httptest.NewRecorder()
	req1, _ := http.NewRequest(http.MethodPost, "/upload", bytes.NewBuffer(make([]byte, 20)))
	r.ServeHTTP(w1, req1)
	if w1.Code != http.StatusOK {
		t.Errorf("expected 200 for payload within limit, got %d", w1.Code)
	}

	// Case 2: Body exceeds limit (100 bytes)
	w2 := httptest.NewRecorder()
	req2, _ := http.NewRequest(http.MethodPost, "/upload", bytes.NewBuffer(make([]byte, 100)))
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("expected 413 for payload exceeding limit, got %d", w2.Code)
	}
}

func TestIPRateLimiter(t *testing.T) {
	r := gin.New()
	limiter := NewIPRateLimiter(3, 500*time.Millisecond) // 3 requests per 500ms
	r.Use(limiter.Middleware())
	r.GET("/test", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	for i := 1; i <= 3; i++ {
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(http.MethodGet, "/test", nil)
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("request %d: expected 200, got %d", i, w.Code)
		}
	}

	// 4th request should be rate limited (429)
	w4 := httptest.NewRecorder()
	req4, _ := http.NewRequest(http.MethodGet, "/test", nil)
	r.ServeHTTP(w4, req4)
	if w4.Code != http.StatusTooManyRequests {
		t.Errorf("request 4: expected 429 Too Many Requests, got %d", w4.Code)
	}

	// Wait for window to reset
	time.Sleep(550 * time.Millisecond)

	// 5th request should succeed again
	w5 := httptest.NewRecorder()
	req5, _ := http.NewRequest(http.MethodGet, "/test", nil)
	r.ServeHTTP(w5, req5)
	if w5.Code != http.StatusOK {
		t.Errorf("request 5 after window reset: expected 200, got %d", w5.Code)
	}
}

func TestIPScanBanLimiter(t *testing.T) {
	r := gin.New()
	// Test setup: 3 times 404 in 300ms triggers ban for 500ms
	banLimiter := NewIPScanBanLimiter(3, 300*time.Millisecond, 500*time.Millisecond)
	r.Use(banLimiter.Middleware())
	r.GET("/notfound", func(c *gin.Context) {
		c.Status(http.StatusNotFound)
	})
	r.GET("/ok", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	// First 2 404s are allowed to pass through
	for i := 1; i <= 2; i++ {
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(http.MethodGet, "/notfound", nil)
		r.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Errorf("request %d: expected 404, got %d", i, w.Code)
		}
	}

	// 3rd 404 triggers the ban
	w3 := httptest.NewRecorder()
	req3, _ := http.NewRequest(http.MethodGet, "/notfound", nil)
	r.ServeHTTP(w3, req3)
	if w3.Code != http.StatusNotFound {
		t.Errorf("request 3: expected 404, got %d", w3.Code)
	}

	// Subsequent request (even to a valid /ok endpoint) should be banned with 403 Forbidden
	wBanned := httptest.NewRecorder()
	reqBanned, _ := http.NewRequest(http.MethodGet, "/ok", nil)
	r.ServeHTTP(wBanned, reqBanned)
	if wBanned.Code != http.StatusForbidden {
		t.Errorf("expected 403 Forbidden while banned, got %d", wBanned.Code)
	}

	// Wait for banDuration (500ms) to expire
	time.Sleep(550 * time.Millisecond)

	// After ban expires, request to /ok should succeed
	wAfter := httptest.NewRecorder()
	reqAfter, _ := http.NewRequest(http.MethodGet, "/ok", nil)
	r.ServeHTTP(wAfter, reqAfter)
	if wAfter.Code != http.StatusOK {
		t.Errorf("expected 200 after ban expired, got %d", wAfter.Code)
	}
}
