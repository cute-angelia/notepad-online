package notepad

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"note/model"
	"note/pkg/attachments"
)

var mediaExtensions = map[string]string{
	"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif",
	"video/mp4": ".mp4", "video/webm": ".webm", "video/ogg": ".ogv", "video/quicktime": ".mov",
}

type attachmentResponse struct {
	ID   string `json:"id"`
	URL  string `json:"url"`
	Name string `json:"name"`
	Type string `json:"type"`
	Size int64  `json:"size"`
}

func (s *Server) attachmentResponse(a model.Attachment) attachmentResponse {
	return attachmentResponse{ID: a.ID, URL: s.Media.URL(a.ObjectKey), Name: a.Name, Type: a.Type, Size: a.Size}
}

type mediaFailure struct {
	status  int
	message string
	until   int64
}

func (e *mediaFailure) Error() string { return e.message }
func mediaBad(message string) error   { return &mediaFailure{status: 400, message: message} }
func mediaStorageError() error {
	return &mediaFailure{status: 502, message: "附件存储服务暂不可用，请重试"}
}

// Hold the same document row lock used by Save/Unlock until a media operation
// finishes, so secret rotation or the document lock cannot race authorization.
func (s *Server) mediaOperation(c *gin.Context, status int, operation func(*gorm.DB, model.NotepadModel) (any, error)) {
	if !validSlug(c.Param("id")) {
		c.Status(404)
		return
	}
	var response any
	err := s.DB.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		var n model.NotepadModel
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("slug = ?", c.Param("id")).First(&n).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return &mediaFailure{status: 404, message: "文档不存在"}
			}
			return err
		}
		normalizeLock(&n, s.Now())
		if n.Locked > s.Now().Unix() {
			return &mediaFailure{status: 423, until: n.Locked}
		}
		allowed, err := s.authorized(tx, c, n)
		if err != nil {
			return err
		}
		if !allowed {
			return &mediaFailure{status: 403, message: "编辑授权已失效，请重新输入秘钥"}
		}
		if s.Media == nil || s.Media.Store == nil {
			return &mediaFailure{status: 503, message: "附件存储尚未配置"}
		}
		response, err = operation(tx, n)
		return err
	})
	if err != nil {
		var failure *mediaFailure
		if errors.As(err, &failure) {
			if failure.status == 423 {
				lockedReply(c, failure.until)
			} else {
				c.JSON(failure.status, gin.H{"error": failure.message})
			}
			return
		}
		serverError(c)
		return
	}
	c.JSON(status, response)
}

func mediaJSON(c *gin.Context, target any) error {
	// Metadata requests are small even when the normal document limit is larger.
	reader := http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
	decoder := json.NewDecoder(reader)
	if err := decoder.Decode(target); err != nil {
		return mediaBad("附件请求格式不正确")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return mediaBad("附件请求格式不正确")
	}
	return nil
}

func findAttachment(tx *gorm.DB, c *gin.Context, n model.NotepadModel) (model.Attachment, error) {
	var a model.Attachment
	err := tx.Where("id = ? AND note_id = ?", c.Param("attachment"), n.Id).First(&a).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return a, &mediaFailure{status: 404, message: "附件不存在"}
	}
	return a, err
}

func (s *Server) ListAttachments(c *gin.Context) {
	s.mediaOperation(c, 200, func(tx *gorm.DB, n model.NotepadModel) (any, error) {
		var rows []model.Attachment
		if err := tx.Where("note_id = ? AND complete = ?", n.Id, true).Order("created_at, id").Find(&rows).Error; err != nil {
			return nil, err
		}
		items := make([]attachmentResponse, 0, len(rows))
		for _, a := range rows {
			items = append(items, s.attachmentResponse(a))
		}
		return gin.H{"attachments": items, "limits": gin.H{"image": s.Media.Config.ImageMaxSize, "video": s.Media.Config.VideoMaxSize}}, nil
	})
}

func (s *Server) BeginAttachment(c *gin.Context) {
	s.mediaOperation(c, 201, func(tx *gorm.DB, n model.NotepadModel) (any, error) {
		var input struct {
			Name string `json:"name"`
			Type string `json:"type"`
			Size int64  `json:"size"`
		}
		if err := mediaJSON(c, &input); err != nil {
			return nil, err
		}
		ext, ok := mediaExtensions[input.Type]
		if !ok || input.Size <= 0 || input.Name == "" || len(input.Name) > 255 || strings.TrimSpace(input.Name) != input.Name || strings.ContainsAny(input.Name, "/\\") || strings.IndexFunc(input.Name, unicode.IsControl) >= 0 {
			return nil, mediaBad("请选择支持的图片或视频文件")
		}
		limit := s.Media.Config.ImageMaxSize
		if strings.HasPrefix(input.Type, "video/") {
			limit = s.Media.Config.VideoMaxSize
		}
		if input.Size > limit || input.Size > attachments.PartSize*attachments.MaxParts {
			return nil, &mediaFailure{status: 413, message: "附件大小超过限制"}
		}
		id, err := randomToken()
		if err != nil {
			return nil, err
		}
		key := path.Join(s.Media.Config.Prefix, s.Now().In(shanghai).Format("2006-01"), id+ext)
		ctx, cancel := context.WithTimeout(c.Request.Context(), s.Media.Config.Timeout)
		defer cancel()
		upload, err := s.Media.Store.Begin(ctx, key, input.Type)
		if err != nil {
			return nil, mediaStorageError()
		}
		a := model.Attachment{ID: id, NoteID: n.Id, Name: input.Name, Type: input.Type, Size: input.Size, ObjectKey: key, UploadID: upload, Parts: "[]", CreatedAt: s.Now().Unix()}
		if err = tx.Create(&a).Error; err != nil {
			// No client can discover the session until its row exists.
			_ = s.Media.Store.Abort(ctx, key, upload)
			return nil, err
		}
		return gin.H{"id": id, "partSize": attachments.PartSize}, nil
	})
}

func attachmentParts(a model.Attachment) ([]attachments.Part, error) {
	var parts []attachments.Part
	err := json.Unmarshal([]byte(a.Parts), &parts)
	return parts, err
}

func expectedPartSize(a model.Attachment, number int) int64 {
	count := (a.Size + attachments.PartSize - 1) / attachments.PartSize
	if number < 1 || int64(number) > count || number > attachments.MaxParts {
		return 0
	}
	if int64(number) == count {
		return a.Size - int64(number-1)*attachments.PartSize
	}
	return attachments.PartSize
}

// Peek only enough bytes to identify the declared container; the rest of the
// request stays a stream passed directly to the storage adapter.
func matchesMediaHeader(kind string, header []byte) bool {
	if http.DetectContentType(header) == kind {
		return true
	}
	if len(header) >= 12 && string(header[4:8]) == "ftyp" {
		brand := string(header[8:12])
		switch kind {
		case "image/avif":
			return brand == "avif" || brand == "avis"
		case "video/quicktime":
			return brand == "qt  "
		case "video/mp4":
			return brand != "avif" && brand != "avis" && brand != "qt  " && brand != "heic" && brand != "heix" && brand != "mif1" && brand != "msf1"
		}
	}
	return false
}

type mediaCountingReader struct {
	reader io.Reader
	n      int64
}

func (r *mediaCountingReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.n += int64(n)
	return n, err
}

func (s *Server) UploadAttachmentPart(c *gin.Context) {
	s.mediaOperation(c, 200, func(tx *gorm.DB, n model.NotepadModel) (any, error) {
		a, err := findAttachment(tx, c, n)
		if err != nil {
			return nil, err
		}
		if a.Complete {
			return nil, mediaBad("附件已完成上传")
		}
		number, err := strconv.Atoi(c.Param("part"))
		if err != nil {
			return nil, mediaBad("无效分片编号")
		}
		expected := expectedPartSize(a, number)
		if expected == 0 {
			return nil, mediaBad("无效分片编号")
		}
		if c.Request.ContentLength < 0 {
			return nil, &mediaFailure{status: 411, message: "分片必须声明 Content-Length"}
		}
		if c.Request.ContentLength != expected {
			return nil, &mediaFailure{status: 413, message: "分片大小不符合要求"}
		}
		body := &mediaCountingReader{reader: http.MaxBytesReader(c.Writer, c.Request.Body, expected)}
		buffered := bufio.NewReaderSize(body, 512)
		if number == 1 {
			header, peekErr := buffered.Peek(int(min(expected, 512)))
			if peekErr != nil || !matchesMediaHeader(a.Type, header) {
				return nil, mediaBad("文件内容与图片或视频类型不符")
			}
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), s.Media.Config.Timeout)
		defer cancel()
		etag, err := s.Media.Store.Upload(ctx, a.ObjectKey, a.UploadID, number, buffered, expected)
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				return nil, &mediaFailure{status: 413, message: "分片大小超过限制"}
			}
			if errors.Is(err, io.ErrUnexpectedEOF) {
				return nil, mediaBad("分片数据不完整")
			}
			return nil, mediaStorageError()
		}
		// A lying Content-Length must not become trusted part metadata, even if
		// the storage client consumed exactly its announced byte count.
		var extra [1]byte
		_, endErr := buffered.Read(extra[:])
		if body.n != expected || endErr != io.EOF {
			return nil, mediaBad("分片实际大小不符合要求")
		}
		if etag == "" || len(etag) > 256 {
			return nil, mediaStorageError()
		}
		parts, err := attachmentParts(a)
		if err != nil {
			return nil, err
		}
		updated := false
		for i := range parts {
			if parts[i].Number == number {
				parts[i] = attachments.Part{Number: number, ETag: etag, Size: expected}
				updated = true
				break
			}
		}
		if !updated {
			parts = append(parts, attachments.Part{Number: number, ETag: etag, Size: expected})
		}
		encoded, err := json.Marshal(parts)
		if err != nil {
			return nil, err
		}
		if err = tx.Model(&a).Update("parts", string(encoded)).Error; err != nil {
			return nil, err
		}
		return gin.H{"etag": etag}, nil
	})
}

func (s *Server) CompleteAttachment(c *gin.Context) {
	s.mediaOperation(c, 200, func(tx *gorm.DB, n model.NotepadModel) (any, error) {
		a, err := findAttachment(tx, c, n)
		if err != nil {
			return nil, err
		}
		var input struct {
			Parts []attachments.Part `json:"parts"`
		}
		if err = mediaJSON(c, &input); err != nil {
			return nil, err
		}
		parts, err := attachmentParts(a)
		if err != nil {
			return nil, err
		}
		count := int((a.Size + attachments.PartSize - 1) / attachments.PartSize)
		if len(parts) != count || len(input.Parts) != count {
			return nil, mediaBad("附件分片尚未上传完整")
		}
		sort.Slice(parts, func(i, j int) bool { return parts[i].Number < parts[j].Number })
		var total int64
		for i, p := range parts {
			if p.Number != i+1 || p.Size != expectedPartSize(a, p.Number) || input.Parts[i].Number != p.Number || input.Parts[i].ETag != p.ETag {
				return nil, mediaBad("附件分片列表不匹配")
			}
			total += p.Size
		}
		if total != a.Size {
			return nil, mediaBad("附件总大小不匹配")
		}
		if !a.Complete {
			ctx, cancel := context.WithTimeout(c.Request.Context(), s.Media.Config.Timeout)
			defer cancel()
			if err = s.Media.Store.Complete(ctx, a.ObjectKey, a.UploadID, parts); err != nil {
				return nil, mediaStorageError()
			}
			if err = tx.Model(&a).Update("complete", true).Error; err != nil {
				return nil, err
			}
		}
		return s.attachmentResponse(a), nil
	})
}

func (s *Server) DeleteAttachment(c *gin.Context) {
	s.mediaOperation(c, 200, func(tx *gorm.DB, n model.NotepadModel) (any, error) {
		a, err := findAttachment(tx, c, n)
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), s.Media.Config.Timeout)
		defer cancel()
		if a.Complete {
			err = s.Media.Store.Remove(ctx, a.ObjectKey)
		} else {
			err = s.Media.Store.Abort(ctx, a.ObjectKey, a.UploadID)
			if errors.Is(err, attachments.ErrUploadNotFound) {
				// Completion may have reached storage just before a DB commit or
				// response failed. The key is unique to this owned attachment.
				err = s.Media.Store.Remove(ctx, a.ObjectKey)
			}
		}
		if err != nil {
			return nil, mediaStorageError()
		}
		if err = tx.Delete(&a).Error; err != nil {
			return nil, err
		}
		return gin.H{"status": "ok"}, nil
	})
}
