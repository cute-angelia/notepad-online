package attachments

import (
	"context"
	"errors"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/minio/minio-go/v7/pkg/s3utils"
)

const PartSize int64 = 8 << 20
const MaxParts = 10000

var ErrUploadNotFound = errors.New("multipart upload no longer exists")

type Config struct {
	Enabled                                bool
	EndPoint, AccessKeyID, SecretAccessKey string
	UseSSL                                 bool
	Timeout                                time.Duration
	Bucket, Prefix, PublicURL              string
	ImageMaxSize, VideoMaxSize             int64
}

type Part struct {
	Number int    `json:"number"`
	ETag   string `json:"etag"`
	Size   int64  `json:"size"`
}

// Store accepts a single bounded part reader, never an entire media file.
type Store interface {
	Begin(context.Context, string, string) (string, error)
	Upload(context.Context, string, string, int, io.Reader, int64) (string, error)
	Complete(context.Context, string, string, []Part) error
	Abort(context.Context, string, string) error
	Remove(context.Context, string) error
}

type Service struct {
	Config Config
	Store  Store
}

func New(cfg Config) (*Service, error) {
	if !cfg.Enabled {
		return nil, nil
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 2 * time.Minute
	}
	if cfg.ImageMaxSize == 0 {
		cfg.ImageMaxSize = 20 << 20
	}
	if cfg.VideoMaxSize == 0 {
		cfg.VideoMaxSize = 5 << 30
	}
	if cfg.Timeout < 0 || cfg.ImageMaxSize < 1 || cfg.VideoMaxSize < 1 || cfg.ImageMaxSize > PartSize*MaxParts || cfg.VideoMaxSize > PartSize*MaxParts {
		return nil, errors.New("invalid minio timeout or media size limits")
	}
	if err := s3utils.CheckValidBucketName(cfg.Bucket); err != nil {
		return nil, errors.New("invalid minio bucket")
	}
	if cfg.PublicURL == "" {
		scheme := "http"
		if cfg.UseSSL {
			scheme = "https"
		}
		cfg.PublicURL = (&url.URL{Scheme: scheme, Host: cfg.EndPoint, Path: "/" + cfg.Bucket}).String()
	}
	u, err := url.Parse(cfg.PublicURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("minio publicUrl must be an HTTP(S) base URL without credentials, query or fragment")
	}
	cfg.PublicURL = strings.TrimRight(cfg.PublicURL, "/")
	cfg.Prefix = strings.Trim(cfg.Prefix, "/")
	if len(cfg.Prefix) > 512 || strings.ContainsAny(cfg.Prefix, "\\\x00\r\n") {
		return nil, errors.New("invalid minio prefix")
	}
	if cfg.Prefix != "" {
		for _, segment := range strings.Split(cfg.Prefix, "/") {
			if segment == "" || segment == "." || segment == ".." {
				return nil, errors.New("invalid minio prefix")
			}
		}
	}
	if cfg.EndPoint == "" || cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" {
		return nil, errors.New("minio endpoint and credentials are required when enabled")
	}
	transport, err := minio.DefaultTransport(cfg.UseSSL)
	if err != nil {
		return nil, errors.New("cannot initialize minio transport")
	}
	transport.ResponseHeaderTimeout = cfg.Timeout
	core, err := minio.NewCore(cfg.EndPoint, &minio.Options{Creds: credentials.NewStaticV4(cfg.AccessKeyID, cfg.SecretAccessKey, ""), Secure: cfg.UseSSL, Transport: transport})
	if err != nil {
		return nil, errors.New("invalid minio endpoint configuration")
	}
	return &Service{Config: cfg, Store: &minioStore{core: core, bucket: cfg.Bucket}}, nil
}

func (s *Service) URL(key string) string {
	u, _ := url.Parse(s.Config.PublicURL)
	u.Path = strings.TrimRight(u.Path, "/") + "/" + key
	u.RawPath = ""
	return u.String()
}

type minioStore struct {
	core   *minio.Core
	bucket string
}

func (m *minioStore) Begin(ctx context.Context, key, kind string) (string, error) {
	return m.core.NewMultipartUpload(ctx, m.bucket, key, minio.PutObjectOptions{ContentType: kind})
}
func (m *minioStore) Upload(ctx context.Context, key, upload string, number int, body io.Reader, size int64) (string, error) {
	part, err := m.core.PutObjectPart(ctx, m.bucket, key, upload, number, body, size, minio.PutObjectPartOptions{})
	return part.ETag, err
}
func (m *minioStore) Complete(ctx context.Context, key, upload string, parts []Part) error {
	complete := make([]minio.CompletePart, len(parts))
	for i, p := range parts {
		complete[i] = minio.CompletePart{PartNumber: p.Number, ETag: p.ETag}
	}
	_, err := m.core.CompleteMultipartUpload(ctx, m.bucket, key, upload, complete, minio.PutObjectOptions{})
	return err
}
func (m *minioStore) Abort(ctx context.Context, key, upload string) error {
	err := m.core.AbortMultipartUpload(ctx, m.bucket, key, upload)
	if minio.ToErrorResponse(err).Code == "NoSuchUpload" {
		return ErrUploadNotFound
	}
	return err
}
func (m *minioStore) Remove(ctx context.Context, key string) error {
	return m.core.RemoveObject(ctx, m.bucket, key, minio.RemoveObjectOptions{})
}
