const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function askOpenAI(messages, { model = "gpt-5.1", max_tokens = 500 } = {}) {
  try {
    const response = await client.chat.completions.create({
      model,
      messages,
      max_tokens,
      temperature: 0.7
    });

    return {
      ok: true,
      text: response.choices?.[0]?.message?.content || ""
    };
  } catch (err) {
    console.error("[OPENAI ERROR]", err);
    return { ok: false, error: err.message };
  }
}

module.exports = { askOpenAI };
