package webserver

import (
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestNewHTTPServer(t *testing.T) {
	handler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	for _, addr := range []string{"8787", ":8787", "127.0.0.1:8787", "[::1]:8787"} {
		t.Run(addr, func(t *testing.T) {
			server := New(addr, handler)
			want := addr
			if addr == "8787" {
				want = ":8787"
			}
			if server.Addr != want || server.Handler == nil || server.TLSConfig != nil {
				t.Fatalf("unexpected HTTP server: %+v", server)
			}
			if server.ReadHeaderTimeout != 10*time.Second || server.ReadTimeout != 30*time.Minute ||
				server.IdleTimeout != 60*time.Second || server.MaxHeaderBytes != 1<<20 {
				t.Fatalf("unexpected server limits: %+v", server)
			}
		})
	}
}

func TestServerServesHTTP(t *testing.T) {
	server := New(":0", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS != nil {
			t.Error("request must use plain HTTP")
		}
		io.WriteString(w, "HTTP")
	}))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	t.Cleanup(func() {
		server.Close()
		select {
		case err := <-done:
			if !errors.Is(err, http.ErrServerClosed) {
				t.Errorf("unexpected server shutdown error: %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Error("server did not stop after closing")
		}
	})
	client := &http.Client{Timeout: 3 * time.Second}
	defer client.CloseIdleConnections()
	resp, err := client.Get("http://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != http.StatusOK || string(body) != "HTTP" {
		t.Fatalf("status=%d body=%q error=%v", resp.StatusCode, body, err)
	}
}
