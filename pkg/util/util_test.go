package util

import (
	"strings"
	"testing"
)

func TestRandChar(t *testing.T) {
	// Test positive lengths
	for _, size := range []int{1, 6, 16, 32} {
		s := RandChar(size)
		if len(s) != size {
			t.Errorf("expected length %d, got %d", size, len(s))
		}
		for _, c := range s {
			if !strings.ContainsRune(char, c) {
				t.Errorf("character %c not in allowed charset", c)
			}
		}
	}

	// Test non-positive lengths
	if s := RandChar(0); s != "" {
		t.Errorf("expected empty string for size 0, got %s", s)
	}
	if s := RandChar(-5); s != "" {
		t.Errorf("expected empty string for negative size, got %s", s)
	}

	// Test uniqueness across multiple runs
	s1 := RandChar(12)
	s2 := RandChar(12)
	if s1 == s2 {
		t.Errorf("two consecutive 12-char random strings should not be identical: %s == %s", s1, s2)
	}
}
