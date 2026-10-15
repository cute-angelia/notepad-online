package notepad

import "github.com/gin-gonic/gin"

func (s *Server) Markdown(c *gin.Context) {
	if n, ok := s.find(c); ok {
		s.render(c, n, false, false, "", "markdown")
	}
}
