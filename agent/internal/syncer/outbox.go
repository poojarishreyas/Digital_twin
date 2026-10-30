package syncer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/example/digital-twin/agent/internal/model"
)

type Outbox struct {
	dir string
	max int
}

func NewOutbox(stateDir string, max int) (*Outbox, error) {
	dir := filepath.Join(stateDir, "outbox")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	return &Outbox{dir: dir, max: max}, nil
}

func (o *Outbox) Put(e model.Envelope) (dropped bool, err error) {
	b, err := json.Marshal(e)
	if err != nil {
		return false, err
	}
	tmp := filepath.Join(o.dir, fmt.Sprintf(".%020d.tmp", e.Sequence))
	final := filepath.Join(o.dir, fmt.Sprintf("%020d.json", e.Sequence))
	if err = os.WriteFile(tmp, b, 0600); err != nil {
		return false, err
	}
	if err = os.Rename(tmp, final); err != nil {
		return false, err
	}
	files, _ := o.files()
	for len(files) > o.max {
		_ = os.Remove(files[0])
		files = files[1:]
		dropped = true
	}
	return dropped, nil
}

func (o *Outbox) Pending() ([]model.Envelope, error) {
	files, err := o.files()
	if err != nil {
		return nil, err
	}
	out := make([]model.Envelope, 0, len(files))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		var e model.Envelope
		if err = json.Unmarshal(b, &e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

func (o *Outbox) Ack(sequence uint64) error {
	return os.Remove(filepath.Join(o.dir, fmt.Sprintf("%020d.json", sequence)))
}
func (o *Outbox) files() ([]string, error) {
	entries, err := os.ReadDir(o.dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			out = append(out, filepath.Join(o.dir, e.Name()))
		}
	}
	sort.Strings(out)
	return out, nil
}

func LoadSequence(stateDir string) (uint64, error) {
	b, err := os.ReadFile(filepath.Join(stateDir, "sequence"))
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
}
func SaveSequence(stateDir string, n uint64) error {
	tmp := filepath.Join(stateDir, ".sequence.tmp")
	if err := os.WriteFile(tmp, []byte(strconv.FormatUint(n, 10)), 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(stateDir, "sequence"))
}
