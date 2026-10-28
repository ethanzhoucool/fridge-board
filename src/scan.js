// Reads a photo of the fridge whiteboard into structured weekly goals using Claude.
// The API key lives only in this browser (localStorage), set from Settings.

const KEY = "fridge.anthropicKey";
export const getKey = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
export const setKey = (v) => { try { v ? localStorage.setItem(KEY, v.trim()) : localStorage.removeItem(KEY); } catch {} };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["group_goal", "fun", "charity", "rules", "people"],
  properties: {
    group_goal: { type: ["string", "null"], description: "The shared group goal, e.g. '3k / person'" },
    fun: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["label", "done"],
        properties: { label: { type: "string" }, done: { type: "boolean" } },
      },
    },
    charity: { type: ["string", "null"] },
    rules: { type: "array", items: { type: "string" } },
    people: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["name", "goals"],
        properties: {
          name: { type: "string" },
          goals: {
            type: "array",
            items: {
              type: "object", additionalProperties: false, required: ["label", "note", "target", "done"],
              properties: {
                label: { type: "string", description: "Short goal name, e.g. 'Gym' or 'LeetCode mediums'" },
                note: { type: ["string", "null"], description: "Extra detail, e.g. 'one leg day'" },
                target: { type: "integer", description: "How many times; 1 for one-off goals" },
                done: { type: "integer", description: "Progress already marked on the board, else 0" },
              },
            },
          },
        },
      },
    },
  },
};

const PROMPT = (names) => `This is a photo of our group's weekly goals whiteboard.
Transcribe it into the schema. Keep goal labels short (2-4 words) and put extra detail in "note".
Turn counts into "target" (e.g. "gym 3 times" -> label "Gym", target 3; "5 chapters" -> target 5). One-off goals get target 1.
If a number appears after a colon at the end of a goal line, that is progress so far ("done"); otherwise done is 0.
Fun goals are usually listed under a "Fun" heading with checkboxes. "Draft" or rule lists go in "rules".
${names.length ? `Our members are: ${names.join(", ")}. Match handwritten names to these spellings (e.g. "Ethan Z" -> "Ethan").` : ""}`;

export async function scanBoard(jpegBase64, memberNames) {
  const apiKey = getKey();
  if (!apiKey) throw new Error("Add a Claude API key in Settings first");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const res = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpegBase64 } },
        { type: "text", text: PROMPT(memberNames) },
      ],
    }],
  });

  if (res.stop_reason === "refusal") throw new Error("Claude couldn't read that photo. Try another one.");
  if (res.stop_reason === "max_tokens") throw new Error("The board was too long to read. Try a closer photo.");
  const text = res.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("No result from Claude");
  return JSON.parse(text);
}
