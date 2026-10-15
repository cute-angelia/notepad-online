package webserver

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/soheilhy/cmux"
)

// New enables HTTPS when certificate files are present. A broken or incomplete
// pair is an error so a TLS deployment cannot silently fall back to HTTP.
func New(addr string, handler http.Handler, certFile, keyFile string) (*http.Server, error) {
	addr = formatAddr(addr)
	server := newHTTPServer(addr, handler)
	_, certErr := os.Stat(certFile)
	_, keyErr := os.Stat(keyFile)
	if os.IsNotExist(certErr) && os.IsNotExist(keyErr) {
		return server, nil
	}
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load SSL certificate %q and key %q: %w", certFile, keyFile, err)
	}
	server.TLSConfig = &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{pair},
	}
	return server, nil
}

func formatAddr(addr string) string {
	if !strings.Contains(addr, ":") {
		return ":" + addr
	}
	return addr
}

func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr: addr, Handler: handler,
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Minute,
		IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20,
	}
}

// ListenAndServe accepts HTTP and HTTPS on the same port when TLS is configured.
func ListenAndServe(server *http.Server) error {
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return err
	}
	return Serve(server, listener)
}

// Serve routes TLS handshakes before decrypting them, so HTTPS handlers retain
// Request.TLS while plain HTTP requests remain usable without a redirect.
func Serve(server *http.Server, listener net.Listener) error {
	defer listener.Close()
	if server.TLSConfig == nil {
		return server.Serve(listener)
	}
	mux := cmux.New(listener)
	mux.SetReadTimeout(server.ReadHeaderTimeout)
	tlsListener := mux.Match(cmux.TLS())
	httpListener := mux.Match(cmux.Any())
	plainServer := newHTTPServer(server.Addr, server.Handler)
	defer mux.Close()
	defer server.Close()
	defer plainServer.Close()
	results := make(chan error, 3)
	go func() { results <- server.ServeTLS(tlsListener, "", "") }()
	go func() { results <- plainServer.Serve(httpListener) }()
	go func() { results <- mux.Serve() }()
	return <-results
}
