const endpointPath = "/api/v2/cortex/v1/chat/completions";
const model = process.env.CORTEX_MODEL || "openai-gpt-5";

export class CortexError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "CortexError";
    this.status = status;
  }
}

function getEndpoint() {
  let accountUrl = process.env.SNOWFLAKE_ACCOUNT_URL;
  const token = process.env.SNOWFLAKE_PAT;

  if (!accountUrl || !token) {
    throw new CortexError(
      "Set SNOWFLAKE_ACCOUNT_URL and SNOWFLAKE_PAT to enable room analysis.",
      503,
    );
  }

  // Users frequently paste bare account identifiers
  // (e.g. "ab12345.snowflakecomputing.com") without the scheme; normalize to
  // HTTPS rather than failing.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(accountUrl.trim())) {
    accountUrl = `https://${accountUrl.trim()}`;
  }

  let url;
  try {
    url = new URL(accountUrl);
  } catch {
    throw new CortexError("SNOWFLAKE_ACCOUNT_URL must be a valid HTTPS URL.", 503);
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new CortexError(
      "SNOWFLAKE_ACCOUNT_URL must be the HTTPS Snowflake account URL.",
      503,
    );
  }

  return { endpoint: new URL(endpointPath, url).toString(), token };
}

function parseAnalysis(content) {
  const unfenced = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let value;
  try {
    value = JSON.parse(unfenced);
  } catch {
    throw new CortexError("Cortex returned an invalid room analysis.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CortexError("Cortex returned an invalid room analysis.");
  }

  const { summary, observations, suggestions } = value;
  if (
    typeof summary !== "string" ||
    summary.trim().length === 0 ||
    summary.length > 500 ||
    !Array.isArray(observations) ||
    observations.length === 0 ||
    observations.length > 8 ||
    !observations.every(
      (item) => typeof item === "string" && item.trim().length > 0 && item.length <= 300,
    ) ||
    !Array.isArray(suggestions) ||
    suggestions.length !== 3 ||
    !suggestions.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.title === "string" &&
        item.title.trim().length > 0 &&
        item.title.length <= 120 &&
        typeof item.reason === "string" &&
        item.reason.trim().length > 0 &&
        item.reason.length <= 300 &&
        ["high", "medium", "low"].includes(item.priority),
    )
  ) {
    throw new CortexError("Cortex returned an invalid room analysis.");
  }

  return {
    summary: summary.trim(),
    observations: observations.map((item) => item.trim()),
    suggestions: suggestions.map(({ title, reason, priority }) => ({
      title: title.trim(),
      reason: reason.trim(),
      priority,
    })),
  };
}

export async function analyzeRoomImage(file) {
  const { endpoint, token } = getEndpoint();
  const prompt = [
    "Analyze this room photo for visible furniture, clutter, and ways to make the space more organized and functional.",
    "Only describe what is visible; do not guess measurements or claim certainty about hidden areas.",
    "Return only a JSON object with this exact shape:",
    '{"summary":"A short room description","observations":["Visible observation"],"suggestions":[{"title":"Actionable idea","reason":"Why it helps","priority":"high|medium|low"}]}',
    "Include 1 to 8 concise observations and exactly 3 practical suggestions.",
  ].join(" ");

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
                },
              },
            ],
          },
        ],
      }),
    });
  } catch (error) {
    throw new CortexError(
      error.name === "TimeoutError"
        ? "The Cortex analysis request timed out."
        : "Could not connect to Snowflake Cortex.",
    );
  }

  if (!response.ok) {
    // Surface Snowflake's own detail when present — codes like 390432
    // ("Network policy is required") are account-level issues, and without
    // the message the response only says "HTTP 401".
    let detail = null;
    try {
      const body = await response.json();
      const message = body?.message || body?.detail || body?.error?.message;
      if (typeof message === "string" && message.trim()) {
        detail = `${message.trim()}${body?.code ? ` (code ${body.code})` : ""}`;
      }
    } catch {
      // body was not JSON; fall back to the generic status-only error
    }
    throw new CortexError(
      detail
        ? `Snowflake Cortex rejected the request (HTTP ${response.status}): ${detail}`
        : `Snowflake Cortex returned HTTP ${response.status}.`,
    );
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new CortexError("Snowflake Cortex returned an invalid response.");
  }

  const content = result?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new CortexError("Snowflake Cortex returned no room analysis.");
  }

  return parseAnalysis(content);
}
