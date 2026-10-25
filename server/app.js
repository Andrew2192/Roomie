import cors from "cors";
import express from "express";
import multer from "multer";
import { analyzeRoomImage, CortexError } from "./cortex.js";

const maxImageBytes = 10 * 1024 * 1024;
const acceptedMediaTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function getImageMediaType(buffer) {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

export function createApp({ analyzeImage = analyzeRoomImage } = {}) {
  const app = express();
  const allowedOrigins = new Set(
    (process.env.CORS_ORIGINS || "http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  app.use(
    cors({
      origin(origin, callback) {
        callback(null, !origin || allowedOrigins.has(origin));
      },
    }),
  );

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxImageBytes, files: 1 },
    fileFilter(_req, file, callback) {
      if (!acceptedMediaTypes.has(file.mimetype)) {
        callback(new RequestError("Upload a JPEG, PNG, or WebP image.", 415));
        return;
      }

      callback(null, true);
    },
  });

  app.post("/api/analyze", upload.single("image"), async (req, res, next) => {
    try {
      if (!req.file) {
        throw new RequestError("Attach an image using the 'image' field.", 400);
      }

      const actualMediaType = getImageMediaType(req.file.buffer);
      if (!actualMediaType || actualMediaType !== req.file.mimetype) {
        throw new RequestError("The uploaded file is not a valid supported image.", 400);
      }

      const analysis = await analyzeImage({
        ...req.file,
        mimetype: actualMediaType,
      });
      res.json(analysis);
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "Image must be 10 MB or smaller." });
      }

      return res.status(400).json({ error: "Upload one image using the 'image' field." });
    }

    if (error instanceof RequestError) {
      return res.status(error.status).json({ error: error.message });
    }

    if (error instanceof CortexError) {
      console.error("Room analysis failed:", error.message);
      return res.status(error.status).json({ error: error.message });
    }

    console.error("Unexpected API error:", error);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  });

  return app;
}
