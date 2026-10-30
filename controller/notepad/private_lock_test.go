package notepad

import (
	"net/url"
	"strings"
	"testing"

	"note/model"
)

func TestPrivateLock_Lifecycle(t *testing.T) {
	s, r := testServer(t)

	// 1. Create a note with is_private = 1 and view_secret
	wCreate := request(r, "POST", "/api/notes", url.Values{
		"slug":          {"private-note"},
		"secret":        {"master1234"},
		"view_secret":   {"guest1234"},
		"title":         {"机密标题"},
		"text":          {"机密正文内容"},
		"document_type": {"markdown"},
		"is_private":    {"1"},
	})
	if wCreate.Code != 201 {
		t.Fatalf("create private note failed: %d %s", wCreate.Code, wCreate.Body.String())
	}

	authorCookie := wCreate.Result().Cookies()[0]

	// 2. Unauthorized visitor viewing the private note
	wViewAnon := request(r, "GET", "/private-note", nil)
	if wViewAnon.Code != 200 {
		t.Fatalf("expected 200 on view page, got %d", wViewAnon.Code)
	}
	bodyAnon := wViewAnon.Body.String()
	if strings.Contains(bodyAnon, "机密正文内容") {
		t.Fatalf("unauthorized view page leaked secret text: %s", bodyAnon)
	}
	if strings.Contains(bodyAnon, "机密标题") {
		t.Fatalf("unauthorized view page leaked secret title: %s", bodyAnon)
	}
	if !strings.Contains(bodyAnon, "非公开文档") {
		t.Fatalf("unauthorized view page missing private doc notice: %s", bodyAnon)
	}
	if !strings.Contains(bodyAnon, `data-private-locked="true"`) {
		t.Fatalf("unauthorized view page missing data-private-locked: %s", bodyAnon)
	}

	// 2.1 Unauthorized visitor requesting /edit must not leak content or title
	wEditAnon := request(r, "GET", "/private-note/edit", nil)
	if wEditAnon.Code != 200 {
		t.Fatalf("expected 200 on edit page for unauthorized visitor, got %d", wEditAnon.Code)
	}
	bodyEditAnon := wEditAnon.Body.String()
	if strings.Contains(bodyEditAnon, "机密正文内容") {
		t.Fatalf("unauthorized edit page leaked secret text in HTML: %s", bodyEditAnon)
	}
	if strings.Contains(bodyEditAnon, "机密标题") {
		t.Fatalf("unauthorized edit page leaked secret title in HTML: %s", bodyEditAnon)
	}
	if !strings.Contains(bodyEditAnon, "非公开文档") {
		t.Fatalf("unauthorized edit page missing private doc notice: %s", bodyEditAnon)
	}
	if !strings.Contains(bodyEditAnon, `data-private-locked="true"`) {
		t.Fatalf("unauthorized edit page missing data-private-locked: %s", bodyEditAnon)
	}

	// 3. Unauthorized visitor requesting /raw
	wRawAnon := request(r, "GET", "/private-note/raw", nil)
	if wRawAnon.Code != 403 {
		t.Fatalf("expected 403 on raw for unauthorized visitor, got %d", wRawAnon.Code)
	}

	// 4. Authorized visitor (creator with browser cookie) viewing the note
	wViewAuth := request(r, "GET", "/private-note", nil, authorCookie)
	if wViewAuth.Code != 200 {
		t.Fatalf("expected 200 for authorized view, got %d", wViewAuth.Code)
	}
	bodyAuth := wViewAuth.Body.String()
	if !strings.Contains(bodyAuth, "机密正文内容") {
		t.Fatalf("authorized view page missing text: %s", bodyAuth)
	}
	if !strings.Contains(bodyAuth, "机密标题") {
		t.Fatalf("authorized view page missing title: %s", bodyAuth)
	}

	// 5. Authorized visitor requesting /raw
	wRawAuth := request(r, "GET", "/private-note/raw", nil, authorCookie)
	if wRawAuth.Code != 200 || !strings.Contains(wRawAuth.Body.String(), "机密正文内容") {
		t.Fatalf("authorized raw failed: %d %s", wRawAuth.Code, wRawAuth.Body.String())
	}

	// 6. Unlock via POST /:id/unlock with view_secret (viewer role)
	wUnlockViewer := request(r, "POST", "/private-note/unlock", url.Values{
		"secret": {"guest1234"},
	})
	if wUnlockViewer.Code != 200 {
		t.Fatalf("unlock with view_secret failed: %d %s", wUnlockViewer.Code, wUnlockViewer.Body.String())
	}
	if !strings.Contains(wUnlockViewer.Body.String(), `"role":"viewer"`) {
		t.Fatalf("unlock response missing role viewer: %s", wUnlockViewer.Body.String())
	}

	viewerCookie := wUnlockViewer.Result().Cookies()[0]
	// Viewer can view
	wViewViewer := request(r, "GET", "/private-note", nil, viewerCookie)
	if !strings.Contains(wViewViewer.Body.String(), "机密正文内容") {
		t.Fatalf("viewer view page missing text: %s", wViewViewer.Body.String())
	}

	// But viewer CANNOT save / edit!
	wSaveByViewer := request(r, "POST", "/private-note", url.Values{
		"title": {"恶意篡改"},
		"text":  {"试图修改正文"},
	}, viewerCookie)
	if wSaveByViewer.Code != 403 {
		t.Fatalf("viewer was unexpectedly allowed to save: %d %s", wSaveByViewer.Code, wSaveByViewer.Body.String())
	}

	// 7. Unlock with master secret (editor role)
	wUnlockMaster := request(r, "POST", "/private-note/unlock", url.Values{
		"secret": {"master1234"},
	})
	if wUnlockMaster.Code != 200 {
		t.Fatalf("unlock with master secret failed: %d %s", wUnlockMaster.Code, wUnlockMaster.Body.String())
	}
	if !strings.Contains(wUnlockMaster.Body.String(), `"role":"editor"`) {
		t.Fatalf("unlock response missing role editor: %s", wUnlockMaster.Body.String())
	}

	// 8. Toggle lock off: Save with is_private = 0 using author cookie
	wSaveToggle := request(r, "POST", "/private-note", url.Values{
		"title":         {"机密标题"},
		"text":          {"公开正文内容"},
		"document_type": {"markdown"},
		"is_private":    {"0"},
	}, authorCookie)
	if wSaveToggle.Code != 200 {
		t.Fatalf("save toggle failed: %d %s", wSaveToggle.Code, wSaveToggle.Body.String())
	}

	// Verify in DB
	var note model.NotepadModel
	s.DB.Where("slug = ?", "private-note").First(&note)
	if note.IsPrivate != 0 {
		t.Fatalf("expected note.IsPrivate == 0, got %d", note.IsPrivate)
	}

	// Now unauthorized visitor can view public note
	wViewPublic := request(r, "GET", "/private-note", nil)
	if !strings.Contains(wViewPublic.Body.String(), "公开正文内容") {
		t.Fatalf("expected public note text visible to anonymous: %s", wViewPublic.Body.String())
	}
}

func TestPrivateLock_QueryViewPwd(t *testing.T) {
	s, r := testServer(t)

	s.DB.Create(&model.NotepadModel{
		Slug:         "vcode-note",
		Secret:       "masterpass",
		ViewSecret:   "viewpass",
		Title:        "只读测试标题",
		Text:         "只读测试正文",
		DocumentType: "text",
		IsPrivate:    1,
	})

	// Access with ?view_pwd=viewpass directly views the note
	w := request(r, "GET", "/vcode-note?view_pwd=viewpass", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "只读测试正文") {
		t.Fatalf("access with ?view_pwd failed: %d %s", w.Code, w.Body.String())
	}

	// Raw access with ?view_pwd=viewpass succeeds
	wRaw := request(r, "GET", "/vcode-note/raw?view_pwd=viewpass", nil)
	if wRaw.Code != 200 || !strings.Contains(wRaw.Body.String(), "只读测试正文") {
		t.Fatalf("raw access with ?view_pwd failed: %d %s", wRaw.Code, wRaw.Body.String())
	}

	// But query parameter view_pwd CANNOT be used to save/edit!
	wSave := request(r, "POST", "/vcode-note", url.Values{
		"text": {"试图修改"},
	})
	if wSave.Code != 403 {
		t.Fatalf("expected 403 on save without edit auth, got %d", wSave.Code)
	}

	// Bad pwd on raw increments failed attempts
	wBad := request(r, "GET", "/vcode-note/raw?view_pwd=wrongpass", nil)
	if wBad.Code != 403 {
		t.Fatalf("expected 403 for wrong view_pwd on raw, got %d", wBad.Code)
	}
	var updated model.NotepadModel
	s.DB.Where("slug = ?", "vcode-note").First(&updated)
	if updated.FailedAttempts != 1 {
		t.Fatalf("expected FailedAttempts to be 1, got %d", updated.FailedAttempts)
	}
}

func TestReservedSlugs(t *testing.T) {
	reserved := []string{"api", "static", "robots.txt", "favicon.ico"}
	for _, slug := range reserved {
		if validSlug(slug) {
			t.Errorf("expected validSlug(%q) to be false", slug)
		}
	}
}
