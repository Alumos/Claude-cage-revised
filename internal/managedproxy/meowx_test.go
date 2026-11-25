package managedproxy

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func TestMeowXProtocolsSurviveImportStoreAndRuntime(t *testing.T) {
	for _, tc := range []struct {
		name         string
		data         string
		coreValidate bool
	}{
		{
			name:         "miu",
			data:         `proxies: [{name: miu-node, type: miu, server: example.com, port: 443, psk: "0123456789abcdef0123456789abcdef", sni: example.com, client-fingerprint: chrome, alpn: [h2], idle-session-timeout: 30, min-idle-session: 1}]`,
			coreValidate: true,
		},
		{
			name:         "miu-reality",
			data:         `proxies: [{name: miu-reality, type: miu, server: example.com, port: 443, psk: "0123456789abcdef0123456789abcdef", sni: example.com, client-fingerprint: chrome, reality-opts: {public-key: CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA, short-id: "0123456789abcdef"}}]`,
			coreValidate: true,
		},
		{
			name:         "snell-v4",
			data:         `proxies: [{name: snell-v4, type: snell, server: example.com, port: 8443, psk: "0123456789abcdef", version: 4, reuse: true}]`,
			coreValidate: true,
		},
		{
			name:         "snell-v6",
			data:         `proxies: [{name: snell-v6, type: snell, server: example.com, port: 8443, psk: "0123456789abcdef", version: 6, mode: default, reuse: true}]`,
			coreValidate: true,
		},
		{
			name:         "anytls-reality",
			data:         `proxies: [{name: anytls-reality, type: anytls, server: example.com, port: 443, password: secret-password, sni: example.com, client-fingerprint: chrome, reality-opts: {public-key: CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA, short-id: "0123456789abcdef"}}]`,
			coreValidate: true,
		},
		{
			name: "shadowquic",
			data: `proxies: [{name: sq-node, type: shadowquic, server: example.com, port: 443, username: user, password: secret}]`,
		},
		{
			name: "gost-relay",
			data: `proxies: [{name: relay-node, type: gost-relay, server: example.com, port: 8443, username: user, password: secret}]`,
		},
		{
			name: "trusttunnel",
			data: `proxies: [{name: tt-node, type: trusttunnel, server: example.com, port: 443, username: user, password: secret}]`,
		},
		{
			name: "sudoku",
			data: `proxies: [{name: sudoku-node, type: sudoku, server: example.com, port: 443, key: secret}]`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			profile := t.TempDir()
			s, err := Load(profile)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.Import("meowx", "", []byte(tc.data), "meowx", 0, ""); err != nil {
				t.Fatal(err)
			}
			s.Selected = s.Sources[0].Nodes[0].ID
			if err := s.Save(profile); err != nil {
				t.Fatal(err)
			}
			loaded, err := Load(profile)
			if err != nil {
				t.Fatal(err)
			}
			runtime, err := loaded.Runtime(profile)
			if err != nil {
				t.Fatal(err)
			}
			var original, generated struct{ Proxies []map[string]any }
			if err := yaml.Unmarshal([]byte(tc.data), &original); err != nil {
				t.Fatal(err)
			}
			if err := yaml.Unmarshal(runtime, &generated); err != nil || len(generated.Proxies) != 1 {
				t.Fatal("runtime lost the imported meowx node", err)
			}
			want := original.Proxies[0]
			want["name"], want["udp"] = loaded.Selected, false
			if !reflect.DeepEqual(generated.Proxies[0], want) {
				t.Fatalf("protocol fields changed: got=%#v want=%#v", generated.Proxies[0], want)
			}
			if tc.coreValidate && os.Getenv("CAGE_PROXY_INTEGRATION") == "1" {
				if err := Validate(context.Background(), profile, loaded); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestMeowXProtocolsKeepImportSafetyBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name string
		data string
	}{
		{"miu-private-key", `proxies: [{name: a, type: miu, server: example.com, port: 443, psk: "0123456789abcdef", private-key: /private/key.pem}]`},
		{"miu-certificate", `proxies: [{name: a, type: miu, server: example.com, port: 443, psk: "0123456789abcdef", certificate: /private/cert.pem}]`},
		{"miu-interface", `proxies: [{name: a, type: miu, server: example.com, port: 443, psk: "0123456789abcdef", interface-name: private-eth0}]`},
		{"snell-routing-mark", `proxies: [{name: a, type: snell, server: example.com, port: 8443, psk: "0123456789abcdef", version: 6, routing-mark: 42}]`},
		{"snell-nested-ca", `proxies: [{name: a, type: snell, server: example.com, port: 8443, psk: "0123456789abcdef", version: 4, obfs-opts: {ca: /private/ca.pem}}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Parse([]byte(tc.data), "test"); err == nil || strings.Contains(err.Error(), "private-") {
				t.Fatalf("unsafe field accepted or leaked: %v", err)
			}
		})
	}
	for _, disallowed := range []string{"direct", "reject", "dns", "rematch", "tailscale", "zerotier", "easytier"} {
		t.Run("disallow-"+disallowed, func(t *testing.T) {
			data := `proxies: [{name: a, type: ` + disallowed + `, server: example.com, port: 443}]`
			if _, err := Parse([]byte(data), "test"); err == nil {
				t.Fatalf("disallowed type %q was accepted", disallowed)
			}
		})
	}
}

func TestParseAnyTLSRealityShareLink(t *testing.T) {
	link := "anytls://any-pass@any.example.com:443?security=reality&sni=cdn.example.com&fp=chrome&pbk=CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=0123456789abcdef#AnyTLS-R"
	nodes, err := Parse([]byte(link), "test")
	if err != nil || len(nodes) != 1 {
		t.Fatalf("parse anytls reality share link: nodes=%d err=%v", len(nodes), err)
	}
	got := nodes[0].Config
	wantReality := map[string]any{
		"public-key": "CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"short-id":   "0123456789abcdef",
	}
	if got["type"] != "anytls" || got["password"] != "any-pass" || got["sni"] != "cdn.example.com" || got["client-fingerprint"] != "chrome" || !reflect.DeepEqual(got["reality-opts"], wantReality) {
		t.Fatalf("unexpected anytls reality config: %#v", got)
	}

	tlsLink := "anytls://any-pass@any.example.com:443?security=tls&sni=cdn.example.com#AnyTLS-TLS"
	tlsNodes, err := Parse([]byte(tlsLink), "test")
	if err != nil || len(tlsNodes) != 1 || tlsNodes[0].Config["reality-opts"] != nil {
		t.Fatalf("parse anytls tls share link: nodes=%d err=%v", len(tlsNodes), err)
	}

	for _, tc := range []struct {
		name, uri, want string
	}{
		{"missing-pbk", "anytls://any-pass@any.example.com:443?security=reality&sni=cdn.example.com#Bad", "缺少公钥"},
		{"unsupported-security", "anytls://any-pass@any.example.com:443?security=xtls#Bad", "安全层暂不支持"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Parse([]byte(tc.uri), "test"); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got err=%v want substring %q", err, tc.want)
			}
		})
	}
}

func TestFetchMeowXUserAgentAndFallback(t *testing.T) {
	t.Run("meowx-primary", func(t *testing.T) {
		var uas []string
		body := "proxies:\n  - {name: m, type: miu, server: example.com, port: 443, psk: \"0123456789abcdef\"}\n"
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			uas = append(uas, r.UserAgent())
			io.WriteString(w, body)
		}))
		defer server.Close()
		data, _, err := Fetch(context.Background(), server.Client(), server.URL)
		if err != nil || string(data) != body || len(uas) != 1 || uas[0] != subscriptionUserAgent {
			t.Fatalf("primary fetch: uas=%q data=%q err=%v", uas, data, err)
		}
		if nodes, err := Parse(data, "sub"); err != nil || len(nodes) != 1 || nodes[0].Type != "miu" {
			t.Fatalf("parse miu subscription: nodes=%+v err=%v", nodes, err)
		}
	})

	t.Run("clash-meta-fallback", func(t *testing.T) {
		var uas []string
		linkPayload := base64.StdEncoding.EncodeToString([]byte("anytls://pass@example.com:443#A\n"))
		clashBody := "proxies:\n  - {name: fallback, type: socks5, server: 203.0.113.10, port: 1080}\n"
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ua := r.UserAgent()
			uas = append(uas, ua)
			if strings.Contains(strings.ToLower(ua), "clash") {
				w.Header().Set("Subscription-Userinfo", "upload=1; download=2; total=10")
				io.WriteString(w, clashBody)
				return
			}
			io.WriteString(w, linkPayload)
		}))
		defer server.Close()
		data, usage, err := Fetch(context.Background(), server.Client(), server.URL)
		if err != nil || string(data) != clashBody || usage != "upload=1; download=2; total=10" {
			t.Fatalf("fallback fetch: usage=%q data=%q err=%v", usage, data, err)
		}
		if len(uas) != 2 || uas[0] != subscriptionUserAgent || uas[1] != fallbackSubscriptionUserAgent {
			t.Fatalf("unexpected fallback UA sequence: %q", uas)
		}
	})

	t.Run("base64-sharelink-preserved", func(t *testing.T) {
		var uas []string
		linkPayload := base64.StdEncoding.EncodeToString([]byte("anytls://pass@example.com:443?security=reality&pbk=CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA#R\n"))
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			uas = append(uas, r.UserAgent())
			w.Header().Set("Subscription-Userinfo", "upload=4; download=5")
			io.WriteString(w, linkPayload)
		}))
		defer server.Close()
		data, usage, err := Fetch(context.Background(), server.Client(), server.URL)
		if err != nil || string(data) != linkPayload || usage != "upload=4; download=5" || len(uas) != 2 {
			t.Fatalf("sharelink fetch: uas=%q usage=%q data=%q err=%v", uas, usage, data, err)
		}
		if nodes, err := Parse(data, "sub"); err != nil || len(nodes) != 1 || nodes[0].Type != "anytls" {
			t.Fatalf("parse base64 sharelink: nodes=%+v err=%v", nodes, err)
		}
	})
}
