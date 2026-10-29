package notepad

import "github.com/gin-gonic/gin"

func (s *Server) Raw(c *gin.Context) {
	if n, ok := s.find(c); ok {
		if n.IsPrivate == 1 {
			allowed, err := s.authorizedViewer(s.DB, c, n)
			if err != nil {
				serverError(c)
				return
			}
			viewPwd := c.Query("view_pwd")
			pwd := c.Query("pwd")
			if !allowed && viewPwd != "" && n.ViewSecret != "" && verifySecret(n.ViewSecret, viewPwd) {
				allowed = true
			}
			if !allowed && pwd != "" && verifySecret(n.Secret, pwd) {
				allowed = true
			}
			if !allowed {
				c.AbortWithStatusJSON(403, gin.H{"error": "私密文档，需要输入秘钥访问"})
				return
			}
		}
		noCache(c)
		c.Header("Content-Type", "text/plain; charset=utf-8")
		c.Header("X-Content-Type-Options", "nosniff")
		c.String(200, n.Text)
	}
}
