/**
 * ask_async - ask the user a question without stopping the turn.
 *
 * The blocking version of this already exists in most harnesses: the agent
 * asks, then waits. This tool returns as soon as the question is on screen, so
 * the model can keep doing work that does not depend on the answer. When the
 * user answers, the reply is delivered as a steered user message, which pi
 * hands to the agent after the current assistant turn finishes its tool calls.
 *
 * This is the pattern Codex added as `send_user_message_async`. The same
 * caveat applies: nothing checkpoints the agent at the decision it asked
 * about, so an answer can arrive after the work went the other way. Ask about
 * things you can still change.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function askAsync(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_async",
		label: "Ask (async)",
		description:
			"Ask the user a question and keep working. This returns immediately; the answer arrives later as a user message. " +
			"Use it for a decision that changes the outcome but does not block what you are doing right now, and keep working on the parts that do not depend on it. " +
			"Do not use it for something you must know before the next step, and do not use it for a question you can answer from the repository or from this thread.",
		parameters: Type.Object({
			question: Type.String({ description: "The question, in one sentence." }),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description: "Choices to offer. Omit for a free-text answer. Put your recommendation first.",
				}),
			),
		}),
		executionMode: "concurrent",
		async execute(
			_toolCallId: string,
			params: { question: string; options?: string[] },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const question = (params.question ?? "").trim();
			if (question.length === 0) {
				return { content: [{ type: "text" as const, text: "ask_async needs a question." }], details: {} };
			}

			// Print and JSON modes have nobody to ask. Say so plainly rather than
			// hanging or pretending the question was delivered.
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No interactive user is attached, so the question was not asked. Proceed on your best assumption and state it in your final answer.",
						},
					],
					details: { asked: false, reason: "no-ui" },
				};
			}

			const options = (params.options ?? []).filter((o) => typeof o === "string" && o.trim().length > 0);

			// Deliberately not awaited. Awaiting here is what makes the ordinary
			// question tool block the turn.
			const pending = options.length > 0 ? ctx.ui.select(question, options) : ctx.ui.input(question);

			void Promise.resolve(pending)
				.then((answer) => {
					if (answer === undefined || answer === null || `${answer}`.trim().length === 0) {
						// Dismissed. Nothing is sent, so the agent carries on with the
						// assumption it already made.
						return;
					}
					const text = `Answering your question "${question}": ${answer}`;
					// While a turn is running the delivery mode is required. "steer"
					// hands the answer over after the current tool calls finish, which
					// is the earliest point the agent can act on it.
					if (ctx.isIdle()) pi.sendUserMessage(text);
					else pi.sendUserMessage(text, { deliverAs: "steer" });
				})
				.catch((error) => {
					ctx.ui.notify(`ask_async could not deliver the answer: ${String(error)}`, "warning");
				});

			return {
				content: [
					{
						type: "text" as const,
						text: "Question asked. Keep working on anything that does not depend on the answer; it will arrive as a user message. Do not ask it again, and do not wait for it.",
					},
				],
				details: { asked: true, question, options },
			};
		},
	});
}
