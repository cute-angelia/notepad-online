package util

import (
	"crypto/rand"
	"math/big"
)

const char = "abcdefghijklmnopqrstuvwxyz0123456789"

func RandChar(size int) string {
	if size <= 0 {
		return ""
	}
	result := make([]byte, size)
	charLen := big.NewInt(int64(len(char)))
	for i := 0; i < size; i++ {
		num, err := rand.Int(rand.Reader, charLen)
		if err != nil {
			result[i] = char[i%len(char)]
			continue
		}
		result[i] = char[num.Int64()]
	}
	return string(result)
}

