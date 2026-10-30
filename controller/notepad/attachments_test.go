package notepad

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"note/model"
	"note/pkg/attachments"
	"note/pkg/middleware"

	"github.com/gin-gonic/gin"
)

type fakeMediaStore struct {
	started, uploaded, completed, removed, aborted int
	key                                            string
	readBeforeUpload                               *int64
	err                                            error
	abortErr                                       error
}

func (f *fakeMediaStore) Begin(_ context.Context, key, contentType string) (string, error) {
	f.started++
	f.key = key
	return "upload-1", f.err
}
func (f *fakeMediaStore) Upload(_ context.Context, key, upload string, number int, body io.Reader, size int64) (string, error) {
	f.uploaded++
	if f.readBeforeUpload != nil && *f.readBeforeUpload > 4096 {
		return "", fmt.Errorf("body buffered before storage: %d", *f.readBeforeUpload)
	}
	n, err := io.Copy(io.Discard, body)
	if err != nil {
		return "", err
	}
	if n != size {
		return "", io.ErrUnexpectedEOF
	}
	return fmt.Sprintf("etag-%d", number), f.err
}
func (f *fakeMediaStore) Complete(_ context.Context, key, upload string, parts []attachments.Part) error {
	f.completed++
	return f.err
}
func (f *fakeMediaStore) Remove(_ context.Context, key string) error { f.removed++; return f.err }
func (f *fakeMediaStore) Abort(_ context.Context, key, upload string) error {
	f.aborted++
	if f.abortErr != nil {
		return f.abortErr
	}
	return f.err
}

func mediaServer(t *testing.T) (*Server, *gin.Engine, *fakeMediaStore, []*http.Cookie) {
	t.Helper()
	s, _ := testServer(t)
	f := &fakeMediaStore{}
	s.Media = &attachments.Service{Store: f, Config: attachments.Config{Enabled: true, Bucket: "media", Prefix: "notes", PublicURL: "https://cdn.example/media", ImageMaxSize: 20 << 20, VideoMaxSize: 5 << 30, Timeout: time.Minute}}
	r := gin.New()
	r.Use(middleware.MaxBodySizeWithMediaParts(5<<20, attachments.PartSize))
	s.RegisterRoutes(r)
	owner := createNote(t, r, "media-note")
	return s, r, f, owner
}

func mediaRequest(r http.Handler, method, path, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("X-Notepad-Request", "1")
	req.Header.Set("Content-Type", "application/json")
	for _, c := range cookies {
		req.AddCookie(c)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func beginMedia(t *testing.T, r http.Handler, owner []*http.Cookie, size int64) string {
	t.Helper()
	w := mediaRequest(r, "POST", "/media-note/attachments", fmt.Sprintf(`{"name":"photo.png","type":"image/png","size":%d}`, size), owner...)
	if w.Code != 201 {
		t.Fatalf("begin: %d %s", w.Code, w.Body.String())
	}
	var response struct {
		ID       string `json:"id"`
		PartSize int64  `json:"partSize"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.ID == "" || response.PartSize != 8<<20 {
		t.Fatalf("response: %+v", response)
	}
	return response.ID
}

func TestAttachmentsRequireEditorWriteGuardAndRespectLock(t *testing.T) {
	s, r, f, owner := mediaServer(t)
	id := beginMedia(t, r, owner, 8)
	for _, route := range []struct{ method, path, body string }{
		{"GET", "/media-note/attachments", ""},
		{"POST", "/media-note/attachments", `{"name":"photo.png","type":"image/png","size":8}`},
		{"PUT", "/media-note/attachments/" + id + "/parts/1", "12345678"},
		{"POST", "/media-note/attachments/" + id + "/complete", `{"parts":[]}`},
		{"DELETE", "/media-note/attachments/" + id, ""},
	} {
		if w := mediaRequest(r, route.method, route.path, route.body); w.Code != 403 {
			t.Fatalf("unauthorized %s: %d", route.path, w.Code)
		}
		req := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
		for _, c := range owner {
			req.AddCookie(c)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != 403 {
			t.Fatalf("missing writeGuard %s: %d", route.path, w.Code)
		}
	}
	s.DB.Model(&model.NotepadModel{}).Where("slug = ?", "media-note").Update("locked", s.Now().Add(time.Hour).Unix())
	if w := mediaRequest(r, "DELETE", "/media-note/attachments/"+id, "", owner...); w.Code != 423 {
		t.Fatalf("locked: %d %s", w.Code, w.Body.String())
	}
	if f.uploaded+f.completed+f.removed+f.aborted != 0 {
		t.Fatal("unauthorized storage operation")
	}
}

func TestAttachmentsRejectForeignIDsAndInvalidMetadata(t *testing.T) {
	_, r, f, owner := mediaServer(t)
	id := beginMedia(t, r, owner, 8)
	other := createNote(t, r, "other-note")
	for _, route := range []struct{ method, path, body string }{
		{"PUT", "/other-note/attachments/" + id + "/parts/1", "12345678"},
		{"POST", "/other-note/attachments/" + id + "/complete", `{"parts":[]}`},
		{"DELETE", "/other-note/attachments/" + id, ""},
	} {
		if w := mediaRequest(r, route.method, route.path, route.body, other...); w.Code != 404 {
			t.Fatalf("foreign attachment: %d", w.Code)
		}
	}
	for _, body := range []string{
		`{"name":"a.png","type":"image/png","size":20971521}`,
		`{"name":"a.mp4","type":"video/mp4","size":5368709121}`,
		`{"name":"a.svg","type":"image/svg+xml","size":8}`,
		`{"name":"a.png","type":"image/png","size":0}`,
		`{"name":"../a.png","type":"image/png","size":8}`,
	} {
		if w := mediaRequest(r, "POST", "/media-note/attachments", body, owner...); w.Code != 400 && w.Code != 413 {
			t.Fatalf("invalid metadata accepted: %d %s", w.Code, w.Body.String())
		}
	}
	if f.started != 1 || f.uploaded+f.completed+f.removed != 0 {
		t.Fatal("invalid request accessed storage")
	}
}

func TestAttachmentMultipartCompletionAndImmediateDeletion(t *testing.T) {
	s, r, f, owner := mediaServer(t)
	s.Now = func() time.Time { return time.Date(2026, 10, 31, 18, 0, 0, 0, time.UTC) }
	body := "\x89PNG\r\n\x1a\n" + strings.Repeat("x", 100)
	id := beginMedia(t, r, owner, int64(len(body)))
	if !strings.HasPrefix(f.key, "notes/2026-11/") || !strings.HasSuffix(f.key, ".png") {
		t.Fatalf("bad dated key %q", f.key)
	}
	path := "/media-note/attachments/" + id
	if w := mediaRequest(r, "POST", path+"/complete", `{"parts":[{"number":1,"etag":"etag-1"}]}`, owner...); w.Code != 400 {
		t.Fatalf("missing parts complete: %d", w.Code)
	}
	if w := mediaRequest(r, "PUT", path+"/parts/1", body, owner...); w.Code != 200 {
		t.Fatalf("part: %d %s", w.Code, w.Body.String())
	}
	if w := mediaRequest(r, "POST", path+"/complete", `{"parts":[{"number":1,"etag":"wrong"}]}`, owner...); w.Code != 400 {
		t.Fatal("wrong etag accepted")
	}
	w := mediaRequest(r, "POST", path+"/complete", `{"parts":[{"number":1,"etag":"etag-1"}]}`, owner...)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "https://cdn.example/media/notes/2026-11/") {
		t.Fatalf("complete: %d %s", w.Code, w.Body.String())
	}
	w = mediaRequest(r, "GET", "/media-note/attachments", "", owner...)
	if w.Code != 200 || !strings.Contains(w.Body.String(), id) {
		t.Fatalf("listing: %d %s", w.Code, w.Body.String())
	}
	if w := mediaRequest(r, "DELETE", path, "", owner...); w.Code != 200 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	if f.removed != 1 || f.aborted != 0 {
		t.Fatal("completed file was not removed immediately")
	}
	var count int64
	s.DB.Model(&model.Attachment{}).Count(&count)
	if count != 0 {
		t.Fatal("attachment row retained")
	}
	id = beginMedia(t, r, owner, 8)
	if w := mediaRequest(r, "DELETE", "/media-note/attachments/"+id, "", owner...); w.Code != 200 || f.aborted != 1 {
		t.Fatal("incomplete upload not aborted")
	}
}

type countedMediaBody struct {
	reader io.Reader
	n      int64
}

func (b *countedMediaBody) Read(p []byte) (int, error) {
	n, e := b.reader.Read(p)
	b.n += int64(n)
	return n, e
}

func TestAttachmentPartsStreamAndValidateLengths(t *testing.T) {
	_, r, f, owner := mediaServer(t)
	id := beginMedia(t, r, owner, attachments.PartSize+8)
	path := "/media-note/attachments/" + id + "/parts/"
	for _, sample := range []struct {
		number string
		body   string
		length int64
	}{
		{"0", "bad", 3}, {"3", "bad", 3}, {"1", "bad", attachments.PartSize + 1}, {"1", "bad", -1}, {"2", "short", 8}, {"2", "too-long!", 8},
	} {
		req := httptest.NewRequest("PUT", path+sample.number, strings.NewReader(sample.body))
		req.ContentLength = sample.length
		req.Header.Set("X-Notepad-Request", "1")
		for _, c := range owner {
			req.AddCookie(c)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code < 400 {
			t.Fatalf("bad part accepted: %+v", sample)
		}
	}
	body := &countedMediaBody{reader: io.MultiReader(strings.NewReader("\x89PNG\r\n\x1a\n"), io.LimitReader(zeroMediaReader{}, attachments.PartSize-8))}
	f.readBeforeUpload = &body.n
	req := httptest.NewRequest("PUT", path+"1", body)
	req.ContentLength = attachments.PartSize
	req.Header.Set("X-Notepad-Request", "1")
	for _, c := range owner {
		req.AddCookie(c)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("8MiB streamed part: %d %s", w.Code, w.Body.String())
	}
	if body.n != attachments.PartSize {
		t.Fatalf("read %d", body.n)
	}
}

type zeroMediaReader struct{}

func (zeroMediaReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func TestAttachmentMIMEAndStorageErrorsDoNotPublishOrForgetObjects(t *testing.T) {
	s, r, f, owner := mediaServer(t)
	id := beginMedia(t, r, owner, 8)
	path := "/media-note/attachments/" + id
	if w := mediaRequest(r, "PUT", path+"/parts/1", "<script>", owner...); w.Code != 400 {
		t.Fatalf("false MIME: %d", w.Code)
	}
	if f.uploaded != 0 {
		t.Fatal("invalid header forwarded")
	}
	f.err = fmt.Errorf("storage unavailable")
	if w := mediaRequest(r, "DELETE", path, "", owner...); w.Code != 502 {
		t.Fatalf("abort error: %d", w.Code)
	}
	var count int64
	s.DB.Model(&model.Attachment{}).Count(&count)
	if count != 1 {
		t.Fatal("failed deletion forgot retryable object")
	}
}

func TestAttachmentsDisabledKeepNotesWorking(t *testing.T) {
	_, r := testServer(t)
	owner := createNote(t, r, "disabled")
	if w := mediaRequest(r, "GET", "/disabled/attachments", "", owner...); w.Code != 503 {
		t.Fatalf("disabled status: %d", w.Code)
	}
}

func TestAttachmentDeleteRecoversCompletedObjectWithIncompleteRow(t *testing.T) {
	s, r, f, owner := mediaServer(t)
	id := beginMedia(t, r, owner, 8)
	f.abortErr = attachments.ErrUploadNotFound
	w := mediaRequest(r, "DELETE", "/media-note/attachments/"+id, "", owner...)
	if w.Code != 200 || f.aborted != 1 || f.removed != 1 {
		t.Fatalf("recovery delete: %d %s, aborts=%d removes=%d", w.Code, w.Body.String(), f.aborted, f.removed)
	}
	var count int64
	s.DB.Model(&model.Attachment{}).Count(&count)
	if count != 0 {
		t.Fatal("recovered object row retained")
	}
}

func TestAttachmentCompleteRetryIsIdempotent(t *testing.T) {
	_, r, f, owner := mediaServer(t)
	id := beginMedia(t, r, owner, 8)
	path := "/media-note/attachments/" + id
	if w := mediaRequest(r, "PUT", path+"/parts/1", "\x89PNG\r\n\x1a\n", owner...); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for i := 0; i < 2; i++ {
		if w := mediaRequest(r, "POST", path+"/complete", `{"parts":[{"number":1,"etag":"etag-1"}]}`, owner...); w.Code != 200 {
			t.Fatalf("complete retry: %d %s", w.Code, w.Body.String())
		}
	}
	if f.completed != 1 {
		t.Fatal("retry re-completed storage upload")
	}
}
