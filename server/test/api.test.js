import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createApp } from "../app.js";

const analysis = {
  summary: "A compact room with a desk and bed.",
  observations: ["The desk has limited clear surface space."],
  suggestions: [
    {
      title: "Use under-bed storage",
      reason: "It can free up visible floor space.",
      priority: "high",
    },
    {
      title: "Clear the desk",
      reason: "Move small items into nearby storage.",
      priority: "medium",
    },
    {
      title: "Use vertical shelving",
      reason: "It can keep frequently used items accessible.",
      priority: "low",
    },
  ],
};

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

describe("Roomie API", () => {
  let server;
  let baseUrl;
  let receivedImage;

  before(async () => {
    const app = createApp({
      async analyzeImage(file) {
        receivedImage = file;
        return analysis;
      },
    });

    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("reports health", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  it("accepts an image and returns the agreed analysis shape", async () => {
    const body = new FormData();
    body.append("image", new Blob([pngBytes], { type: "image/png" }), "room.png");

    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      body,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), analysis);
    assert.equal(receivedImage.mimetype, "image/png");
    assert.deepEqual(receivedImage.buffer, pngBytes);
  });

  it("rejects missing images", async () => {
    const response = await fetch(`${baseUrl}/api/analyze`, { method: "POST" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /image/i);
  });

  it("rejects unsupported image types", async () => {
    const body = new FormData();
    body.append("image", new Blob(["not an image"], { type: "text/plain" }), "room.txt");

    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      body,
    });

    assert.equal(response.status, 415);
  });

  it("rejects image content that does not match its declared type", async () => {
    const body = new FormData();
    body.append("image", new Blob(["not a png"], { type: "image/png" }), "room.png");

    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      body,
    });

    assert.equal(response.status, 400);
  });
});
