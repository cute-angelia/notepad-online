package notepad

import "github.com/gin-gonic/gin"

func (s *Server) Raw(c *gin.Context) {
	if n, ok := s.find(c); ok {
		noCache(c)
		c.Header("Content-Type", "text/plain; charset=utf-8")
		c.Header("X-Content-Type-Options", "nosniff")
		c.String(200, n.Text)
	}
}
