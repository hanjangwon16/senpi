import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Api,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const provider = "opencode-free";
const modelId = "opencode/deepseek-v4.1-flash-free";
const api = "opencode-free-cli";
const eventSchema = z.object({
	type: z.string(),
	part: z.object({ text: z.string().optional(), reason: z.string().optional(), cost: z.number().optional() }).passthrough().optional(),
}).passthrough();
const toolResponse = z.object({
	calls: z.array(z.object({ name: z.string(), arguments: z.record(z.string(), z.json()) }).strict()).min(1),
}).strict();

/** A new runner owns a failure latch: a failed lane cannot be retried until reload. */
export function createFreeStream() {
	let failed = false;
	return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
		const stream = createAssistantMessageEventStream();
		const output: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: [], stopReason: "pending", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		void (async () => {
			let directory: string | undefined;
			let stage = "validation";
			try {
				if (failed || model.id !== modelId || model.provider !== provider || model.api !== api) {
					throw new Error("OpenCode free lane is locked or model is not allowed");
				}
				options?.signal?.throwIfAborted();
				const tools = getCurrentTools(context.messages).filter(tool => !context.activeToolNames || context.activeToolNames.includes(tool.name));
				const payload = {
					model: modelId,
					prompt: [
						"Act as the model backend for Senpi. Never use OpenCode tools. Answer with text, or request Senpi tools with exactly SENPI_TOOL_CALLS followed by JSON: {\"calls\":[{\"name\":\"tool\",\"arguments\":{}}]}. No other text may surround a tool response. Use only the supplied tool names and schemas.",
						getCurrentSystemPrompt(context.messages),
						JSON.stringify({ tools, messages: context.messages }),
					].join("\n\n"),
				};
				const replacement = await options?.onPayload?.(payload, model);
				const request = z.object({ model: z.literal(modelId), prompt: z.string() }).strict().parse(replacement ?? payload);
				if (Buffer.byteLength(request.prompt, "utf8") > 100_000) {
					throw new Error("OpenCode prompt exceeds the safe CLI argument limit");
				}
				directory = await mkdtemp(join(tmpdir(), "senpi-opencode-free-"));
				stage = "cli";
				stream.push({ type: "start", partial: output });
				const stdout = await new Promise<string>((resolve, reject) => {
					const child = spawn("opencode", ["run", "--model", modelId, "--pure", "--format", "json", "--dir", directory ?? "", request.prompt], {
						cwd: directory, signal: options?.signal, timeout: options?.timeoutMs ?? 180_000,
						stdio: ["ignore", "pipe", "ignore"],
						env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
					});
					let captured = "";
					child.stdout.setEncoding("utf8");
					child.stdout.on("data", (chunk: string) => {
						captured += chunk;
						if (captured.length > 4 * 1024 * 1024) child.kill();
					});
					child.on("error", () => { stage = "cli-start"; reject(new Error("OpenCode CLI could not start")); });
					child.on("close", code => { stage = `cli-exit-${code}`; code === 0 ? resolve(captured) : reject(new Error("OpenCode CLI failed; no retry or fallback")); });
				});
				await options?.onResponse?.({ status: 200, headers: {} }, model);
				stage = "response";
				let text = "";
				let finished = false;
				for (const line of stdout.split(/\r?\n/).filter(line => line.trim())) {
					const event = eventSchema.parse(JSON.parse(line));
					await options?.onProviderStreamEvent?.(event, model);
					if (event.type === "error" || event.type === "tool_use" || (event.part?.cost !== undefined && event.part.cost !== 0)) {
						throw new Error("OpenCode rejected the free-only request");
					}
					if (event.type === "text") text += event.part?.text ?? "";
					if (event.type === "step_finish") {
						if (event.part?.reason !== "stop") throw new Error("OpenCode did not finish normally");
						finished = true;
					}
				}
				if (!finished || !text.trim()) throw new Error("OpenCode returned an incomplete response");
				if (text.startsWith("SENPI_TOOL_CALLS")) {
					const response = toolResponse.parse(JSON.parse(text.slice("SENPI_TOOL_CALLS".length)));
					for (const [index, call] of response.calls.entries()) {
						if (!tools.some(tool => tool.name === call.name)) throw new Error("OpenCode requested an unavailable Senpi tool");
						const toolCall = { type: "toolCall" as const, id: `opencode-${output.timestamp}-${index}`, ...call };
						output.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
					}
					output.stopReason = "toolUse";
				} else {
					const block = { type: "text" as const, text: "" };
					output.content.push(block);
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					block.text = text;
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
					output.stopReason = "stop";
				}
				stream.push({ type: "done", reason: output.stopReason, message: output });
			} catch (error) {
				// CLI/provider output is deliberately not echoed: it may contain auth material.
				failed = true;
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = `OpenCode free-only request failed at ${stage} (${error instanceof Error ? error.name : "unknown"}). Stopped without retry or model fallback; check the CLI locally before reloading the extension.`;
				stream.push({ type: "error", reason: output.stopReason, error: output });
			} finally {
				try {
					if (directory) await rm(directory, { recursive: true, force: true });
				} finally {
					stream.end();
				}
			}
		})();
		return stream;
	};
}

export default function opencodeFree(pi: ExtensionAPI) {
	pi.registerProvider(provider, {
		name: "OpenCode CLI (pinned free only)", api, baseUrl: "cli:opencode", apiKey: "cli-managed-no-secret",
		fallbackEligible: () => false,
		models: [{ id: modelId, name: "DeepSeek V4.1 Flash Free (OpenCode CLI)", reasoning: false,
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }],
		streamSimple: createFreeStream(),
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant" && event.message.provider === provider &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted")) ctx.abort("system");
	});
	pi.on("model_select", (event, ctx) => {
		if (event.previousModel?.provider === provider && (event.source === "fallback" || event.source === "fallback-revert")) ctx.abort("system");
	});
}
