# OpenTelemetry + Jaeger

Tracing dan korelasi request API v2:

- **`webtopup-node-gateway`** (Fastify): auth, rate-limit, proxy `/api/v2/*`, pemilik **`x-trace-id`** pada **semua** respons API (termasuk 400, 401, 403, 404, 429, 500, 502).
- **`webtopup-rust-api`** (Axum): rute `/v2/*` di belakang proxy Node.
- **Propagasi internal Node → Rust:** W3C `traceparent` / `tracestate` hanya saat OTEL aktif di gateway; header internal tepercaya **`x-webtopup-correlation-id`** (nilai sama dengan `x-trace-id` respons untuk request itu) dikirim gateway setelah strip/restamp — **bukan** dari klien.
- **Vendor eksternal (Digiflazz, TokoVoucher, webhook, dll.):** **tidak** menerima `traceparent`, `tracestate`, `baggage`, `x-trace-id`, atau `x-webtopup-correlation-id`. Kontrak URL `/v1` vendor tidak diubah.
- Trace/span **tidak** menyimpan token, proxy secret, request body, nomor tujuan, atau query string sensitif.

## Mode OTEL: on vs off

| Mode | `x-trace-id` respons | Jaeger / OTLP | Log & audit |
|------|----------------------|---------------|-------------|
| **OTEL on** (`OTEL_ENABLED=true` + endpoint OTLP) | ID gateway; selaras dengan trace ID span aktif yang diekspor | Trace yang sama dapat dicari di Jaeger (beberapa detik latency) | JSON log dengan `trace_id`; audit Node `auditSource=node_gateway`, Rust `auditSource=rust_domain` + `correlationSource` (`otel_span` \| `gateway_header` \| `absent`) |
| **OTEL off** | Tetap 32 hex lowercase non-zero (gateway-generated) | **Tidak ada jaminan** span di Jaeger | Korelasi via `x-trace-id`, log, dan metadata audit; upstream Rust dapat `x-webtopup-correlation-id` tanpa W3C dari klien |

Header inbound dari klien untuk `x-trace-id`, W3C, `x-api-v2-proxy-secret`, dan `x-webtopup-user-*` **dihapus** sebelum auth/proxy; respons selalu **restamp** ID gateway.

## Jalankan Jaeger Lokal

```bash
docker run --rm --name jaeger \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest
```

UI Jaeger:

```text
http://localhost:16686
```

OTLP HTTP endpoint yang dipakai aplikasi:

```text
http://localhost:4318/v1/traces
```

## Environment

Node gateway `server/.env`:

```env
OTEL_ENABLED=true
OTEL_SERVICE_NAME=webtopup-node-gateway
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces
OTEL_ENVIRONMENT=development
OTEL_LOG_LEVEL=warn
```

Rust API `rust-api/.env`:

```env
OTEL_ENABLED=true
OTEL_SERVICE_NAME=webtopup-rust-api
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces
OTEL_ENVIRONMENT=development
```

Matikan tracing tanpa menghapus konfigurasi:

```env
OTEL_ENABLED=false
```

Jika `OTEL_ENABLED` tidak diset, tracing hanya aktif ketika `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` diset eksplisit.

## Menjalankan Rust API (lokal)

```bash
cd rust-api
cargo run --bin webtopup-rust-api
```

Default port dari env: `API_V2_PORT=9010`. Node gateway biasanya `PORT=9005` dan mem-proxy ke Rust.

## Rollout (urutan deploy)

1. **Deploy Node** terlebih dahulu: strip inbound, hook global `x-trace-id`, restamp proxy + `x-webtopup-correlation-id`, cache settings tanpa menyimpan trace ID.
2. **Deploy Rust** berikutnya: resolver audit/log; jika Node lama (tanpa header internal), audit boleh `correlationSource=absent` — tidak crash.
3. Restart kedua service setelah perubahan `.env` OTEL.
4. Jalankan smoke di bawah; verifikasi log/audit, bukan hanya Jaeger.

## Rollback

- **Revert Node:** klien bisa kembali menyuntik header sampai versi hardening aktif; dokumentasikan risiko.
- **Revert Rust saja:** audit/log kembali ke perilaku sebelum resolver; trafik tidak diblokir.
- Rollback operasional = deploy binary/image versi sebelumnya; tidak wajib feature flag terpisah untuk strip/restamp.

## Query Di Jaeger UI (OTEL on)

Pilih service:

```text
webtopup-node-gateway
webtopup-rust-api
```

Operation yang berguna:

```text
api.v2.proxy GET /products
api.v2.proxy POST /transactions
GET /v2/products
POST /v2/transactions
```

Filter tag untuk request API v2:

```text
webtopup.api_version=v2
```

Filter method:

```text
http.request.method=POST
http.request.method=GET
```

Filter route proxy Node:

```text
webtopup.proxy.route=/transactions
webtopup.proxy.route=/products
webtopup.proxy.route=/guest-transactions
```

Filter status error:

```text
error=true
http.response.status_code=500
http.response.status_code=502
```

Filter upstream Rust path:

```text
webtopup.proxy.upstream_path=/v2/transactions
webtopup.proxy.upstream_path=/v2/products
```

Filter durasi di Jaeger:

```text
Min Duration: 500ms
Min Duration: 2s
```

Alur pengecekan paling cepat:

1. Pilih service `webtopup-node-gateway`.
2. Set tag `webtopup.api_version=v2`.
3. Tambahkan `error=true` untuk bug 5xx, atau `Min Duration: 500ms` untuk request lambat.
4. Buka trace. Span Node proxy harus punya child span dari `webtopup-rust-api` jika request sampai ke Rust.

Dari header respons (browser/API client):

```text
x-trace-id: 4bf92f3577b34da6a3ce929d0e0e4736
```

Tempel ID itu di kotak pencarian trace ID Jaeger **hanya ketika OTEL on** dan trace sudah ter-export.

## Audit & log (Node dan Rust)

- **Node admin audit:** `metadata.auditSource = node_gateway`; `metadata.correlationSource` = `otel_span` \| `gateway_header` \| `absent`; `metadata.traceId` bila tersedia. Kegagalan menulis audit **tidak** menghapus `x-trace-id` dari respons.
- **Rust validation-product audit:** `metadata.auditSource = rust_domain`; `metadata.correlationSource` sama; Rust **tidak** memakai `traceparent` mentah dari klien untuk audit — hanya span aktif atau `x-webtopup-correlation-id` setelah `require_proxy_context`.
- **Log terstruktur:** field `trace_id` (dan di Rust layer request tracing, `trace_id` pada event) — tanpa secret proxy, `Authorization`, body sensitif, atau PII.

Grep contoh (sesuaikan path log proses):

```bash
# Node — pastikan trace_id ada tanpa secret
journalctl -u webtopup-node -n 200 --no-pager 2>/dev/null | rg '"trace_id"' | head
# atau file log dev
rg '"trace_id"' server/logs/*.log 2>/dev/null | head

# Rust
rg 'trace_id' rust-api/logs/*.log 2>/dev/null | head
```

## Cache settings (`settings/public`)

Entri cache hanya menyimpan `expiresAt`, `status`, `headers`, `body` — **tanpa** trace ID. Setiap request (termasuk **cache HIT**) mendapat **`x-trace-id` baru** untuk request itu.

## Upload proxy

Satu span operasi `api.v2.proxy` (OTEL on) membungkus pembacaan multipart hingga fetch upstream upload; `x-trace-id` tetap gateway-owned pada respons.

## Smoke test & verifikasi korelasi

**Prasyarat:** Node listening (mis. `http://localhost:9005`), Rust jika endpoint proxy membutuhkannya (`http://localhost:9010`). Proses yang berjalan bisa binary lama — catat versi/commit jika hasil tidak selaras dengan docs.

Ganti `BASE=http://localhost:9005` jika perlu.

### Spoof — header klien diabaikan, ID gateway di respons

```bash
BASE=http://localhost:9005
curl -i -sS "$BASE/api/v2/health" \
  -H 'x-trace-id: deadbeefdeadbeefdeadbeefdeadbeef' \
  -H 'traceparent: 00-deadbeefdeadbeefdeadbeefdeadbeef-deadbeefdeadbeef-01' \
  -H 'x-api-v2-proxy-secret: fake' \
  -H 'x-webtopup-user-id: fake' | tee /tmp/smoke-spoof.txt
```

Harapan: baris `x-trace-id:` **bukan** `deadbeef...`; 32 karakter hex lowercase; tidak all-zero.

### Status error — `x-trace-id` tetap ada

Tidak semua status dapat dipaksa secara trivial di setiap lingkungan lokal. Gunakan kombinasi **observasi alami** dan **fault injection terkontrol** di bawah.

| Status | Cara umum (lokal) | Catatan |
|--------|-------------------|---------|
| **400** | Body/query tidak valid pada rute yang memvalidasi gateway | Contoh: POST dengan JSON rusak ke rute yang parse body |
| **401** | Rute terproteksi tanpa `Authorization` | Dapat diobservasi |
| **403** | Token valid tanpa permission / akses langsung Rust tanpa secret | Rust direct: `curl -i http://localhost:9010/v2/products` → **403** |
| **404** | Path tidak ada | Dapat diobservasi |
| **429** | Burst request ke rute rate-limited | Butuh banyak request; tidak selalu dipaksa di dev |
| **500** | Bug atau data rusak di handler | Sering butuh skenario data khusus — jangan klaim “mudah” di semua env |
| **502** | Rust/downstream mati atau URL upstream salah | **Kontrol:** hentikan Rust sementara atau set upstream tidak reachable, lalu `curl -i "$BASE/api/v2/products"` |

Contoh yang biasanya dapat dijalankan:

```bash
# 401 — endpoint admin tanpa token (sesuaikan path jika berbeda)
curl -i -sS "$BASE/api/v2/validation-products/taxonomy/categories" | rg -i 'HTTP/|x-trace-id:'

# 404
curl -i -sS "$BASE/api/v2/this-route-does-not-exist" | rg -i 'HTTP/|x-trace-id:'

# 403 — langsung ke Rust tanpa proxy secret (rute terproteksi /v2/*, bukan /health yang publik)
curl -i -sS "http://localhost:9010/v2/products" | rg -i 'HTTP/'
# Harapan: HTTP 403 Forbidden. Respons Rust langsung **tidak** menjamin header `x-trace-id` (pemilik header publik adalah Node gateway).

# 502 — kontrol: pastikan Rust tidak listening atau upstream error, lalu:
curl -i -sS "$BASE/api/v2/products" | rg -i 'HTTP/|x-trace-id:'
```

Respons melalui **Node gateway** (`$BASE/api/v2/...`) harus memuat **`x-trace-id`** pada status yang tercantum (grep case-insensitive). Akses **langsung ke Rust** (`http://localhost:9010/...`) memvalidasi trust boundary (mis. 403 tanpa secret), bukan kontrak header respons klien.

### Cache HIT — ID segar per request

```bash
# Dua hit berurutan ke settings public (path sesuai deploy)
curl -i -sS "$BASE/api/v2/settings/public" | rg -i 'x-trace-id:'
curl -i -sS "$BASE/api/v2/settings/public" | rg -i 'x-trace-id:'
```

Harapan: dua nilai `x-trace-id` **berbeda** (dua request berbeda).

### Health / products (OTEL on — Jaeger)

```bash
curl -sS "$BASE/api/v2/health"
curl -sS "$BASE/api/v2/products"
```

Trace biasanya muncul di Jaeger dalam beberapa detik jika `OTEL_ENABLED=true` dan OTLP reachable.

### JSON `trace_id` (Rust / layer tracing)

Pada request yang diproses Rust dengan OTEL on, log atau span fields dapat memuat `trace_id` selaras dengan rantai trace — verifikasi via Jaeger child span `webtopup-rust-api` atau log Rust, bukan dari header vendor.

### OTEL off — korelasi tanpa Jaeger

Set `OTEL_ENABLED=false`, restart Node (dan Rust jika perlu). Ulangi `curl -i` spoof/health; **`x-trace-id` tetap ada**; Jaeger **tidak** dijanjikan; log/audit tetap memakai resolver gateway/internal header.

## Troubleshooting export

- `OTEL_ENABLED=true` di kedua service.
- Endpoint OTLP `http://localhost:4318/v1/traces` dapat diakses dari host/container aplikasi.
- Service direstart setelah `.env` diubah.
- Tidak ada firewall yang menutup port `4318`.

## Checklist review docs (manual)

Sebelum release, pastikan dokumen ini memuat eksplisit:

- [ ] `OTEL_ENABLED` on/off dan perbedaan Jaeger vs log/audit
- [ ] `x-trace-id` pada 400/401/403/404/429/500/502
- [ ] spoof strip + `curl -i`
- [ ] cache HIT tanpa trace tersimpan + ID baru
- [ ] upload span (OTEL on)
- [ ] audit `node_gateway` / `rust_domain` + `correlationSource`
- [ ] tidak ada propagasi ke vendor
- [ ] rollout Node → Rust dan rollback
- [ ] perintah smoke di atas