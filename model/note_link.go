package model

import (
	"regexp"
	"strconv"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
	"gorm.io/gorm"
)

// NoteLink is a rebuildable index; the source document remains authoritative.
type NoteLink struct {
	ID           uint   `gorm:"primaryKey"`
	SourceNoteID int32  `gorm:"not null;uniqueIndex:idx_note_link"`
	TargetNoteID int32  `gorm:"not null;uniqueIndex:idx_note_link;index"`
	Kind         string `gorm:"size:8;not null;uniqueIndex:idx_note_link"`
}

// Completion is committed with the data backfill, not inferred from DDL success.
type DataMigration struct {
	Name string `gorm:"primaryKey;size:80"`
}

func migrateNoteLinks(tx *gorm.DB) error {
	const name = "note_links_v1"
	var completed int64
	if err := tx.Model(&DataMigration{}).Where("name = ?", name).Count(&completed).Error; err != nil {
		return err
	}
	if completed > 0 {
		return nil
	}
	var notes []NotepadModel
	if err := tx.Where("document_type = ?", "markdown").FindInBatches(&notes, 100, func(_ *gorm.DB, _ int) error {
		for _, note := range notes {
			if err := SyncNoteLinks(tx, note); err != nil {
				return err
			}
		}
		return nil
	}).Error; err != nil {
		return err
	}
	return tx.Create(&DataMigration{Name: name}).Error
}

var pageReference = regexp.MustCompile(`^(!?)\[\[page:([1-9][0-9]{0,9})(?:[:|]([^\]\r\n]+))?\]\]`)
var pageFrontMatter = regexp.MustCompile(`(?s)^\x{FEFF}?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)`)
var metadataKey = regexp.MustCompile(`(?m)^[^\s#][^:\r\n]*:`)
var pageNodeKind = ast.NewNodeKind("PageReference")

type pageNode struct {
	ast.BaseInline
	target int32
	kind   string
}

func (n *pageNode) Kind() ast.NodeKind            { return pageNodeKind }
func (n *pageNode) Dump(source []byte, level int) { ast.DumpHelper(n, source, level, nil, nil) }

type pageParser struct{}

func (p *pageParser) Trigger() []byte { return []byte{'!', '['} }
func (p *pageParser) Parse(parent ast.Node, reader text.Reader, context parser.Context) ast.Node {
	line, _ := reader.PeekLine()
	match := pageReference.FindSubmatch(line)
	if match == nil {
		return nil
	}
	id, err := strconv.ParseInt(string(match[2]), 10, 32)
	if err != nil {
		return nil
	}
	kind := "link"
	if len(match[1]) > 0 {
		kind = "embed"
	}
	reader.Advance(len(match[0]))
	return &pageNode{target: int32(id), kind: kind}
}

func ExtractNoteLinks(source string) []NoteLink {
	if header := pageFrontMatter.FindStringSubmatch(source); header != nil && metadataKey.MatchString(header[1]) {
		source = source[len(header[0]):]
	}
	md := goldmark.New(goldmark.WithExtensions(extension.GFM), goldmark.WithParserOptions(parser.WithInlineParsers(util.Prioritized(&pageParser{}, 50))))
	root := md.Parser().Parse(text.NewReader([]byte(source)))
	var result []NoteLink
	seen := make(map[NoteLink]bool)
	_ = ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if ref, ok := n.(*pageNode); ok && entering {
			edge := NoteLink{TargetNoteID: ref.target, Kind: ref.kind}
			if !seen[edge] {
				result = append(result, edge)
				seen[edge] = true
			}
		}
		return ast.WalkContinue, nil
	})
	return result
}

func SyncNoteLinks(tx *gorm.DB, note NotepadModel) error {
	if err := tx.Where("source_note_id = ?", note.Id).Delete(&NoteLink{}).Error; err != nil {
		return err
	}
	if note.DocumentType != "markdown" {
		return nil
	}
	edges := ExtractNoteLinks(note.Text)
	if len(edges) == 0 {
		return nil
	}
	ids := make([]int32, 0, len(edges))
	for _, edge := range edges {
		ids = append(ids, edge.TargetNoteID)
	}
	var existing []int32
	if err := tx.Model(&NotepadModel{}).Where("id IN ?", ids).Pluck("id", &existing).Error; err != nil {
		return err
	}
	targets := make(map[int32]bool, len(existing))
	for _, id := range existing {
		targets[id] = true
	}
	rows := make([]NoteLink, 0, len(edges))
	for _, edge := range edges {
		if targets[edge.TargetNoteID] {
			edge.SourceNoteID = note.Id
			rows = append(rows, edge)
		}
	}
	if len(rows) == 0 {
		return nil
	}
	return tx.CreateInBatches(&rows, 100).Error
}
