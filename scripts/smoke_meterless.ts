// Two live calls through Nightshift: plain, then with a run_sql tool. Prints no secrets.
//   npx tsx scripts/smoke_meterless.ts
import "dotenv/config";
import { chat, type ChatResult, type ToolDefinition } from "../src/providers/meterless.js";

function show(label: string, r: ChatResult): void {
  console.log(`--- ${label}`);
  console.log(`requested model: ${r.receipt.requested_model}`);
  console.log(`routed model:    ${r.receipt.routed_model}`);
  console.log(`provider:        ${r.receipt.provider} (${r.receipt.kind}, tier ${r.receipt.tier})`);
  console.log(`receipt_id:      ${r.receipt.receipt_id}`);
  console.log(`signed:          ${r.receipt.signed}`);
  console.log(`tokens in/out:   ${r.receipt.input_tokens}/${r.receipt.output_tokens}, ${r.receipt.latency_ms} ms`);
}

const a = await chat({ messages: [{ role: "user", content: "Reply with the single word OK." }] });
show("(a) plain", a);
console.log(`content:         ${JSON.stringify(a.message.content)}`);

const runSql: ToolDefinition = {
  type: "function",
  function: {
    name: "run_sql",
    description: "Run a SQL query against the Tax Map statute tables and return rows.",
    parameters: {
      type: "object",
      properties: { sql: { type: "string", description: "The SQL statement to run" } },
      required: ["sql"],
    },
  },
};
const b = await chat({
  messages: [
    {
      role: "user",
      content:
        "Find the section numbers of the Nigeria Tax Act about dividends. Use the run_sql tool with SQL against table taxmap.sections (columns act_id, section_no, heading, text).",
    },
  ],
  tools: [runSql],
});
show("(b) tools", b);
const calls = b.message.tool_calls ?? [];
if (calls.length === 0) {
  console.log("tool_calls:      NONE");
  console.log(`content:         ${JSON.stringify(b.message.content)}`);
} else {
  for (const c of calls) console.log(`tool_call:       ${c.function.name}(${c.function.arguments})`);
}
