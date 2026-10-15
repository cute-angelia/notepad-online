package notepad

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"note/model"
)

const browserCookie = "notepad_browser"
const grantAge = 365 * 24 * time.Hour

var shanghai = time.FixedZone("Asia/Shanghai", 8*60*60)
var words = strings.Fields("acorn amber apple apricot autumn bamboo beach berry birch blossom breeze brook canyon cedar cherry cloud clover cocoa coral cotton crane crystal daisy dawn delta desert dream eagle earth ember fairy feather fern field flame flora forest frost garden ginger grape green grove hazel honey island ivory jasmine jungle lemon lilac lotus lunar mango maple meadow melon mint moon moss ocean olive orange orchid otter peach pearl pebble pepper petal piano pine plum polar poppy quartz raven river robin royal sage sandy satin scarlet shell silver skyward snow solar sparrow spring stone storm sugar sunny sunset swift tiger tulip velvet violet water wheat willow winter wonder woodland")

func randomToken() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b), err
}
func randomWord() (string, error) {
	i, err := rand.Int(rand.Reader, big.NewInt(int64(len(words))))
	if err != nil {
		return "", err
	}
	return words[i.Int64()], nil
}
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func (s *Server) browser(c *gin.Context, create bool) (string, error) {
	token, _ := c.Cookie(browserCookie)
	raw, err := base64.RawURLEncoding.DecodeString(token)
	valid := err == nil && len(raw) == 32
	if !create {
		if valid {
			return token, nil
		}
		return "", nil
	}
	if !valid {
		token, err = randomToken()
		if err != nil {
			return "", err
		}
	}
	http.SetCookie(c.Writer, &http.Cookie{Name: browserCookie, Value: token, Path: "/", MaxAge: int(grantAge.Seconds()), Expires: s.Now().Add(grantAge), HttpOnly: true, Secure: c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https", SameSite: http.SameSiteLaxMode})
	return token, nil
}
func (s *Server) authorized(tx *gorm.DB, c *gin.Context, n model.NotepadModel) (bool, error) {
	token, err := s.browser(c, false)
	if err != nil || token == "" {
		return false, err
	}
	var count int64
	err = tx.Model(&model.BrowserGrant{}).Where("note_id = ? AND browser_hash = ? AND secret_hash = ? AND expires_at > ?", n.Id, hashToken(token), n.Secret, s.Now().Unix()).Count(&count).Error
	return count > 0, err
}
func (s *Server) grant(tx *gorm.DB, n model.NotepadModel, token string) error {
	g := model.BrowserGrant{NoteID: n.Id, BrowserHash: hashToken(token), SecretHash: n.Secret, ExpiresAt: s.Now().Add(grantAge).Unix()}
	return tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "note_id"}, {Name: "browser_hash"}}, DoUpdates: clause.AssignmentColumns([]string{"secret_hash", "expires_at"})}).Create(&g).Error
}

// Called under the document row lock; SQL locked=0 resets an exhausted counter.
func normalizeLock(n *model.NotepadModel, now time.Time) {
	day := now.In(shanghai).Format("2006-01-02")
	if n.FailureDay != day || (n.Locked != 0 && n.Locked <= now.Unix()) || (n.Locked == 0 && n.FailedAttempts >= 10) {
		n.FailedAttempts = 0
		n.FailureDay = day
		if n.Locked <= now.Unix() {
			n.Locked = 0
		}
	}
}
func recordFailure(n *model.NotepadModel, now time.Time) {
	n.FailedAttempts++
	if n.FailedAttempts >= 10 {
		local := now.In(shanghai)
		n.Locked = time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, shanghai).Unix()
	}
}
func lockFields(n model.NotepadModel) map[string]interface{} {
	return map[string]interface{}{"locked": n.Locked, "failed_attempts": n.FailedAttempts, "failure_day": n.FailureDay}
}
func lockedReply(c *gin.Context, until int64) {
	c.JSON(423, gin.H{"error": "秘钥累计输错 10 次，本文档今天已禁止编辑", "locked_until": until})
}
func validSecret(secret string) bool {
	return len([]rune(strings.TrimSpace(secret))) >= 4 && len(secret) <= 72
}
func (s *Server) RandomSecret(c *gin.Context) {
	noCache(c)
	word, err := randomWord()
	if err != nil {
		serverError(c)
		return
	}
	c.JSON(200, gin.H{"secret": word})
}
func (s *Server) Unlock(c *gin.Context) {
	tag := c.Param("id")
	if !validTag(tag) {
		c.Status(404)
		return
	}
	if err := c.Request.ParseForm(); err != nil {
		c.JSON(400, gin.H{"error": "无效请求"})
		return
	}
	secret := c.PostForm("secret")
	token, err := s.browser(c, true)
	if err != nil {
		serverError(c)
		return
	}
	status := 200
	var until int64
	attempts := 0
	err = s.DB.Transaction(func(tx *gorm.DB) error {
		var n model.NotepadModel
		if e := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("tag = ?", tag).First(&n).Error; e != nil {
			if errors.Is(e, gorm.ErrRecordNotFound) {
				status = 404
				return nil
			}
			return e
		}
		now := s.Now()
		normalizeLock(&n, now)
		if n.Locked > now.Unix() {
			status = 423
			until = n.Locked
			return nil
		}
		// Existing authorization is enough; there is no second old-secret challenge.
		allowed, e := s.authorized(tx, c, n)
		if e != nil {
			return e
		}
		if !allowed && (len(secret) > 72 || bcrypt.CompareHashAndPassword([]byte(n.Secret), []byte(secret)) != nil) {
			recordFailure(&n, now)
			status = 403
			attempts = 10 - n.FailedAttempts
			if n.Locked > now.Unix() {
				status = 423
				until = n.Locked
			}
			return tx.Model(&n).Updates(lockFields(n)).Error
		}
		if e = tx.Model(&n).Updates(lockFields(n)).Error; e != nil {
			return e
		}
		return s.grant(tx, n, token)
	})
	if err != nil {
		serverError(c)
		return
	}
	noCache(c)
	if status == 423 {
		lockedReply(c, until)
		return
	}
	if status == 403 {
		c.JSON(403, gin.H{"error": "秘钥不正确", "remaining": attempts})
		return
	}
	if status == 404 {
		c.Status(404)
		return
	}
	c.JSON(200, gin.H{"edit_url": notePath(tag) + "/edit"})
}
