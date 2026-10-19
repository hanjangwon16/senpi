import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Api, type Model, Type } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createFreeStream } from "./index.ts";

const model: Model<Api> = {
	id: "opencode/deepseek-v4.1-flash-free", name: "Free fixture", provider: "opencode-free", api: "opencode-free-cli",
	baseUrl: "cli:opencode", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function context(mode: string) {
	return normalizeContext({ systemPrompt: "Fixture", messages: [{ role: "user", content: mode, timestamp: 0 }],
		tools: [{ name: "read", description: "Read fixture", parameters: Type.Object({ path: Type.String() }) }] });
}

describe.serial("free-only OpenCode process boundary", () => {
	let directory: string;
	let originalPath: string | undefined;
	let originalCalls: string | undefined;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencode-free-test-"));
		originalPath = process.env.PATH;
		originalCalls = process.env.SENPI_OPENCODE_TEST_CALLS;
		process.env.PATH = `${fileURLToPath(new URL("./fixtures", import.meta.url))}${delimiter}${originalPath}`;
		process.env.SENPI_OPENCODE_TEST_CALLS = join(directory, "calls");
	});
	afterEach(async () => {
		if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
		if (originalCalls === undefined) delete process.env.SENPI_OPENCODE_TEST_CALLS; else process.env.SENPI_OPENCODE_TEST_CALLS = originalCalls;
		await rm(directory, { recursive: true, force: true });
	});
	test("returns text through a pinned isolated CLI process", async () => {
		const stream = createFreeStream()(model, context("text"));
		const events = [];
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();
		expect(result.content).toEqual([{ type: "text", text: "FIXTURE_OK" }]);
		expect(events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
	});
	test("returns a declared tool call for execution by Senpi", async () => {
		const result = await createFreeStream()(model, context("tool")).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({ type: "toolCall", name: "read", arguments: { path: "sample.ts" } });
	});
	for (const mode of ["exit", "invalid-json", "provider-error", "incomplete", "paid-cost", "unavailable-tool", "malformed-tool"]) {
		test(`stops and locks further subprocesses when ${mode}`, async () => {
			const run = createFreeStream();
			const result = await run(model, context(mode)).result();
			const repeated = await run(model, context("text")).result();
			expect([result.stopReason, repeated.stopReason]).toEqual(["error", "error"]);
			expect(result.errorMessage).not.toContain("SECRET_NOT_FOR_OUTPUT");
			expect(await readFile(join(directory, "calls"), "utf8")).toBe("call\n");
		});
	}
	for (const id of ["opencode/paid", "opencode/another-free", "deepseek-v4.1-flash-free"]) {
		test(`rejects non-whitelisted model ${id} before execution`, async () => {
			const result = await createFreeStream()({ ...model, id }, context("text")).result();
			expect(result.stopReason).toBe("error");
			expect(await Bun.file(join(directory, "calls")).exists()).toBe(false);
		});
	}
	test("rejects a payload hook that substitutes a model", async () => {
		const result = await createFreeStream()(model, context("text"), { onPayload: () => ({ model: "opencode/paid", prompt: "fixture" }) }).result();
		expect(result.stopReason).toBe("error");
		expect(await Bun.file(join(directory, "calls")).exists()).toBe(false);
	});
	test("does not spawn for an already cancelled request", async () => {
		const result = await createFreeStream()(model, context("text"), { signal: AbortSignal.abort() }).result();
		expect(result.stopReason).toBe("aborted");
		expect(await Bun.file(join(directory, "calls")).exists()).toBe(false);
	});
});
