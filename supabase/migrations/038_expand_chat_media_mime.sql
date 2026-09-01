-- ============================================================
-- 038 — Expand chat-media bucket MIME whitelist.
--
-- The unofficial Chatwoot gateway re-uploads inbound attachments
-- into the `chat-media` bucket, tagging them with whatever
-- content-type the fork's Active Storage actually returns. The
-- original whitelist (023) only covered a small subset of real
-- WhatsApp/multimedia types, so common files — GIF/HEIC images,
-- Opus/WAV/M4A voice notes, WebM video, or an `octet-stream`
-- signed URL — were rejected and the message landed as text-only
-- (`media_url` = NULL).
--
-- This relaxes the whitelist to the types browsers and the Chatwoot
-- fork actually produce, while keeping the 16 MB cap. Idempotent
-- (same `ON CONFLICT DO UPDATE` pattern as 023) — safe to re-run.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-media',
  'chat-media',
  TRUE,
  16777216, -- 16 MB
  ARRAY[
    -- Images
    'image/png', 'image/jpeg', 'image/jpg', 'image/webp',
    'image/gif', 'image/heic', 'image/heif', 'image/bmp',
    'image/svg+xml', 'image/tiff', 'image/avif',
    -- Videos
    'video/mp4', 'video/3gpp', 'video/3gp', 'video/webm',
    'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/mpeg',
    -- Documents
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.presentation',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.google-apps.document',
    'text/plain', 'text/csv', 'text/html', 'application/rtf',
    'application/zip', 'application/x-7z-compressed', 'application/x-rar-compressed',
    'application/vnd.apple.pkpass', 'application/x-pkcs12',
    -- Audio (voice notes + media) — in/outbound across browsers and the fork
    'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/aac', 'audio/aacp',
    'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/amr',
    'audio/opus', 'audio/wav', 'audio/x-wav', 'audio/webm',
    'audio/flac', 'audio/3gpp', 'audio/m4a',
    -- Broad fallback: some signed/octet-stream responses wrap the above
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;