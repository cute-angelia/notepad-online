package model

import (
	"reflect"
	"testing"
)

func TestExtractNoteLinks(t *testing.T) {
	for _, tt := range []struct {
		name, source string
		want         []NoteLink
	}{
		{"links and embeds", "[[page:12]] ![[page:34|Display name]] [[page:12|Again]] [[page:56:Colon title]]", []NoteLink{{TargetNoteID: 12, Kind: "link"}, {TargetNoteID: 34, Kind: "embed"}, {TargetNoteID: 56, Kind: "link"}}},
		{"distinct kinds", "[[page:12]] ![[page:12]]", []NoteLink{{TargetNoteID: 12, Kind: "link"}, {TargetNoteID: 12, Kind: "embed"}}},
		{"code and escapes", "`[[page:12]]`\n\n```md\n![[page:34]]\n```\n\n    [[page:56]]\n\n\\[[page:78]]", nil},
		{"containers", "> [[page:12]]\n\n- ![[page:34]]\n\n| Page |\n| --- |\n| [[page:56]] |", []NoteLink{{TargetNoteID: 12, Kind: "link"}, {TargetNoteID: 34, Kind: "embed"}, {TargetNoteID: 56, Kind: "link"}}},
		{"invalid ids", "[[page:0]] [[page:-1]] [[page:01]] [[page:2147483648]] [[page:no]] [[page:12|]]", nil},
		{"front matter", "---\nref: '[[page:12]]'\n---\n[[page:34]]", []NoteLink{{TargetNoteID: 34, Kind: "link"}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := ExtractNoteLinks(tt.source); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %#v, want %#v", got, tt.want)
			}
		})
	}
}
