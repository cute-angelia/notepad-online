package middleware

import (
	"fmt"
	"net/http"
	"strings"
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
	return MaxBodySizeWithMediaParts(maxBytes, 0)
}

// Only the matched raw-part PUT route may exceed the ordinary document limit.
func MaxBodySizeWithMediaParts(maxBytes, partBytes int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		limit := maxBytes
		if partBytes > 0 && isMediaPartRequest(c) {
			limit = partBytes
		}
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		c.Next()
	}
}

func isMediaPartRequest(c *gin.Context) bool {
	return c.Request.Method == http.MethodPut && c.FullPath() == "/:id/attachments/:attachment/parts/:part"
}

// A large video has hundreds of parts; it must not consume the editor's small
// request budget. Both buckets still bound requests before authorization work.
func MediaAwareRateLimiter(ordinary, parts *IPRateLimiter) gin.HandlerFunc {
	ordinaryHandler, partHandler := ordinary.Middleware(), parts.Middleware()
	return func(c *gin.Context) {
		if isMediaPartRequest(c) {
			partHandler(c)
		} else {
			ordinaryHandler(c)
		}
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

type banRecord struct {
	notFoundCount int
	windowReset   time.Time
	bannedUntil   time.Time
}

// IPScanBanLimiter bans IPs that hit 404 too frequently within a window.
type IPScanBanLimiter struct {
	mu          sync.Mutex
	records     map[string]*banRecord
	maxNotFound int
	window      time.Duration
	banDuration time.Duration
	stopChan    chan struct{}
}

// NewIPScanBanLimiter creates a limiter that bans an IP for banDuration if it encounters maxNotFound 404s within window.
func NewIPScanBanLimiter(maxNotFound int, window, banDuration time.Duration) *IPScanBanLimiter {
	limiter := &IPScanBanLimiter{
		records:     make(map[string]*banRecord),
		maxNotFound: maxNotFound,
		window:      window,
		banDuration: banDuration,
		stopChan:    make(chan struct{}),
	}

	go func() {
		ticker := time.NewTicker(window * 2)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				limiter.mu.Lock()
				now := time.Now()
				for ip, record := range limiter.records {
					if now.After(record.windowReset) && now.After(record.bannedUntil) {
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

// Middleware returns a Gin middleware for 404-scan detection and banning.
func (b *IPScanBanLimiter) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()
		now := time.Now()

		b.mu.Lock()
		record, exists := b.records[ip]
		if exists && now.Before(record.bannedUntil) {
			b.mu.Unlock()
			retryAfter := int(record.bannedUntil.Sub(now).Seconds())
			if retryAfter < 1 {
				retryAfter = 1
			}
			c.Header("Retry-After", fmt.Sprintf("%d", retryAfter))
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error": "由于频繁访问不存在的页面，您的 IP 已被临时封禁，请稍后再试。",
			})
			return
		}
		b.mu.Unlock()

		c.Next()

		if c.Writer.Status() == http.StatusNotFound {
			b.mu.Lock()
			defer b.mu.Unlock()

			now = time.Now()
			rec, ok := b.records[ip]
			if !ok || now.After(rec.windowReset) {
				rec = &banRecord{
					notFoundCount: 1,
					windowReset:   now.Add(b.window),
				}
				b.records[ip] = rec
			} else {
				rec.notFoundCount++
			}

			if rec.notFoundCount >= b.maxNotFound {
				rec.bannedUntil = now.Add(b.banDuration)
			}
		}
	}
}

type authBanRecord struct {
	failureCount int
	windowReset  time.Time
	bannedUntil  time.Time
}

// IPAuthFailureBanLimiter bans IPs that hit authentication failure (403/423) too frequently within a window,
// preventing single-source attackers from locking documents.
type IPAuthFailureBanLimiter struct {
	mu          sync.Mutex
	records     map[string]*authBanRecord
	maxFailures int
	window      time.Duration
	banDuration time.Duration
	stopChan    chan struct{}
}

func NewIPAuthFailureBanLimiter(maxFailures int, window, banDuration time.Duration) *IPAuthFailureBanLimiter {
	limiter := &IPAuthFailureBanLimiter{
		records:     make(map[string]*authBanRecord),
		maxFailures: maxFailures,
		window:      window,
		banDuration: banDuration,
		stopChan:    make(chan struct{}),
	}

	go func() {
		ticker := time.NewTicker(window * 2)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				limiter.mu.Lock()
				now := time.Now()
				for ip, record := range limiter.records {
					if now.After(record.windowReset) && now.After(record.bannedUntil) {
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

func (b *IPAuthFailureBanLimiter) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()
		now := time.Now()

		b.mu.Lock()
		record, exists := b.records[ip]
		if exists && now.Before(record.bannedUntil) {
			b.mu.Unlock()
			retryAfter := int(record.bannedUntil.Sub(now).Seconds())
			if retryAfter < 1 {
				retryAfter = 1
			}
			c.Header("Retry-After", fmt.Sprintf("%d", retryAfter))
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error": "由于连续秘钥尝试失败次数过多，您的 IP 已被临时限制，请稍后再试。",
			})
			return
		}
		b.mu.Unlock()

		c.Next()

		if (c.Writer.Status() == http.StatusForbidden || c.Writer.Status() == http.StatusLocked) &&
			(strings.HasSuffix(c.FullPath(), "/unlock") || strings.HasSuffix(c.FullPath(), "/raw")) {
			b.mu.Lock()
			defer b.mu.Unlock()

			now = time.Now()
			rec, ok := b.records[ip]
			if !ok || now.After(rec.windowReset) {
				rec = &authBanRecord{
					failureCount: 1,
					windowReset:  now.Add(b.window),
				}
				b.records[ip] = rec
			} else {
				rec.failureCount++
			}

			if rec.failureCount >= b.maxFailures {
				rec.bannedUntil = now.Add(b.banDuration)
			}
		}
	}
}
