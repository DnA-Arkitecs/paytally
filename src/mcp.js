// PayTally as an MCP server, so a client's own AI agent can settle its bill.
// Mounted at /mcp (Streamable HTTP, stateless). Each client's agent sends its
// own bearer token, and every tool answers for that one client only.
//
// The tools let the client's agent read, check, dispute and ask to pay. None of
// them can change a price, apply a credit or move money: credits wait for the
// agency owner's click and payments for the client's human (src/settlement.js).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export const TOOLS = {
  get_ledger: {
    title: "Get the bill",
    description:
      "Every invoice the agency has sent this client through PayPal (newest first): PayPal status, total, amount owed, due date and each line with its reason and the work-log rows it comes from. Also lists what was deliberately not billed this period and why, and the client's agreement.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  explain_charge: {
    title: "Explain one charge",
    description:
      "The proof behind one invoice line: the clause of the agreement it applied and its source rows exactly as they appear in the agency's work log (calendar export, CRM export or client email). Use it before disputing.",
    inputSchema: { line_key: z.string().describe("The line_key from get_ledger, e.g. \"mesa-ridge|calendar:25\".") },
    annotations: { readOnlyHint: true },
  },
  dispute_line: {
    title: "Dispute one charge",
    description:
      "Dispute one line on an invoice, with the reason and the evidence from the client's own records. The agency's agent checks it against the work log and the agreement at once and returns its finding and the rows it checked. It only recommends: the agency owner decides, and a credit reaches PayPal only through the owner's click (a refund if paid, a corrected invoice if not). Call get_dispute for the answer.",
    inputSchema: {
      line_key: z.string().describe("The line_key of the disputed line."),
      reason: z.string().min(10).max(1500).describe("Why the charge is wrong under the agreement, in plain words."),
      evidence: z.string().max(1500).optional().describe("What the client's own records show: dates, times, who did what, any message sent and when."),
    },
  },
  get_dispute: {
    title: "Check a dispute",
    description: "Where a dispute stands: the agency agent's finding, and once the owner has answered, the decision, any credit, the corrected invoice if there is one, and the owner's reply.",
    inputSchema: { dispute_id: z.string().describe("The dispute_id from dispute_line, e.g. \"A1\".") },
    annotations: { readOnlyHint: true },
  },
  approve_and_pay: {
    title: "Approve an invoice and pay it through PayPal",
    description:
      "Approve one invoice on the client's side and ask to pay it through PayPal. Allowed only for the exact amount owed, only with no open dispute on it, and only up to the cap the client's human set. It creates a payment that the client's human approves with one tap; PayPal then takes the payment and PayPal's webhook marks the invoice paid. Call get_payment to follow it.",
    inputSchema: {
      invoice_number: z.string().describe("The invoice_number from get_ledger."),
      amount: z.number().positive().describe("The exact amount owed, in USD."),
    },
  },
  get_payment: {
    title: "Check a payment",
    description: "Where a payment stands: waiting for the client's human, sent to PayPal, or paid (with PayPal's reference).",
    inputSchema: { payment_id: z.string().describe("The payment_id from approve_and_pay.") },
    annotations: { readOnlyHint: true },
  },
};

const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

// handlers: { [tool]: async (agent, args) => plain object }. A handler throws
// to give the agent an error it can read and act on.
// log(agent, tool, args, outcome) records every call for the owner to see.
export function buildServer(agent, handlers, log) {
  const server = new McpServer(
    { name: "paytally", version: "1.0.0" },
    {
      instructions: `PayTally is the billing system of the agency that bills ${agent.client_name}. You are connected as ${agent.name}, for ${agent.human}. Read the bill with get_ledger, check any line's proof with explain_charge, dispute what the client's records contradict with dispute_line, and pay through PayPal with approve_and_pay once nothing is in dispute. Every money change needs a human: the agency owner for credits, ${agent.human} for payments.`,
    },
  );
  for (const [name, def] of Object.entries(TOOLS)) {
    server.registerTool(name, def, async (args) => {
      try {
        const out = await handlers[name](agent, args || {});
        log(agent, name, args, { ok: true, out });
        return text(out);
      } catch (err) {
        log(agent, name, args, { ok: false, error: err.message });
        return { ...text({ error: err.message }), isError: true };
      }
    });
  }
  return server;
}

export function mountMcp(app, { agentForToken, handlers, log }) {
  const auth = (req, res) => {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const agent = token && agentForToken(token);
    if (!agent) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "Send the client's PayTally token as a Bearer token. The demo token for Mesa Ridge Solar is demo-mesa-ridge." });
      return null;
    }
    return agent;
  };

  app.post("/mcp", async (req, res) => {
    const agent = auth(req, res);
    if (!agent) return;
    const server = buildServer(agent, handlers, log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`MCP request failed: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });

  // Stateless server: no standing SSE stream and no sessions to end.
  const notAllowed = (req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
