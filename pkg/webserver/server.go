package webserver

import (
	"net/http"
	"strings"
	"time"
)

// New creates a plain HTTP server with limits for streaming attachment uploads.
func New(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr: formatAddr(addr), Handler: handler,
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Minute,
		IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20,
	}
}

func formatAddr(addr string) string {
	if !strings.Contains(addr, ":") {
		return ":" + addr
	}
	return addr
}
