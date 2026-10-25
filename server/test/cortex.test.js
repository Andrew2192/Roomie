import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { analyzeRoomImage, CortexError } from "../cortex.js";

const originalFetch = globalThis.fetch;
const originalAccountUrl = process.env.SNOWFLAKE_ACCOUNT_URL;
const originalToken = process.env.SNOWFLAKE_PAT;

const validAnalysis = {
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

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAccountUrl === undefined) {
    delete process.env.SNOWFLAKE_ACCOUNT_URL;
  } else {
    process.env.SNOWFLAKE_ACCOUNT_URL = originalAccountUrl;
  }
  if (originalToken === undefined) {
    delete process.env.SNOWFLAKE_PAT;
  } else {
    process.env.SNOWFLAKE_PAT = originalToken;
  }
});

describe("Snowflake Cortex integration", () => {
  it("sends the image to Cortex and validates its structured response", async () => {
    process.env.SNOWFLAKE_ACCOUNT_URL = "https://example.snowflakecomputing.com";
    process.env.SNOWFLAKE_PAT = "test-token";

    globalThis.fetch = async (url, options) => {
      assert.equal(
        url,
        "https://example.snowflakecomputing.com/api/v2/cortex/v1/chat/completions",
      );
      assert.equal(options.headers.Authorization, "Bearer test-token");
      const request = JSON.parse(options.body);
      assert.equal(request.model, "openai-gpt-5");
      assert.equal(
        request.messages[0].content[1].image_url.url,
        "data:image/png;base64,AQID",
      );

      return Response.json({
        choices: [{ message: { content: JSON.stringify(validAnalysis) } }],
      });
    };

    const result = await analyzeRoomImage({
      mimetype: "image/png",
      buffer: Buffer.from([1, 2, 3]),
    });

    assert.deepEqual(result, validAnalysis);
  });

  it("accepts an account URL pasted without the https:// scheme", async () => {
    // Users commonly paste the account identifier without a scheme.
    process.env.SNOWFLAKE_ACCOUNT_URL = "example.snowflakecomputing.com";
    process.env.SNOWFLAKE_PAT = "test-token";

    globalThis.fetch = async (url) => {
      assert.equal(
        url,
        "https://example.snowflakecomputing.com/api/v2/cortex/v1/chat/completions",
      );
      return Response.json({
        choices: [{ message: { content: JSON.stringify(validAnalysis) } }],
      });
    };

    const result = await analyzeRoomImage({
      mimetype: "image/png",
      buffer: Buffer.from([1]),
    });
    assert.deepEqual(result, validAnalysis);
  });

  it("rejects invalid model output instead of returning fabricated data", async () => {
    process.env.SNOWFLAKE_ACCOUNT_URL = "https://example.snowflakecomputing.com";
    process.env.SNOWFLAKE_PAT = "test-token";
    globalThis.fetch = async () =>
      Response.json({
        choices: [{ message: { content: '{"summary":"Room"}' } }],
      });

    await assert.rejects(
      analyzeRoomImage({ mimetype: "image/png", buffer: Buffer.from([1]) }),
      /invalid room analysis/i,
    );
  });

  it("requires three actionable suggestions", async () => {
    process.env.SNOWFLAKE_ACCOUNT_URL = "https://example.snowflakecomputing.com";
    process.env.SNOWFLAKE_PAT = "test-token";
    globalThis.fetch = async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                ...validAnalysis,
                suggestions: validAnalysis.suggestions.slice(0, 2),
              }),
            },
          },
        ],
      });

    await assert.rejects(
      analyzeRoomImage({ mimetype: "image/png", buffer: Buffer.from([1]) }),
      /invalid room analysis/i,
    );
  });

  it("passes Snowflake's own error detail through to the caller", async () => {
    process.env.SNOWFLAKE_ACCOUNT_URL = "https://example.snowflakecomputing.com";
    process.env.SNOWFLAKE_PAT = "test-token";
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: "390432", message: "Fail : Network policy is required." }), {
        status: 401,
      });

    await assert.rejects(
      analyzeRoomImage({ mimetype: "image/png", buffer: Buffer.from([1]) }),
      (error) =>
        error instanceof CortexError &&
        error.status === 502 &&
        /Network policy is required[.] \(code 390432\)/.test(error.message),
    );
  });

  it("reports missing Snowflake credentials", async () => {
    delete process.env.SNOWFLAKE_ACCOUNT_URL;
    delete process.env.SNOWFLAKE_PAT;

    await assert.rejects(
      analyzeRoomImage({ mimetype: "image/png", buffer: Buffer.from([1]) }),
      /SNOWFLAKE_ACCOUNT_URL and SNOWFLAKE_PAT/,
    );
  });
});
