package notepad

import "github.com/gin-gonic/gin"

func (s *Server) Markdown(c *gin.Context) {
	if n, ok := s.find(c); ok {
		s.viewInternal(c, n, "markdown")
	}
}
