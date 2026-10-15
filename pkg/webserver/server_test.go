package webserver

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writePair(t *testing.T, pair tls.Certificate) (string, string) {
	t.Helper()
	dir := t.TempDir()
	certFile, keyFile := filepath.Join(dir, "cert"), filepath.Join(dir, "key")
	key, err := x509.MarshalPKCS8PrivateKey(pair.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	for name, block := range map[string]*pem.Block{
		certFile: {Type: "CERTIFICATE", Bytes: pair.Certificate[0]},
		keyFile:  {Type: "PRIVATE KEY", Bytes: key},
	} {
		if err := os.WriteFile(name, pem.EncodeToMemory(block), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return certFile, keyFile
}

func TestServeHTTPAndHTTPSOnSamePort(t *testing.T) {
	fixture := httptest.NewTLSServer(http.NotFoundHandler())
	pair := fixture.TLS.Certificates[0]
	fixture.Close()
	certFile, keyFile := writePair(t, pair)
	server, err := New(":0", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS != nil {
			io.WriteString(w, "HTTPS")
		} else {
			io.WriteString(w, "HTTP")
		}
	}), certFile, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- Serve(server, listener) }()
	t.Cleanup(func() {
		listener.Close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("server did not stop after listener closed")
		}
	})
	client := fixture.Client()
	client.Timeout = 3 * time.Second
	defer client.CloseIdleConnections()
	for _, scheme := range []string{"http", "https", "http", "https"} {
		resp, err := client.Get(scheme + "://" + listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		want := "HTTP"
		if scheme == "https" {
			want = "HTTPS"
		}
		if err != nil || string(body) != want {
			t.Fatalf("%s: body=%q error=%v", scheme, body, err)
		}
	}
}

func TestNewWithoutCertificatesUsesHTTP(t *testing.T) {
	dir := t.TempDir()
	server, err := New(":8787", http.NotFoundHandler(), filepath.Join(dir, "cert"), filepath.Join(dir, "key"))
	if err != nil || server.TLSConfig != nil {
		t.Fatalf("expected HTTP server, got %v, %v", server, err)
	}
}

func TestNewRejectsIncompleteOrInvalidCertificates(t *testing.T) {
	for name, files := range map[string][]string{"missing-key": {"cert"}, "missing-cert": {"key"}, "invalid-pair": {"cert", "key"}} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			for _, file := range files {
				if err := os.WriteFile(filepath.Join(dir, file), []byte("invalid"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := New(":0", http.NotFoundHandler(), filepath.Join(dir, "cert"), filepath.Join(dir, "key")); err == nil {
				t.Fatal("expected certificate error, must not fall back to HTTP")
			}
		})
	}
}

func TestNewServesHTTPS(t *testing.T) {
	fixture := httptest.NewTLSServer(http.NotFoundHandler())
	pair := fixture.TLS.Certificates[0]
	fixture.Close()
	certFile, keyFile := writePair(t, pair)
	server, err := New(":0", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil {
			t.Error("request must use TLS")
		}
		w.WriteHeader(http.StatusNoContent)
	}), certFile, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	if server.TLSConfig.MinVersion != tls.VersionTLS12 {
		t.Fatal("expected TLS 1.2 minimum")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go server.ServeTLS(listener, "", "")
	client := fixture.Client()
	defer client.CloseIdleConnections()
	resp, err := client.Get("https://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("unexpected status: %d", resp.StatusCode)
	}
}
