# AGENTS.md — Drive-backed S3 Gateway

## 1. Peran agent

Anda adalah coding agent utama untuk membangun aplikasi multi-user yang:

1. Mengizinkan pengguna dalam **satu organisasi Google Workspace** masuk menggunakan Google OAuth.
2. Menyimpan file bucket ke **My Drive pemilik** atau Google **Shared Drive** yang dipilih secara eksplisit.
3. Menyediakan dashboard web memakai **shadcn/ui + Tailwind CSS**.
4. Menyediakan endpoint **S3-compatible** agar aplikasi seperti AWS CLI, AWS SDK, `rclone`, dan klien S3 lain dapat membaca serta menulis file.
5. Menggunakan **Bun + TypeScript** untuk runtime, package manager, test runner, dan tooling.
6. Menggunakan **SQLite melalui `bun:sqlite`** untuk metadata, sesi, kredensial, dan indeks object.

Nama kerja proyek: **DriveS3 Gateway**.

Seluruh implementasi harus mengikuti dokumen ini. Jangan mengganti stack utama tanpa alasan teknis yang terdokumentasi.

---

## 2. Tujuan produk

Setiap pengguna memiliki storage yang terisolasi:

```text
User A + access key A
        │
        ▼
DriveS3 Gateway
        │ OAuth token User A
        ▼
My Drive User A / DriveS3 Gateway / buckets / ...

User B + access key B
        │
        ▼
DriveS3 Gateway
        │ OAuth token User B
        ▼
My Drive User B / DriveS3 Gateway / buckets / ...
```

Aplikasi hanya menyediakan control plane, metadata, dan adapter protokol. Isi object tetap berada di Google Drive pengguna.

### Prinsip wajib

- Bucket lama dan S3 `CreateBucket` standar tetap menggunakan My Drive secara default.
- Bucket Shared Drive hanya dibuat melalui control plane dengan target immutable.
- Akses Shared Drive melalui S3 diberikan kepada pengguna DriveS3 terpilih sebagai Viewer atau Editor; membership Google Shared Drive saja tidak memberikan akses namespace S3.
- Setiap anggota memakai OAuth Google miliknya sendiri dan harus tetap menjadi anggota Shared Drive.
- Jangan menggunakan service account untuk memiliki file.
- Jangan menyimpan isi object secara permanen di server aplikasi.
- File sementara diperbolehkan hanya untuk multipart upload dan harus memiliki TTL serta proses cleanup.
- Kredensial S3 dapat mengakses bucket milik pengguna dan bucket Shared Drive yang dibagikan secara eksplisit sesuai role.
- SQLite adalah sumber kebenaran untuk namespace S3 dan pemetaan `bucket/key -> Google Drive fileId`.
- Google Drive adalah penyimpanan byte/object, bukan sumber kebenaran untuk listing namespace S3.
- Gunakan stable ID, bukan nama/path Google Drive, sebagai identitas internal.

---

## 3. Batas lingkup

### MVP wajib

#### Web dan akun

- Login Google OAuth.
- Pembatasan ke satu domain Google Workspace.
- Penyimpanan refresh token terenkripsi.
- Dashboard status koneksi Drive.
- Pembuatan/revoke access key S3.
- Daftar bucket.
- Daftar object.
- Upload, download, dan delete melalui dashboard.
- Audit log dasar.

#### S3-compatible API

Implementasikan operasi berikut:

- `GET /` — ListBuckets
- `PUT /{bucket}` — CreateBucket
- `HEAD /{bucket}` — HeadBucket
- `DELETE /{bucket}` — DeleteBucket
- `GET /{bucket}?list-type=2` — ListObjectsV2
- `PUT /{bucket}/{key...}` — PutObject
- `GET /{bucket}/{key...}` — GetObject
- `HEAD /{bucket}/{key...}` — HeadObject
- `DELETE /{bucket}/{key...}` — DeleteObject
- `POST /{bucket}?delete` — DeleteObjects
- `PUT /{bucket}/{key...}` dengan `x-amz-copy-source` — CopyObject
- Presigned GET dan PUT dengan AWS Signature Version 4
- HTTP byte range untuk GetObject
- Conditional GET dasar:
  - `If-Match`
  - `If-None-Match`
  - `If-Modified-Since`
  - `If-Unmodified-Since`

#### Multipart S3

Implementasikan:

- `POST /{bucket}/{key}?uploads` — CreateMultipartUpload
- `PUT /{bucket}/{key}?partNumber=N&uploadId=...` — UploadPart
- `GET /{bucket}/{key}?uploadId=...` — ListParts
- `POST /{bucket}/{key}?uploadId=...` — CompleteMultipartUpload
- `DELETE /{bucket}/{key}?uploadId=...` — AbortMultipartUpload

Multipart part disimpan sementara di disk lokal. Saat complete, gabungkan part secara streaming dan upload ke Google Drive dengan resumable upload. Jangan memuat seluruh object ke RAM.

### Di luar MVP

Jangan mengklaim dukungan untuk fitur berikut sebelum benar-benar diimplementasikan dan diuji:

- S3 Object Lock
- ACL S3
- Bucket policy
- IAM policy language
- Object versioning
- Lifecycle rules
- Cross-region replication
- S3 Select
- Website hosting
- Event notifications
- SSE-KMS
- Virtual-hosted-style bucket endpoint
- AWS Signature Version 4A
- Multi-region access point
- BitTorrent
- Restore/Glacier semantics

Kembalikan error S3 yang jelas, biasanya `NotImplemented`, untuk operasi yang belum didukung.

---

## 4. Stack teknologi

### Backend

- Bun, TypeScript, strict mode TypeScript.
- HTTP server: `Bun.serve`.
- Database: built-in `bun:sqlite`.
- API Google: panggil REST API Google secara langsung dengan `fetch`, atau gunakan library Google resmi hanya jika kompatibel baik dengan Bun.
- XML S3: gunakan library XML kecil yang aman atau serializer internal yang melakukan escaping dengan benar.
- Cryptography: Web Crypto API atau `node:crypto` yang tersedia di Bun.
- UUID: `crypto.randomUUID()`.
- Hash streaming:
  - MD5 untuk ETag kompatibilitas single-part.
  - SHA-256 untuk validasi SigV4 dan checksum internal.
- Jangan menambahkan ORM berat. Gunakan repository layer tipis di atas prepared statements `bun:sqlite`.

### Frontend

- React **18**, bukan React 19.
- Gunakan shadcn/ui dengan primitive Radix UI, Tailwind CSS, dan Lucide icons.
- Build frontend dengan Vite yang dijalankan melalui Bun.
- Gunakan CSS variables semantik dan utility Tailwind; jangan hard-code warna status di halaman.
- Simpan primitive reusable di `components/ui` dan pola aplikasi di `components`.
- Semua dialog harus memakai primitive Radix agar focus trap dan restoration terjaga.
- Sediakan light/dark mode melalui theme provider aplikasi dengan preferensi tersimpan dan fallback sistem.
- `React.StrictMode` belum diaktifkan pada bootstrap saat ini; perubahan mode ini harus diverifikasi terpisah dari migrasi visual.

### Package manager

Gunakan Bun:

```bash
bun install
bun add <package>
bun add -d <package>
bun run <script>
bun test
```

Contoh dependency frontend:

```bash
bun add react@18.2.0 react-dom@18.2.0
bun add @radix-ui/react-dialog @radix-ui/react-alert-dialog @radix-ui/react-label @radix-ui/react-slot
bun add class-variance-authority clsx lucide-react tailwind-merge
bun add -d tailwindcss postcss autoprefixer vite @vitejs/plugin-react typescript
bun add -d @types/react@18 @types/react-dom@18
```

Pin versi final di `package.json` dan commit `bun.lock`.

### Catatan kompatibilitas frontend

Proyek tetap diwajibkan memakai Bun, React 18, dan Vite. Agent harus:

- menjalankan smoke test browser setelah upgrade dependency UI atau Radix;
- mem-pin React 18 serta dependency UI yang telah lulus test;
- memverifikasi keyboard/focus behavior pada dialog dan mobile sheet;
- tidak melakukan upgrade major otomatis;
- memastikan output Vite tetap berada pada prefix flat `__drives3_assets`;
- tidak diam-diam mengganti package manager tanpa mengubah keputusan arsitektur.

---

## 5. Struktur repository

Gunakan monorepo sederhana:

```text
.
├── AGENTS.md
├── README.md
├── package.json
├── bun.lock
├── tsconfig.json
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── apps/
│   ├── server/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── config.ts
│   │       ├── routes/
│   │       │   ├── auth.ts
│   │       │   ├── api.ts
│   │       │   ├── health.ts
│   │       │   └── s3.ts
│   │       ├── auth/
│   │       │   ├── google-oauth.ts
│   │       │   ├── session.ts
│   │       │   └── s3-sigv4.ts
│   │       ├── drive/
│   │       │   ├── client.ts
│   │       │   ├── oauth-token.ts
│   │       │   ├── upload.ts
│   │       │   ├── download.ts
│   │       │   └── reconcile.ts
│   │       ├── s3/
│   │       │   ├── router.ts
│   │       │   ├── operations/
│   │       │   ├── xml.ts
│   │       │   ├── errors.ts
│   │       │   ├── etag.ts
│   │       │   └── multipart.ts
│   │       ├── db/
│   │       │   ├── connection.ts
│   │       │   ├── migrate.ts
│   │       │   ├── migrations/
│   │       │   └── repositories/
│   │       ├── security/
│   │       │   ├── encryption.ts
│   │       │   ├── csrf.ts
│   │       │   └── rate-limit.ts
│   │       ├── jobs/
│   │       │   ├── orphan-cleanup.ts
│   │       │   ├── multipart-cleanup.ts
│   │       │   └── token-health.ts
│   │       └── observability/
│   │           ├── logger.ts
│   │           └── metrics.ts
│   └── web/
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── api/
│           ├── components/
│           ├── pages/
│           └── theme/
├── packages/
│   └── shared/
│       └── src/
├── data/
│   ├── app.sqlite
│   └── multipart/
└── tests/
    ├── unit/
    ├── integration/
    └── compatibility/
```

---

## 6. Environment variables

Buat `.env.example`:

```dotenv
NODE_ENV=development
APP_NAME=DriveS3 Gateway
APP_ORIGIN=http://localhost:3000
SERVER_HOST=0.0.0.0
SERVER_PORT=3000

# Hanya domain Workspace ini yang boleh login.
GOOGLE_WORKSPACE_DOMAIN=example.com
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
GOOGLE_DRIVE_SCOPE=https://www.googleapis.com/auth/drive

# Base64 dari tepat 32 byte acak.
MASTER_ENCRYPTION_KEY=

# Base64 dari minimal 32 byte acak.
SESSION_SECRET=

SQLITE_PATH=./data/app.sqlite
MULTIPART_TEMP_DIR=./data/multipart
MULTIPART_TTL_HOURS=24
ORPHAN_RETENTION_HOURS=24

# Upload lebih besar dari nilai ini memakai resumable upload.
DRIVE_RESUMABLE_THRESHOLD_BYTES=5242880
DRIVE_UPLOAD_CHUNK_BYTES=8388608

# trash atau permanent
S3_DELETE_MODE=trash

# Endpoint publik yang diberikan kepada klien S3.
S3_PUBLIC_ENDPOINT=http://localhost:3000
S3_REGION=us-east-1
S3_REQUIRE_TLS=false

MAX_SINGLE_PUT_BYTES=5368709120
MAX_MULTIPART_OBJECT_BYTES=536870912000
MAX_PARTS=10000
MIN_MULTIPART_PART_BYTES=5242880

LOG_LEVEL=info
TRUST_PROXY=false
```

Validasi semua environment variable saat startup. Hentikan startup dengan pesan jelas jika konfigurasi keamanan tidak valid.

---

## 7. Google OAuth dan isolasi organisasi

### Scope

Default:

```text
openid
email
profile
https://www.googleapis.com/auth/drive.file
```

Shared Drive adalah kebutuhan produk eksplisit. Gunakan scope `drive` yang dikonfigurasi untuk enumerasi Shared Drive dan operasi per-member, deteksi grant lama, dan minta consent ulang secara jelas.

### Flow

1. `GET /auth/google/start`
2. Generate:
   - `state` acak
   - PKCE verifier dan challenge jika flow/library mendukung
3. Redirect ke Google dengan:
   - `response_type=code`
   - `access_type=offline`
   - `include_granted_scopes=true`
   - `prompt=consent` hanya saat dibutuhkan untuk memperoleh refresh token
   - `hd=<GOOGLE_WORKSPACE_DOMAIN>` sebagai UX hint
4. Callback memverifikasi `state`.
5. Exchange authorization code di backend.
6. Verifikasi ID token:
   - issuer valid
   - audience sama dengan `GOOGLE_CLIENT_ID`
   - token belum kedaluwarsa
   - email terverifikasi
   - claim `hd` sama persis dengan `GOOGLE_WORKSPACE_DOMAIN`
7. Jangan mengandalkan parameter `hd` dari request sebagai kontrol keamanan.
8. Enkripsi refresh token sebelum masuk SQLite.
9. Access token boleh disimpan sementara di memori, bukan log.
10. Buat session cookie:
    - `HttpOnly`
    - `Secure` di production
    - `SameSite=Lax`
    - rotasi ID setelah login
    - TTL terbatas

### Folder root pengguna

Setelah login pertama:

1. Cari folder aplikasi yang dibuat oleh aplikasi menggunakan `appProperties`.
2. Jika tidak ada, buat folder berikut di root My Drive:

```text
My Drive/
└── DriveS3 Gateway/
```

3. Folder harus memiliki marker private:

```json
{
  "appProperties": {
    "drives3Type": "root",
    "drives3UserId": "<UUID internal>"
  }
}
```

Jangan meletakkan email, token, key, atau data sensitif di nama file maupun `appProperties`.

---

## 8. Model penyimpanan Google Drive

### Representasi

Gunakan struktur yang mudah dilihat pengguna tetapi jangan bergantung pada struktur tersebut untuk listing S3:

```text
DriveS3 Gateway/
└── buckets/
    ├── bucket-uuid-1/
    │   ├── object-uuid-1.blob
    │   └── object-uuid-2.blob
    └── bucket-uuid-2/
```

Nama folder bucket yang terlihat boleh menyertakan nama bucket secara aman, misalnya:

```text
documents [bkt_01J...]
```

Nama file object harus berbasis UUID internal, bukan key mentah:

```text
obj_01J....blob
```

Alasan:

- Key S3 dapat berisi `/`, Unicode, dan karakter yang tidak cocok sebagai nama/path.
- Nama yang sama dapat muncul di Drive.
- Pengguna dapat memindahkan atau mengganti nama file di Drive.
- Pemetaan tetap stabil melalui `fileId`.

### Marker `appProperties`

Setiap folder bucket:

```json
{
  "appProperties": {
    "drives3Type": "bucket",
    "drives3BucketId": "<UUID>"
  }
}
```

Setiap file object:

```json
{
  "appProperties": {
    "drives3Type": "object",
    "drives3ObjectId": "<UUID>",
    "drives3BucketId": "<UUID>"
  }
}
```

Jangan menyimpan full object key dalam `appProperties`; panjang custom property Google Drive terbatas. Full key disimpan di SQLite.

### Upload

- Jangan melakukan konversi ke format Google Docs.
- Selalu upload sebagai blob dengan MIME type object.
- Untuk file kecil, multipart upload Google Drive dapat dipakai.
- Untuk file besar atau koneksi yang dapat terputus, gunakan resumable upload.
- Retry `429`, `403 rateLimitExceeded`, dan `5xx` dengan exponential backoff + jitter.
- Hormati `Retry-After`.
- Batasi retry agar request tidak menggantung tanpa batas.

### Download

- Gunakan `files.get?alt=media`.
- Forward `Range` ke Google Drive untuk partial download.
- Streaming response ke klien; jangan buffer seluruh file.
- Abort fetch ke Drive saat klien memutus koneksi.

### Overwrite object

Untuk `PUT` pada key yang sudah ada:

1. Upload file Drive baru sebagai staging.
2. Hitung checksum saat streaming.
3. Setelah upload sukses, buka transaksi SQLite.
4. Update row object agar menunjuk ke `fileId` baru.
5. Commit transaksi.
6. Trash atau delete file Drive lama sesuai konfigurasi.
7. Jika langkah 3–5 gagal, tandai file baru sebagai orphan.
8. Cleanup job menghapus orphan setelah retention.

Jangan update file lama in-place karena kegagalan di tengah upload dapat merusak object aktif.

### Delete object

- Hapus row namespace dari transaksi SQLite sehingga object langsung tidak terlihat oleh S3.
- Setelah commit, trash/delete file Drive.
- Jika Google Drive gagal, masukkan ke antrean cleanup.
- Delete object yang tidak ada tetap mengembalikan sukses sesuai perilaku umum S3.

---

## 9. SQLite

### Startup pragmas

Saat membuka database:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

MVP hanya mendukung satu instance aplikasi yang menulis ke file SQLite lokal. Jangan menjalankan beberapa replica pada shared/NFS volume.

### Migrasi

- Semua migrasi harus berurutan dan immutable.
- Simpan versi di tabel `schema_migrations`.
- Migrasi dijalankan saat startup sebelum server menerima traffic.
- Backup database sebelum migrasi destruktif.

### Schema minimum

#### `users`

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  hosted_domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);
```

#### `oauth_accounts`

```sql
CREATE TABLE oauth_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_refresh_token TEXT NOT NULL,
  granted_scopes TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  last_refresh_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### `sessions`

```sql
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_secret TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT,
  ip_hash TEXT
);
```

#### `drive_roots`

```sql
CREATE TABLE drive_roots (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  drive_folder_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL
);
```

#### `s3_credentials`

```sql
CREATE TABLE s3_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_key_id TEXT NOT NULL UNIQUE,
  encrypted_secret_key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_s3_credentials_user
  ON s3_credentials(user_id);
```

Secret tidak boleh disimpan hanya sebagai hash karena verifier SigV4 memerlukan secret asli. Simpan dengan authenticated encryption.

#### `buckets`

```sql
CREATE TABLE buckets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'us-east-1',
  drive_folder_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('creating', 'active', 'deleting', 'error')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, name)
);

CREATE INDEX idx_buckets_user
  ON buckets(user_id, name);
```

Bucket name wajib divalidasi secara konservatif:

```text
3–63 karakter
huruf kecil, angka, titik, dan tanda minus
dimulai/diakhiri huruf atau angka
tidak menyerupai alamat IPv4
```

Bucket hanya unik per pengguna, bukan global seperti AWS S3.

#### `objects`

```sql
CREATE TABLE objects (
  id TEXT PRIMARY KEY,
  bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  etag TEXT NOT NULL,
  checksum_sha256 TEXT,
  storage_class TEXT NOT NULL DEFAULT 'STANDARD',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  cache_control TEXT,
  content_disposition TEXT,
  content_encoding TEXT,
  content_language TEXT,
  expires_at TEXT,
  last_modified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(bucket_id, object_key)
);

CREATE INDEX idx_objects_listing
  ON objects(bucket_id, object_key);
```

`object_key` disimpan apa adanya sebagai UTF-8. Listing diurutkan secara byte/lexicographical konsisten dan harus diuji terhadap AWS SDK.

#### `multipart_uploads`

```sql
CREATE TABLE multipart_uploads (
  id TEXT PRIMARY KEY,
  bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completing', 'completed', 'aborted', 'expired')),
  initiated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);
```

#### `multipart_parts`

```sql
CREATE TABLE multipart_parts (
  upload_id TEXT NOT NULL REFERENCES multipart_uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  temp_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  etag TEXT NOT NULL,
  checksum_sha256 TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(upload_id, part_number)
);
```

Validasi bahwa `temp_path` selalu berada di bawah `MULTIPART_TEMP_DIR`. Jangan menerima path dari pengguna.

#### `pending_cleanup`

```sql
CREATE TABLE pending_cleanup (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL
    CHECK (resource_type IN ('drive_file', 'temp_file')),
  resource_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL
);
```

#### `audit_logs`

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  credential_id TEXT REFERENCES s3_credentials(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  bucket_name TEXT,
  object_key TEXT,
  status_code INTEGER,
  request_id TEXT NOT NULL,
  bytes_in INTEGER,
  bytes_out INTEGER,
  ip_hash TEXT,
  user_agent TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_logs_user_time
  ON audit_logs(user_id, created_at DESC);
```

Jangan menyimpan access token, refresh token, secret key, header Authorization, atau presigned signature di audit log.

---

## 10. Enkripsi data sensitif

Gunakan AES-256-GCM dengan `MASTER_ENCRYPTION_KEY`.

Format envelope yang disarankan:

```json
{
  "v": 1,
  "alg": "A256GCM",
  "iv": "<base64>",
  "ciphertext": "<base64>",
  "tag": "<base64>"
}
```

Gunakan AAD yang mengikat ciphertext ke konteks:

```text
oauth-refresh-token:<userId>
s3-secret:<credentialId>
```

Ketentuan:

- IV unik dan acak untuk setiap enkripsi.
- Verifikasi authentication tag sebelum memakai plaintext.
- Jangan mencetak plaintext ke log.
- Siapkan `token_version`/`key_version` agar key rotation dapat ditambahkan.
- Access key ID boleh disimpan plaintext.
- Secret access key hanya ditampilkan satu kali ketika dibuat.
- Revoke credential harus langsung membuat semua request berikutnya gagal.

---

## 11. S3 authentication — AWS Signature Version 4

Dukung:

- Authorization header SigV4.
- Presigned query SigV4.
- Signed payload.
- `UNSIGNED-PAYLOAD` untuk presigned request sesuai kebutuhan.
- Region default `S3_REGION`.
- Service harus `s3`.

Verifier harus:

1. Parse `Credential`, `SignedHeaders`, dan `Signature`.
2. Cari `access_key_id` aktif.
3. Dekripsi secret hanya selama verifikasi.
4. Validasi timestamp dan maksimum clock skew, default 15 menit untuk header-signed request.
5. Bangun canonical request secara tepat:
   - method
   - canonical URI
   - canonical query string
   - canonical headers
   - signed headers
   - payload hash
6. Bangun string-to-sign.
7. Derive signing key.
8. Bandingkan signature secara constant-time.
9. Tolak signed header yang hilang atau berubah.
10. Hapus plaintext secret dari scope secepat mungkin.

Gunakan fixture resmi AWS SigV4 sebagai unit test. Jangan membuat implementasi “mirip SigV4” yang hanya cocok dengan satu client.

### Endpoint style

MVP hanya menjamin **path-style**:

```text
https://storage.example.com/my-bucket/path/to/file.bin
```

Contoh AWS SDK:

```ts
import { S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: "https://storage.example.com",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
});
```

Virtual-hosted style tidak wajib pada MVP.

---

## 12. S3 response dan error

Semua response S3 harus mengikuti status code dan XML shape yang diharapkan client.

Contoh error:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
  <Key>path/to/file.txt</Key>
  <RequestId>req_...</RequestId>
</Error>
```

Minimal error mapping:

| Kondisi | S3 Code | HTTP |
|---|---|---:|
| Access key tidak dikenal | `InvalidAccessKeyId` | 403 |
| Signature salah | `SignatureDoesNotMatch` | 403 |
| Bucket tidak ada | `NoSuchBucket` | 404 |
| Key tidak ada | `NoSuchKey` | 404 |
| Bucket sudah ada pada user | `BucketAlreadyOwnedByYou` | 409 |
| Delete bucket tidak kosong | `BucketNotEmpty` | 409 |
| Multipart upload tidak ada | `NoSuchUpload` | 404 |
| Part terlalu kecil | `EntityTooSmall` | 400 |
| Body terlalu besar | `EntityTooLarge` | 400 |
| Request tidak didukung | `NotImplemented` | 501 |
| Token Google dicabut | `InvalidToken` atau `AccessDenied` | 403 |
| Quota Drive terlampaui | `SlowDown` atau `ServiceUnavailable` | 503 |

Selalu sertakan:

- `x-amz-request-id`
- `Date`
- `ETag` jika relevan
- `Last-Modified` jika relevan
- `Accept-Ranges: bytes` pada GetObject

---

## 13. Semantik object

### ETag

Single-part object:

```text
ETag = hex MD5 dari body
```

Response header harus memakai tanda kutip:

```text
ETag: "d41d8cd98f00b204e9800998ecf8427e"
```

Multipart object:

```text
ETag = MD5(concat(binary MD5 setiap part)) + "-" + jumlahPart
```

Simpan ETag yang telah dihitung di SQLite.

### Metadata

Dukung header:

- `Content-Type`
- `Cache-Control`
- `Content-Disposition`
- `Content-Encoding`
- `Content-Language`
- `Expires`
- `x-amz-meta-*`

Normalisasikan nama metadata ke lowercase untuk penyimpanan, tetapi kirim kembali dalam format header yang valid.

Batasi:

- jumlah metadata
- panjang nama
- panjang nilai
- total byte metadata

Jangan memasukkan metadata user ke `appProperties` Drive tanpa validasi.

### ListObjectsV2

Dukung:

- `prefix`
- `delimiter`
- `max-keys`
- `continuation-token`
- `start-after`
- URL encoding jika `encoding-type=url`

Continuation token harus opaque dan ditandatangani, misalnya base64url payload + HMAC:

```json
{
  "bucketId": "...",
  "afterKey": "...",
  "prefix": "...",
  "delimiter": "/",
  "exp": 1234567890
}
```

Jangan menerima SQL offset mentah dari client sebagai token.

### Key

- Boleh kosong hanya jika operasi S3 memang mengizinkan; PutObject membutuhkan key non-kosong.
- Maksimum 1024 byte UTF-8.
- Jangan melakukan path normalization.
- `a//b`, `a/./b`, dan `a/b` adalah key yang berbeda.
- Decode URL tepat satu kali.
- Tolak invalid percent encoding.
- Jangan menggunakan key sebagai filesystem path.

---

## 14. Multipart upload

### Penyimpanan part

Path internal:

```text
<MULTIPART_TEMP_DIR>/<uploadId>/<partNumber>.part
```

Proteksi:

- `uploadId` harus UUID/ULID buatan server.
- `partNumber` integer 1–10000.
- Gunakan path builder internal.
- Cegah symlink traversal.
- Buat file dengan permission terbatas.
- Hitung MD5 dan SHA-256 saat streaming ke disk.
- Jika part dengan nomor sama di-upload ulang, ganti secara atomik.

### Complete

1. Parse XML daftar part.
2. Validasi upload masih `open`.
3. Validasi urutan part naik.
4. Validasi ETag setiap part.
5. Semua part kecuali part terakhir harus memenuhi ukuran minimum.
6. Ubah status menjadi `completing`.
7. Stream concat part ke Google Drive resumable upload.
8. Hitung checksum object final selama streaming.
9. Buat/update object secara atomik.
10. Tandai upload `completed`.
11. Hapus part sementara.
12. Jika gagal, status kembali `open` bila aman atau `aborted/error` dengan cleanup.

Gunakan locking per `uploadId` agar Complete dan Abort tidak berjalan bersamaan.

### Cleanup

Job periodik:

- Multipart `open` melewati TTL -> `expired`.
- Hapus seluruh temp part.
- Bersihkan direktori kosong.
- Catat audit event.
- Batasi jumlah item per batch agar tidak memblokir event loop.

---

## 15. API control plane

Semua endpoint `/api/*` memakai session web, bukan SigV4.

### Endpoint minimum

```text
GET    /api/me
GET    /api/drive/status
POST   /api/drive/reconnect
POST   /api/drive/reconcile

GET    /api/credentials
POST   /api/credentials
DELETE /api/credentials/:id

GET    /api/buckets
POST   /api/buckets
GET    /api/buckets/:id
DELETE /api/buckets/:id

GET    /api/buckets/:id/objects
POST   /api/buckets/:id/objects
GET    /api/buckets/:id/objects/:objectId/download
DELETE /api/buckets/:id/objects/:objectId

GET    /api/audit
GET    /api/system/compatibility
```

Gunakan JSON envelope konsisten:

```json
{
  "data": {},
  "requestId": "req_..."
}
```

Error:

```json
{
  "error": {
    "code": "DRIVE_TOKEN_REVOKED",
    "message": "Google Drive perlu dihubungkan kembali."
  },
  "requestId": "req_..."
}
```

---

## 16. Dashboard dengan shadcn/ui

### Setup dasar

Entry React:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
```

Bootstrap saat ini tetap React 18 tanpa Strict Mode. Evaluasi Strict Mode dilakukan sebagai perubahan terpisah.

### Layout

Gunakan primitive shadcn dan komponen aplikasi berikut:

- semantic `header`, `aside`, `nav`, dan `main`
- `AppShell` dengan sidebar desktop serta `Sheet` mobile
- `Card` untuk panel dan stat tile
- `Table` dengan row header semantik dan overflow responsif
- `Button`, termasuk icon button berlabel
- `Input` dan `Label` dalam semantic form
- `Alert` dan `EmptyState`
- `Badge` dengan variant semantik
- `Dialog` untuk form dan detail
- `AlertDialog` untuk konfirmasi destruktif
- `CopyableCode` untuk secret dan snippet
- `Spinner`/loading state yang memiliki accessible label
- Lucide icons; jangan menambah deep import asset internal package

### Halaman

#### Login

- Logo/nama aplikasi.
- Tombol “Masuk dengan Google”.
- Keterangan bahwa file disimpan di My Drive pengguna.
- Tampilkan domain Workspace yang diizinkan.
- Jangan menampilkan form password lokal.

#### Overview

Cards:

- Status Google Drive
- Jumlah bucket
- Jumlah object
- Total byte terindeks
- Access key aktif
- Multipart upload aktif
- Error Drive terbaru

#### Buckets

- Table nama, object count, size, created time, status.
- Create bucket modal.
- Delete bucket dengan konfirmasi.
- Bucket non-empty tidak boleh dihapus.

#### Object browser

- Breadcrumb virtual berdasarkan prefix key, bukan folder Drive.
- Search/prefix filter.
- Upload dengan drag-and-drop.
- Progress upload.
- Download dan delete.
- Tampilkan ETag, size, MIME type, last modified.
- Jangan mengekspos `drive_file_id` kecuali pada halaman diagnostic admin.

#### S3 credentials

Saat create:

- Label credential.
- Tampilkan `accessKeyId`.
- Tampilkan secret hanya satu kali.
- Tombol copy.
- Peringatan bahwa secret tidak dapat dilihat kembali.
- Contoh konfigurasi AWS CLI dan AWS SDK dengan `forcePathStyle`.

#### Activity

- Audit table.
- Filter action, bucket, status, tanggal.
- Jangan menampilkan token/signature.

#### Settings

- Theme light/dark.
- Endpoint S3.
- Region.
- Status OAuth.
- Reconnect Google.
- Revoke session lain bila fitur tersedia.
- Compatibility matrix.

### Aksesibilitas

- Gunakan label form yang terlihat.
- Keyboard navigation.
- Focus management melalui primitive Radix; verifikasi trap dan restoration.
- Kontras sesuai theme token.
- Icon-only button wajib memiliki `aria-label`.
- Error form harus terhubung dengan field.
- Jangan mengandalkan warna sebagai satu-satunya indikator.

---

## 17. Streaming dan resource limits

### PutObject

- Stream request body ke Google Drive.
- Untuk body dengan `Content-Length` diketahui, validasi ukuran sebelum upload.
- Untuk chunked body, hentikan saat melebihi limit.
- Jangan menggunakan `await request.arrayBuffer()` untuk object besar.
- Backpressure harus dipertahankan.
- Batalkan upload Drive jika client disconnect.

### GetObject

- Stream Google response ke client.
- Jangan menyalin seluruh body.
- Forward range response:
  - `206 Partial Content`
  - `Content-Range`
  - `Content-Length`
- Jangan mengizinkan decompression otomatis yang mengubah byte object.

### Concurrency

Tambahkan semaphore per user:

- maksimum upload aktif
- maksimum download aktif
- maksimum Drive API request aktif

Nilai harus configurable. Tujuannya mencegah satu pengguna menghabiskan quota dan resource seluruh server.

---

## 18. Reconciliation

Karena pengguna dapat menghapus atau memindahkan file lewat UI Google Drive, sediakan reconciliation.

### Pemeriksaan

Untuk batch object:

1. `files.get(fileId, fields=id,name,size,md5Checksum,trashed,modifiedTime,appProperties)`.
2. Jika tidak ada:
   - tandai object `missing`
   - S3 GetObject mengembalikan `NoSuchKey`
   - tampilkan warning di dashboard
3. Jika trashed:
   - perlakukan sebagai missing
4. Jika size/checksum berubah di luar aplikasi:
   - tandai `externally_modified`
   - jangan diam-diam mengubah ETag tanpa audit
5. Jika nama/folder berubah:
   - object tetap valid karena akses memakai `fileId`

Tambahkan kolom status object melalui migrasi:

```text
active
missing
externally_modified
deleting
error
```

### Recovery marker

`appProperties` dengan UUID internal dipakai untuk menemukan orphan atau membangun ulang sebagian mapping. Jangan menjanjikan full recovery hanya dari Drive; backup SQLite tetap wajib.

---

## 19. Observability

### Logging

Gunakan structured JSON log:

```json
{
  "level": "info",
  "time": "...",
  "requestId": "req_...",
  "route": "PutObject",
  "userId": "usr_...",
  "bucket": "documents",
  "status": 200,
  "durationMs": 1432
}
```

Redaction wajib:

- Authorization
- Cookie
- refresh token
- access token
- secret access key
- presigned signature/query
- encryption key
- full OAuth response

Object key dapat mengandung data sensitif. Default log hanya hash atau versi terpotong; full key hanya di audit database bila memang diperlukan.

### Health

```text
GET /health/live
GET /health/ready
```

`ready` memeriksa:

- SQLite dapat dibaca/ditulis.
- migration selesai.
- temp directory tersedia.
- master key valid.
- tidak perlu memanggil Google pada setiap health check.

### Metrics minimum

- HTTP request count/duration
- S3 operation count/duration
- bytes uploaded/downloaded
- Google API error count
- token refresh failure
- SQLite busy/error count
- multipart active/expired
- orphan cleanup backlog

---

## 20. Security checklist

Wajib:

- TLS di production.
- Jangan izinkan OAuth redirect URI wildcard.
- Validasi issuer/audience/expiry/`hd` ID token.
- CSRF protection untuk control plane.
- SigV4 untuk data plane.
- Constant-time signature comparison.
- Session fixation protection.
- Secure cookie.
- Rate limit login, credential creation, dan failed signature.
- Batasi body/XML size.
- XML parser harus menonaktifkan external entity.
- Cegah path traversal pada multipart temp files.
- Jangan menyimpan plaintext secret.
- Jangan log token/signature.
- CORS control plane hanya untuk `APP_ORIGIN`.
- S3 CORS disabled secara default.
- Content Security Policy untuk dashboard.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy`.
- Permission file SQLite dan temp directory terbatas.
- Backup SQLite terenkripsi.
- Rotation plan untuk encryption key.
- Revoke OAuth harus menonaktifkan operasi Drive dengan pesan reconnect.
- Tidak ada endpoint admin tersembunyi tanpa auth.

---

## 21. Error handling Google Drive

Mapping minimum:

| Google condition | Perilaku |
|---|---|
| 401 / invalid credentials | coba refresh satu kali, lalu tandai reconnect required |
| 403 rate limit | exponential backoff + jitter |
| 403 storage quota | S3 `ServiceUnavailable`/`SlowDown`, pesan jelas di dashboard |
| 404 file | tandai missing/orphan sesuai konteks |
| 409 conflict | retry idempotent bila aman |
| 429 | hormati `Retry-After` |
| 5xx | retry resumable/idempotent |
| OAuth revoked | disable akses Drive user sampai reconnect |

Jangan retry request non-idempotent secara buta. Gunakan idempotency record untuk operasi create/upload.

---

## 22. Idempotency dan konsistensi

### CreateBucket

- Insert row status `creating`.
- Buat folder Drive.
- Update row menjadi `active`.
- Jika gagal setelah folder dibuat, masukkan folder ke `pending_cleanup`.
- Request ulang dengan nama sama:
  - jika bucket user aktif -> `BucketAlreadyOwnedByYou`
  - jika status creating lama -> reconcile

### PutObject

Gunakan `requestId` internal dan state staging. Request ulang akibat network error tidak boleh membuat object aktif ganda.

### DeleteBucket

- Pastikan tidak ada object aktif.
- Update status `deleting`.
- Hapus namespace.
- Trash/delete folder Drive.
- Final delete row atau simpan tombstone singkat untuk idempotency.

---

## 23. Testing

### Unit test

Wajib:

- canonical URI SigV4
- canonical query SigV4
- canonical headers
- header-signed request
- presigned request
- clock skew
- invalid signature
- continuation token
- bucket name validation
- key encoding
- XML escaping
- ETag single-part
- ETag multipart
- AES-GCM roundtrip dan tamper rejection
- repository transaction
- path traversal rejection
- range parsing
- conditional request behavior

### Integration test

Gunakan akun/test fixture terpisah.

- OAuth callback validation.
- Refresh token rotation/persistence.
- Create root Drive folder.
- Create bucket.
- Put/Get/Head/Delete object.
- Object overwrite atomicity.
- Range download.
- Drive token revoked.
- Drive file manually trashed.
- Google API rate limit simulation.
- Crash/restart saat staging.
- Multipart complete/abort/expiry.

### Compatibility test

Uji dengan:

- AWS SDK for JavaScript v3
- AWS CLI
- `rclone`
- MinIO Client (`mc`) bila tersedia

Contoh smoke test:

```bash
aws configure set aws_access_key_id "$S3_ACCESS_KEY_ID" --profile drives3
aws configure set aws_secret_access_key "$S3_SECRET_ACCESS_KEY" --profile drives3
aws configure set region us-east-1 --profile drives3

aws --profile drives3 \
  --endpoint-url http://localhost:3000 \
  s3api create-bucket \
  --bucket test-bucket

printf 'hello\n' > /tmp/hello.txt

aws --profile drives3 \
  --endpoint-url http://localhost:3000 \
  s3 cp /tmp/hello.txt s3://test-bucket/hello.txt

aws --profile drives3 \
  --endpoint-url http://localhost:3000 \
  s3 ls s3://test-bucket/

aws --profile drives3 \
  --endpoint-url http://localhost:3000 \
  s3 cp s3://test-bucket/hello.txt -
```

Tambahkan CI test yang menggunakan fake Drive adapter agar tidak membutuhkan Google untuk setiap commit.

---

## 24. Drive adapter

Buat interface agar test dapat memakai fake implementation:

```ts
export interface DriveStorage {
  ensureUserRoot(input: EnsureRootInput): Promise<DriveRoot>;
  createBucketFolder(input: CreateBucketFolderInput): Promise<DriveFolder>;
  deleteFile(input: DeleteDriveFileInput): Promise<void>;

  uploadObject(input: UploadObjectInput): Promise<UploadedDriveObject>;
  downloadObject(input: DownloadObjectInput): Promise<Response>;
  headObject(input: HeadDriveObjectInput): Promise<DriveObjectMetadata>;

  beginResumableUpload(
    input: BeginResumableUploadInput,
  ): Promise<ResumableSession>;

  uploadResumableChunk(
    input: UploadResumableChunkInput,
  ): Promise<ResumableProgress>;
}
```

Implementasi produksi: `GoogleDriveStorage`.

Implementasi test: `InMemoryDriveStorage` atau `FilesystemDriveStorage`.

Business logic S3 tidak boleh memanggil endpoint Google langsung; selalu melalui interface adapter.

---

## 25. Coding standards

- TypeScript `strict: true`.
- Hindari `any`; gunakan `unknown` + validation.
- Semua input eksternal divalidasi.
- Prepared statements untuk SQL.
- Semua resource punya ownership filter di query.
- Jangan pernah query bucket/object hanya dengan `id`; selalu sertakan `user_id` atau ownership join.
- Gunakan UTC ISO-8601 untuk timestamp.
- Gunakan integer byte, bukan floating point.
- Semua fungsi network memiliki timeout/abort signal.
- Semua background job memiliki batch limit.
- Error internal tidak boleh bocor ke response.
- Tidak ada TODO keamanan yang dibiarkan tanpa issue.
- Tambahkan komentar hanya untuk menjelaskan keputusan yang tidak jelas, bukan mengulang kode.
- Jangan menambahkan dependency jika Web API/Bun built-in sudah memadai.
- Jalankan format, lint, typecheck, dan test sebelum menyatakan selesai.

---

## 26. Scripts

Root `package.json` minimal:

```json
{
  "name": "drives3-gateway",
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "dev": "bun run --filter '*' dev",
    "dev:server": "bun --watch apps/server/src/index.ts",
    "dev:web": "bunx vite --config apps/web/vite.config.ts",
    "build": "bun run build:web && bun run build:server",
    "build:web": "bunx vite build --config apps/web/vite.config.ts",
    "build:server": "bun build apps/server/src/index.ts --target=bun --outdir=dist/server",
    "start": "bun dist/server/index.js",
    "db:migrate": "bun apps/server/src/db/migrate.ts",
    "test": "bun test",
    "test:unit": "bun test tests/unit",
    "test:integration": "bun test tests/integration",
    "typecheck": "bunx tsc --noEmit",
    "check": "bun run typecheck && bun run test"
  }
}
```

Sesuaikan filtering workspace jika perilaku Bun versi yang dipakai berbeda, tetapi pertahankan nama script utama.

---

## 27. Deployment

### MVP

- Satu container aplikasi.
- Satu persistent volume lokal untuk:
  - SQLite
  - multipart temp
- Reverse proxy HTTPS.
- Backup berkala SQLite.
- Temp directory dipantau kapasitasnya.
- Jangan menyimpan SQLite pada object storage atau NFS yang tidak mendukung locking SQLite dengan benar.

### Docker

Gunakan image Bun resmi dan non-root user. Multi-stage build:

1. Install dependencies.
2. Build frontend/server.
3. Runtime image minimal.
4. Copy dist.
5. Buat `/app/data`.
6. Jalankan sebagai user non-root.
7. Healthcheck ke `/health/live`.

### Shutdown

Tangani SIGTERM:

- berhenti menerima request baru
- beri waktu stream aktif selesai
- abort request tersisa setelah grace period
- checkpoint/close SQLite
- jangan menghapus part multipart yang masih valid

---

## 28. Compatibility matrix di UI

Tampilkan secara jujur:

| Fitur | Status |
|---|---|
| Path-style endpoint | Supported |
| AWS SigV4 header | Supported |
| Presigned GET/PUT | Supported |
| ListBuckets | Supported |
| Create/Delete Bucket | Supported |
| Put/Get/Head/Delete Object | Supported |
| ListObjectsV2 | Supported |
| Byte range GET | Supported |
| Multipart upload | Supported setelah test |
| CopyObject | Supported setelah test |
| Virtual-hosted style | Not supported |
| Versioning | Not supported |
| ACL / bucket policy | Not supported |
| Object Lock | Not supported |
| SSE-KMS | Not supported |

Status “Supported” hanya boleh ditampilkan setelah test kompatibilitas lulus.

---

## 29. Urutan implementasi

### Milestone 1 — Foundation

- Monorepo Bun.
- Config validation.
- SQLite connection + migration.
- Logger/request ID.
- Health endpoint.
- React 18 + shadcn/Tailwind application shell.

### Milestone 2 — OAuth dan My Drive

- Google OAuth.
- Domain restriction.
- Token encryption.
- Session.
- User root folder.
- Drive status/reconnect.

### Milestone 3 — Metadata dan dashboard

- Bucket/object schema.
- Credential UI.
- Bucket UI.
- Object browser.
- Audit log.

### Milestone 4 — S3 core

- SigV4 verifier.
- XML response/error.
- List/Create/Head/Delete bucket.
- Put/Get/Head/Delete object.
- ListObjectsV2.
- AWS SDK + CLI compatibility tests.

### Milestone 5 — Streaming dan reliability

- Google resumable upload.
- Range download.
- Atomic overwrite.
- Retry/backoff.
- Cleanup queue.
- Reconciliation.

### Milestone 6 — Multipart dan presigned

- Multipart S3.
- Presigned GET/PUT.
- CopyObject.
- `rclone` dan `mc` tests.

### Milestone 7 — Hardening

- Rate limit.
- Security headers.
- Backup/restore docs.
- Load tests.
- Failure injection.
- Compatibility matrix.
- Production Docker.

Setiap milestone harus meninggalkan aplikasi dalam keadaan bisa dijalankan dan dites.

---

## 30. Definition of done

Fitur dianggap selesai hanya jika:

- Implementasi berjalan di Bun.
- Typecheck lulus.
- Unit test lulus.
- Integration test relevan lulus.
- Tidak ada token/secret di log.
- Ownership/isolation test lulus.
- UI memakai primitive shadcn dan CSS theme token semantik.
- Operasi S3 diuji dengan AWS SDK atau AWS CLI.
- Error mengikuti shape S3.
- Upload/download besar tidak dibuffer ke RAM.
- Dokumentasi README diperbarui.
- Compatibility matrix diperbarui.
- Tidak ada klaim dukungan yang belum diuji.

---

## 31. Keputusan desain yang tidak boleh diubah diam-diam

1. Bucket dapat berada di **My Drive pemilik** atau Shared Drive terpilih; target bucket immutable.
2. OAuth token pengguna yang melakukan request menentukan principal Google yang dipakai; anggota Shared Drive harus memiliki akses Google sendiri.
3. S3 access key dipetakan ke tepat satu pengguna, lalu role owner/Editor/Viewer menentukan akses bucket Shared Drive.
4. SQLite menyimpan namespace dan `fileId`.
5. Google Drive file name bukan object key.
6. Path-style endpoint adalah mode utama MVP.
7. SigV4 wajib; jangan membuat auth key sederhana melalui query/header custom.
8. Secret S3 dan refresh token dienkripsi.
9. Upload besar harus streaming/resumable.
10. React 18 dan application `ThemeProvider` wajib.
11. Gunakan shadcn/ui, Radix, dan Tailwind dengan output stylesheet statis.
12. Jangan mengklaim 100% kompatibel dengan seluruh S3.

---

## 32. Referensi teknis

- shadcn/ui: https://ui.shadcn.com/docs
- Tailwind CSS: https://tailwindcss.com/docs
- Radix UI: https://www.radix-ui.com/primitives/docs/overview/introduction
- Bun SQLite: https://bun.sh/docs/runtime/sqlite
- Bun HTTP server: https://bun.sh/docs/runtime/http/server
- Google OAuth web server flow: https://developers.google.com/identity/protocols/oauth2/web-server
- Google Drive OAuth scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Google Drive uploads: https://developers.google.com/workspace/drive/api/guides/manage-uploads
- Google Drive downloads/range: https://developers.google.com/workspace/drive/api/guides/manage-downloads
- Google Drive custom properties: https://developers.google.com/workspace/drive/api/guides/properties
- Google Drive usage limits: https://developers.google.com/workspace/drive/api/guides/limits
- Amazon S3 API: https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html
- AWS Signature Version 4: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html
- S3 SigV4 authentication: https://docs.aws.amazon.com/AmazonS3/latest/userguide/sig-v4-authenticating-requests.html
