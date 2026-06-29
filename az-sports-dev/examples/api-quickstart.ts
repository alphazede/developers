const apiKey = process.env.API_KEY;

if (!apiKey) {
  throw new Error("Set API_KEY before calling the AlphaZede Sports API.");
}

const response = await fetch("https://api.alphazedesports.com/api/v1/health", {
  headers: {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  },
});

if (!response.ok) {
  throw new Error(`AlphaZede Sports API returned ${response.status}`);
}

console.log(await response.json());
