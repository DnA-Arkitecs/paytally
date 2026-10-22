// An AG Studio LLM adapter for Claude. Studio's agents hand it one turn at a
// time (conversation items, instructions, tools); it posts that to PayTally's
// server (/api/studio/claude), which calls Claude and streams the raw events
// back, and it turns them into the AG-UI events Studio expects. It never runs
// a tool itself: Studio does, then asks for the next turn.
window.claudeAdapter = function claudeAdapter({ endpoint = "/api/studio/claude" } = {}) {
  // Studio's conversation items -> Claude messages (same-role items merged).
  function encode(items) {
    const messages = [];
    const system = [];
    const push = (role, block) => {
      const last = messages.at(-1);
      if (last && last.role === role) last.content.push(block);
      else messages.push({ role, content: [block] });
    };
    for (const it of items) {
      if (it.type === "function_call_output") {
        push("user", { type: "tool_result", tool_use_id: it.callId, content: typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "") });
      } else if (it.kind === "input" && it.type === "message") {
        const text = (it.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        if (it.role === "system" || it.role === "developer") system.push(text);
        else if (text) push("user", { type: "text", text });
      } else if (it.kind === "output" && it.type === "message") {
        for (const c of it.content || []) if (c.type === "text" && c.text) push("assistant", { type: "text", text: c.text });
      } else if (it.kind === "output" && it.type === "function_call") {
        let input = {};
        try {
          input = JSON.parse(it.arguments || "{}");
        } catch {}
        push("assistant", { type: "tool_use", id: it.callId, name: it.name, input });
      }
    }
    return { messages, system };
  }

  const toolChoice = (tc) =>
    !tc ? undefined : tc === "auto" ? { type: "auto" } : tc === "required" ? { type: "any" } : tc === "none" ? { type: "none" } : { type: "tool", name: tc.name };

  // A JSON reply Studio asks for is requested in words; Studio checks it.
  function formatNote(rf) {
    const schema = rf?.schema || rf?.json_schema?.schema;
    if (!rf || rf.type === "text") return "";
    return schema ? `Reply with only a JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}` : "Reply with only a JSON object.";
  }

  // Claude's stream events -> AG-UI events, building the final response as it goes.
  function translator(outcome) {
    const blocks = new Map();
    const output = [];
    const usage = { in: 0, out: 0 };
    let msgId = "";
    let model = "";
    let stop = "";
    return (ev) => {
      switch (ev.type) {
        case "message_start":
          msgId = ev.message.id;
          model = ev.message.model;
          usage.in = ev.message.usage?.input_tokens ?? 0;
          return [];
        case "content_block_start": {
          const b = ev.content_block;
          if (b.type === "text") {
            const id = `${msgId}_${ev.index}`;
            blocks.set(ev.index, { kind: "text", id, text: "" });
            return [{ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" }];
          }
          if (b.type === "tool_use") {
            blocks.set(ev.index, { kind: "tool", id: b.id, name: b.name, args: "" });
            return [{ type: "TOOL_CALL_START", toolCallId: b.id, toolCallName: b.name }];
          }
          return [];
        }
        case "content_block_delta": {
          const blk = blocks.get(ev.index);
          if (!blk) return [];
          if (ev.delta.type === "text_delta") {
            blk.text += ev.delta.text;
            return [{ type: "TEXT_MESSAGE_CONTENT", messageId: blk.id, delta: ev.delta.text }];
          }
          if (ev.delta.type === "input_json_delta") {
            blk.args += ev.delta.partial_json;
            return [{ type: "TOOL_CALL_ARGS", toolCallId: blk.id, delta: ev.delta.partial_json }];
          }
          return [];
        }
        case "content_block_stop": {
          const blk = blocks.get(ev.index);
          if (!blk) return [];
          if (blk.kind === "text") {
            output.push({ id: blk.id, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: blk.text, annotations: [] }] });
            return [{ type: "TEXT_MESSAGE_END", messageId: blk.id }];
          }
          output.push({ id: blk.id, kind: "output", type: "function_call", callId: blk.id, name: blk.name, arguments: blk.args || "{}", status: "completed" });
          return [{ type: "TOOL_CALL_END", toolCallId: blk.id }];
        }
        case "message_delta":
          stop = ev.delta?.stop_reason ?? stop;
          usage.out = ev.usage?.output_tokens ?? usage.out;
          return [];
        case "message_stop":
          // A cut-off turn may carry a half-written tool call: fail it rather than run it.
          if (stop === "max_tokens") outcome.error ??= new Error("Claude stopped at the output limit.");
          if (stop === "refusal") outcome.error ??= new Error("Claude declined this request.");
          outcome.response = { id: msgId, createdAt: Date.now(), model, status: "completed", output, usage: { inputTokens: usage.in, outputTokens: usage.out, totalTokens: usage.in + usage.out } };
          return [];
        case "error":
          outcome.error ??= new Error(ev.error?.message || "Claude's stream failed.");
          return [];
        default:
          return [];
      }
    };
  }

  async function* stream(request, signal, outcome) {
    const { messages, system } = encode(request.input || []);
    const tools = (request.tools || []).filter((t) => t.kind !== "provided").map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const body = {
      system: [request.instructions, ...system, formatNote(request.responseFormat)].filter(Boolean).join("\n\n"),
      messages,
      ...(tools.length ? { tools, tool_choice: toolChoice(request.toolChoice) } : {}),
    };
    const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || `The assistant is unavailable (${res.status}).`);
    const translate = translator(outcome);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            yield* translate(JSON.parse(line.slice(6)));
          } catch (e) {
            outcome.error ??= e;
          }
        }
      }
    }
  }

  return {
    // Must return synchronously; a failed turn rejects `complete`.
    executeTurn(request, options) {
      const outcome = {};
      let resolve;
      let reject;
      const complete = new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      complete.catch(() => {});
      const events = (async function* () {
        try {
          yield* stream(request, options?.signal, outcome);
        } catch (e) {
          outcome.error ??= e;
        }
        if (outcome.error) reject(outcome.error);
        else if (outcome.response) resolve(outcome.response);
        else reject(new Error("Claude's stream ended without a reply."));
      })();
      return { stream: { [Symbol.asyncIterator]: () => events }, complete };
    },
  };
};
