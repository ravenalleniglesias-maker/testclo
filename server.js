const express = require("express");
const path = require("path");
const {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const {
  B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_ENDPOINT, B2_REGION, APP_PASSWORD,
} = process.env;

const MAX_MB = Number(process.env.MAX_MB || 2048); // pinakamalaking file (MB)

const s3 = new S3Client({
  endpoint: B2_ENDPOINT,
  region: B2_REGION,
  credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const app = express();
app.use(express.json());

function auth(req, res, next) {
  if (!APP_PASSWORD || req.get("x-password") !== APP_PASSWORD) {
    return res.status(401).json({ error: "Maling password" });
  }
  next();
}

app.use(express.static(path.join(__dirname, "public")));

// LISTAHAN ng files
app.get("/api/files", auth, async (req, res) => {
  try {
    const files = [];
    let token;
    do {
      const out = await s3.send(
        new ListObjectsV2Command({ Bucket: B2_BUCKET, ContinuationToken: token })
      );
      (out.Contents || []).forEach((o) =>
        files.push({ key: o.Key, size: o.Size, modified: o.LastModified })
      );
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    res.json(files);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Hindi makuha ang listahan" });
  }
});

// UPLOAD STEP 1: gumawa ng pansamantalang upload link (10 minuto)
// Ang browser na mismo ang mag-a-upload papunta sa B2.
app.post("/api/presign-upload", auth, async (req, res) => {
  const { filename, contentType, size } = req.body || {};
  if (!filename) return res.status(400).json({ error: "Walang filename" });
  if (size && size > MAX_MB * 1024 * 1024) {
    return res.status(400).json({ error: `Sobrang laki. Max ${MAX_MB} MB` });
  }
  try {
    const safeName = String(filename).replace(/[^\w.\-]+/g, "_");
    const key = `${Date.now()}-${safeName}`;
    const type = contentType || "application/octet-stream";
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: B2_BUCKET, Key: key, ContentType: type }),
      { expiresIn: 600 }
    );
    res.json({ url, key, contentType: type });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Hindi makagawa ng upload link" });
  }
});

// DOWNLOAD: pansamantalang link (60 segundo)
app.get("/api/download", auth, async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: "Walang key" });
  try {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: B2_BUCKET,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(
          key.replace(/^\d+-/, "")
        )}"`,
      }),
      { expiresIn: 60 }
    );
    res.json({ url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Hindi makagawa ng link" });
  }
});

// DELETE
app.delete("/api/files", auth, async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: "Walang key" });
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: key }));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Hindi mabura" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port " + PORT));
