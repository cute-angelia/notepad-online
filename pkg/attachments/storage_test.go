package attachments

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestConfigDefaultsAndValidation(t *testing.T) {
	if s, err := New(Config{}); err != nil || s != nil {
		t.Fatal("disabled configuration requires storage")
	}
	cfg := Config{Enabled: true, EndPoint: "127.0.0.1:9000", AccessKeyID: "test-key", SecretAccessKey: "test-secret", Bucket: "media", Prefix: "notes", PublicURL: "https://files.example/media"}
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if s.Config.ImageMaxSize != 20<<20 || s.Config.VideoMaxSize != 5<<30 || s.Config.Timeout != 2*time.Minute {
		t.Fatalf("unexpected defaults: %+v", s.Config)
	}
	for _, mutate := range []func(*Config){
		func(c *Config) { c.Bucket = "" }, func(c *Config) { c.PublicURL = "javascript:bad" }, func(c *Config) { c.PublicURL = "https://user:password@files.example" },
		func(c *Config) { c.Prefix = "../other" }, func(c *Config) { c.ImageMaxSize = -1 }, func(c *Config) { c.Timeout = -time.Second },
	} {
		bad := cfg
		mutate(&bad)
		if _, err := New(bad); err == nil {
			t.Fatalf("invalid config accepted: %+v", bad)
		}
	}
}

func TestPublicURLDefaultsToEndpointBucketWithoutCredentials(t *testing.T) {
	cfg := Config{Enabled: true, EndPoint: "127.0.0.1:9000", AccessKeyID: "key-not-in-url", SecretAccessKey: "secret-not-in-url", Bucket: "media"}
	for _, secure := range []bool{false, true} {
		cfg.UseSSL = secure
		s, err := New(cfg)
		if err != nil {
			t.Fatal(err)
		}
		scheme := "http"
		if secure {
			scheme = "https"
		}
		if got := s.URL("notes/2026-10/photo.png"); got != scheme+"://127.0.0.1:9000/media/notes/2026-10/photo.png" {
			t.Fatalf("fallback URL=%s", got)
		}
		if strings.Contains(s.Config.PublicURL, cfg.AccessKeyID) || strings.Contains(s.Config.PublicURL, cfg.SecretAccessKey) {
			t.Fatal("URL contains credentials")
		}
	}
}

func TestMinIOAdapterUsesMultipartAndImmediateRemoveWithoutBucketMutation(t *testing.T) {
	var actions []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if r.Method == "GET" && query.Has("location") {
			fmt.Fprint(w, `<LocationConstraint>us-east-1</LocationConstraint>`)
			return
		}
		if r.URL.Path != "/media/notes/2026-10/test.png" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			w.WriteHeader(400)
			return
		}
		switch {
		case r.Method == "POST" && query.Has("uploads"):
			actions = append(actions, "begin")
			if r.Header.Get("Content-Type") != "image/png" {
				t.Error("missing safe content type")
			}
			fmt.Fprint(w, `<InitiateMultipartUploadResult><Bucket>media</Bucket><Key>notes/2026-10/test.png</Key><UploadId>test-upload</UploadId></InitiateMultipartUploadResult>`)
		case r.Method == "PUT" && query.Get("uploadId") == "test-upload" && query.Get("partNumber") == "1":
			actions = append(actions, "part")
			var n int64
			if strings.HasPrefix(r.Header.Get("X-Amz-Content-Sha256"), "STREAMING-AWS4-") {
				reader := bufio.NewReader(r.Body)
				for {
					line, err := reader.ReadString('\n')
					if err != nil {
						t.Error(err)
						break
					}
					size, err := strconv.ParseInt(strings.Split(strings.TrimSpace(line), ";")[0], 16, 64)
					if err != nil {
						t.Error(err)
						break
					}
					if size == 0 {
						break
					}
					copied, err := io.CopyN(io.Discard, reader, size)
					n += copied
					if err != nil {
						t.Error(err)
						break
					}
					reader.ReadString('\n')
				}
			} else {
				var err error
				n, err = io.Copy(io.Discard, r.Body)
				if err != nil {
					t.Error(err)
				}
			}
			if n != 8 {
				t.Errorf("decoded part length=%d", n)
			}
			w.Header().Set("ETag", `"test-etag"`)
		case r.Method == "POST" && query.Get("uploadId") == "test-upload":
			actions = append(actions, "complete")
			fmt.Fprint(w, `<CompleteMultipartUploadResult><Bucket>media</Bucket><Key>notes/2026-10/test.png</Key><ETag>test-etag</ETag></CompleteMultipartUploadResult>`)
		case r.Method == "DELETE" && query.Get("uploadId") == "test-upload":
			actions = append(actions, "abort")
			w.WriteHeader(204)
		case r.Method == "DELETE" && query.Get("uploadId") == "missing-upload":
			w.WriteHeader(404)
			fmt.Fprint(w, `<Error><Code>NoSuchUpload</Code><Message>Upload no longer exists</Message></Error>`)
		case r.Method == "DELETE" && !query.Has("uploadId"):
			actions = append(actions, "remove")
			w.WriteHeader(204)
		default:
			t.Errorf("unexpected storage operation: %s %s", r.Method, r.URL)
			w.WriteHeader(400)
		}
	}))
	defer server.Close()
	s, err := New(Config{Enabled: true, EndPoint: strings.TrimPrefix(server.URL, "http://"), AccessKeyID: "key", SecretAccessKey: "secret", Bucket: "media", Prefix: "notes", PublicURL: "https://files.example/media"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := "notes/2026-10/test.png"
	upload, err := s.Store.Begin(ctx, key, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	etag, err := s.Store.Upload(ctx, key, upload, 1, strings.NewReader("12345678"), 8)
	if err != nil {
		t.Fatal(err)
	}
	if etag != "test-etag" {
		t.Fatalf("etag: %q", etag)
	}
	if err = s.Store.Complete(ctx, key, upload, []Part{{Number: 1, ETag: etag, Size: 8}}); err != nil {
		t.Fatal(err)
	}
	if err = s.Store.Remove(ctx, key); err != nil {
		t.Fatal(err)
	}
	if err = s.Store.Abort(ctx, key, upload); err != nil {
		t.Fatal(err)
	}
	if err = s.Store.Abort(ctx, key, "missing-upload"); !errors.Is(err, ErrUploadNotFound) {
		t.Fatalf("lost upload not classified: %v", err)
	}
	if strings.Join(actions, ",") != "begin,part,complete,remove,abort" {
		t.Fatal(actions)
	}
}
