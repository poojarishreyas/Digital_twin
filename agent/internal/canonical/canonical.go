package canonical

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
)

func JSON(v any) ([]byte, error) {
	normalized, err := normalize(reflect.ValueOf(v))
	if err != nil {
		return nil, err
	}
	return json.Marshal(normalized)
}

func Hash(v any) (string, error) {
	b, err := JSON(v)
	if err != nil {
		return "", err
	}
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:]), nil
}

func normalize(v reflect.Value) (any, error) {
	if !v.IsValid() {
		return nil, nil
	}
	if v.Kind() == reflect.Interface || v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return nil, nil
		}
		return normalize(v.Elem())
	}
	switch v.Kind() {
	case reflect.Map:
		keys := v.MapKeys()
		sort.Slice(keys, func(i, j int) bool { return fmt.Sprint(keys[i].Interface()) < fmt.Sprint(keys[j].Interface()) })
		out := make(map[string]any, len(keys))
		for _, k := range keys {
			n, err := normalize(v.MapIndex(k))
			if err != nil {
				return nil, err
			}
			out[fmt.Sprint(k.Interface())] = n
		}
		return out, nil
	case reflect.Slice, reflect.Array:
		out := make([]any, v.Len())
		for i := range out {
			n, err := normalize(v.Index(i))
			if err != nil {
				return nil, err
			}
			out[i] = n
		}
		return out, nil
	default:
		b, err := json.Marshal(v.Interface())
		if err != nil {
			return nil, err
		}
		var out any
		if err := json.Unmarshal(b, &out); err != nil {
			return nil, err
		}
		return out, nil
	}
}
