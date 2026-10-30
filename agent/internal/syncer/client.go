package syncer

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/example/digital-twin/agent/internal/config"
	"github.com/example/digital-twin/agent/internal/model"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/encoding"
)

const Method = "/twin.telemetry.v1.TelemetryIngest/Sync"

type jsonCodec struct{}

func (jsonCodec) Name() string                    { return "json" }
func (jsonCodec) Marshal(v any) ([]byte, error)   { return json.Marshal(v) }
func (jsonCodec) Unmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

type Client struct {
	address string
	creds   credentials.TransportCredentials
}

func NewClient(c config.Config) (*Client, error) {
	cert, err := tls.LoadX509KeyPair(c.TLS.Certificate, c.TLS.Key)
	if err != nil {
		return nil, fmt.Errorf("load client certificate: %w", err)
	}
	ca, err := os.ReadFile(c.TLS.CA)
	if err != nil {
		return nil, fmt.Errorf("load CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return nil, fmt.Errorf("CA contains no certificates")
	}
	encoding.RegisterCodec(jsonCodec{})
	return &Client{address: c.ServerAddress, creds: credentials.NewTLS(&tls.Config{Certificates: []tls.Certificate{cert}, RootCAs: roots, ServerName: c.TLS.ServerName, MinVersion: tls.VersionTLS13})}, nil
}

func (c *Client) Send(ctx context.Context, e model.Envelope) (model.Ack, error) {
	conn, err := grpc.NewClient(c.address, grpc.WithTransportCredentials(c.creds), grpc.WithDefaultCallOptions(grpc.ForceCodec(jsonCodec{})))
	if err != nil {
		return model.Ack{}, err
	}
	defer conn.Close()
	callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var ack model.Ack
	err = conn.Invoke(callCtx, Method, &e, &ack)
	return ack, err
}
