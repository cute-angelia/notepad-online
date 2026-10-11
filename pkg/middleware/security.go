package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// SecurityHeaders adds standard security headers to all HTTP responses.
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Frame-Options", "SAMEORIGIN")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-XSS-Protection", "1; mode=block")
		c.Header("Referrer-Policy", "strict-origin-when-cross-origin")
		c.Next()
	}
}

// MaxBodySize limits the maximum allowed request body size in bytes.
func MaxBodySize(maxBytes int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
		}
		c.Next()
	}
}

type clientRecord struct {
	count     int
	resetTime time.Time
}

// IPRateLimiter provides a memory-efficient rate limiter based on client IP.
type IPRateLimiter struct {
	mu       sync.Mutex
	records  map[string]*clientRecord
	limit    int
	window   time.Duration
	stopChan chan struct{}
}

// NewIPRateLimiter creates a new rate limiter with the specified request limit and time window.
func NewIPRateLimiter(limit int, window time.Duration) *IPRateLimiter {
	limiter := &IPRateLimiter{
		records:  make(map[string]*clientRecord),
		limit:    limit,
		window:   window,
		stopChan: make(chan struct{}),
	}

	// Periodically clean up expired records to prevent memory leak
	go func() {
		ticker := time.NewTicker(window * 2)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				limiter.mu.Lock()
				now := time.Now()
				for ip, record := range limiter.records {
					if now.After(record.resetTime) {
						delete(limiter.records, ip)
					}
				}
				limiter.mu.Unlock()
			case <-limiter.stopChan:
				return
			}
		}
	}()

	return limiter
}

// Middleware returns a Gin middleware for rate limiting.
func (rl *IPRateLimiter) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()

		rl.mu.Lock()
		now := time.Now()
		record, exists := rl.records[ip]
		if !exists || now.After(record.resetTime) {
			rl.records[ip] = &clientRecord{
				count:     1,
				resetTime: now.Add(rl.window),
			}
			rl.mu.Unlock()
			c.Next()
			return
		}

		if record.count >= rl.limit {
			rl.mu.Unlock()
			c.Header("Retry-After", "5")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": "Too many requests. Please try again later.",
			})
			return
		}

		record.count++
		rl.mu.Unlock()
		c.Next()
	}
}
