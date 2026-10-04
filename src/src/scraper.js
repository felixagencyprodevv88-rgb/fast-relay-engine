const express = require("express");
const { scanUrl } = require("./scraper");

const app = express();
app.use(express.json({ limit: "1mb" }));

const API_KEY = process.env.API_KEY || "change-me";

function checkAuth(req, res, next) {
  if (req.header("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "Invalid or missing x-api-key" });
  }
  next();
}

// Fast-only check. Returns a final result when confident, or
// { status: "escalate" } when this URL needs the full browser engine instead.
app.post("/scan", checkAuth, async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing 'url' in request body" });
  }
  try {
    const result = await scanUrl(url);
    return res.json(result);
  } catch (err) {
    return res.json({ status: "escalate", reason: "relay_exception" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true, engine: "fast-relay" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fast relay engine listening on port ${PORT}`));
