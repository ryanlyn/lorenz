import { randomUUID } from "node:crypto";
import { CreateElicitationResponse } from "@agentclientprotocol/sdk";
import { AIR_CUSTOM_ANSWER_KEY, withAirMeta } from "./air-extension.js";
/**
 * Convert an MCP elicitation request (from the SDK's `onElicitation` callback)
 * into an ACP `CreateElicitationRequest`. Returns `null` when the request can't
 * be represented (e.g. a url-mode request with no url).
 */
export function mcpElicitationToCreateRequest(request, sessionId) {
    if (request.mode === "url") {
        if (!request.url) {
            return null;
        }
        return {
            mode: "url",
            sessionId,
            message: request.message,
            url: request.url,
            // URL elicitations need a stable id so the client can correlate the
            // later `session/complete_elicitation` notification. MCP servers usually
            // provide one; fall back to a generated id if not.
            elicitationId: request.elicitationId ?? randomUUID(),
        };
    }
    // Form mode (the default). The MCP `requestedSchema` is already a JSON Schema
    // with primitive-typed properties, which is structurally what ACP expects.
    return {
        mode: "form",
        sessionId,
        message: request.message,
        requestedSchema: normalizeElicitationSchema(request.requestedSchema),
    };
}
/**
 * Content of an accepted elicitation response.
 *
 * Uses the SDK's validating guard rather than an `action === "accept"` check:
 * the guard both narrows past the union's custom/future variant and validates
 * the payload, so a malformed accept (right tag, ill-typed content) yields
 * empty content — the same classification the SDK's wire validators apply.
 */
function acceptedElicitationContent(response) {
    return CreateElicitationResponse.isAccept(response) ? (response.content ?? {}) : {};
}
/**
 * Map an ACP elicitation response back to the MCP `ElicitResult` the SDK expects
 * to hand back to the requesting server.
 */
export function createElicitationResponseToElicitResult(response) {
    switch (response.action) {
        case "accept":
            return { action: "accept", content: acceptedElicitationContent(response) };
        case "decline":
            return { action: "decline" };
        case "cancel":
        default:
            return { action: "cancel" };
    }
}
/**
 * Pull the well-formed questions out of an AskUserQuestion tool input. Returns
 * `null` when there are no usable questions — including the case where every
 * entry is malformed and filtering leaves an empty list — so callers can treat
 * "nothing to ask" uniformly.
 */
export function extractAskUserQuestions(input) {
    const questions = input.questions;
    if (!Array.isArray(questions)) {
        return null;
    }
    const valid = questions.filter((q) => !!q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length > 0);
    return valid.length > 0 ? valid : null;
}
/** Stable form-field key for the question at the given index. */
function questionFieldKey(index) {
    return `question_${index}`;
}
/**
 * Form-field key for the per-question free-text "custom answer" field that sits
 * alongside `question_<n>`. Mirrors the first-party clients, where every
 * question carries its own "Other" box rather than one form-level field.
 */
function questionCustomFieldKey(index) {
    return `question_${index}_custom`;
}
/**
 * `_meta` key under which a bridged enum option carries its `preview`, the one
 * option field ACP's `EnumOption` still has no slot for (descriptions are
 * first-class as of schema 1.19). Namespaced like the agent's other `_meta`
 * extensions (`_claude/...`).
 */
const OPTION_META_KEY = "_claude/askUserQuestionOption";
/**
 * Render the AskUserQuestion tool's questions as an ACP form elicitation.
 *
 * Fields are keyed by a short stable id (`question_<n>`) rather than the full
 * question text, so the question text appears in exactly one place per field.
 * Single-select questions use a titled `oneOf` enum; multi-select questions use
 * an array with a titled `anyOf` item enum. The enum `const` is always the
 * option label, since that is what the tool records as the answer; an option's
 * secondary text travels in the enum option's own `description` field.
 *
 * Each question is followed by its own optional free-text "custom answer" field
 * (`question_<n>_custom`), mirroring the CLI's per-question "Other" box: the
 * user can type their own answer instead of picking an option, add it to a
 * multi-select's picks, or attach it as a note to a single-select's pick (see
 * `applyAskElicitationResponse`), scoped to that specific question. Nothing is
 * marked required, so the user can also just skip — matching the built-in tool,
 * which always offers Skip + a free-text box.
 */
export function askUserQuestionsToCreateRequest(questions, sessionId, toolCallId, airClient = false) {
    const single = questions.length === 1;
    const properties = {};
    questions.forEach((question, index) => {
        const options = question.options.map((option) => {
            const enumOption = {
                const: option.label,
                title: option.label,
            };
            if (option.description) {
                enumOption.description = option.description;
            }
            // The SDK option's `preview` (mockups, code snippets, comparisons shown
            // on focus) still has no structural slot in `EnumOption`, so forward it
            // under ACP's reserved `_meta` extension point for clients that render it.
            if (option.preview) {
                enumOption._meta = { [OPTION_META_KEY]: { preview: option.preview } };
            }
            return enumOption;
        });
        // For a single question the prompt is carried by `message`, so we don't
        // repeat it in the field description. With multiple questions each field
        // needs its own question text.
        const description = single ? undefined : question.question;
        const title = question.header || undefined;
        properties[questionFieldKey(index)] = question.multiSelect
            ? { type: "array", title, description, items: { anyOf: options } }
            : { type: "string", title, description, oneOf: options };
        properties[questionCustomFieldKey(index)] = {
            type: "string",
            title: "Other",
            description: question.multiSelect
                ? "Type your own answer to add to your selection above (optional)."
                : "Type your own answer, or add a note to the option you chose above (optional).",
            // Marks the field as the custom answer companion of a select question,
            // under `_meta.jetbrains.air.customAnswer`. Only AIR gets the marker.
            ...(airClient
                ? {
                    _meta: withAirMeta(undefined, AIR_CUSTOM_ANSWER_KEY, {
                        questionId: questionFieldKey(index),
                        isCustomAnswer: true,
                    }),
                }
                : {}),
        };
    });
    const requestedSchema = {
        type: "object",
        properties,
    };
    const message = single ? questions[0].question : "Please answer the following questions.";
    return {
        mode: "form",
        sessionId,
        ...(toolCallId ? { toolCallId } : {}),
        message,
        requestedSchema,
    };
}
/**
 * Serialize a multi-select answer the way the CLI's own AskUserQuestion UI
 * does: comma-joined, with any item that itself contains the separator (or a
 * double quote) JSON-quoted. The tool's `call()` splits the string back on the
 * same rule, so a free-text answer like `Redis, not Memcached` stays one item
 * instead of reading as two more picks.
 */
function joinMultiSelectAnswer(items) {
    return items
        .map((item) => (item.includes(", ") || item.includes('"') ? JSON.stringify(item) : item))
        .join(", ");
}
/**
 * Fold an ACP elicitation response into the AskUserQuestion tool's input.
 *
 * Selected labels are read back from the indexed form fields and written into
 * `answers` as a `{ [questionText]: label }` map — the key shape the tool's own
 * `call()` reads — with multi-selects comma-joined in the CLI's own quoted form
 * (see `joinMultiSelectAnswer`). A non-empty per-question custom-answer field
 * (`question_<n>_custom`) joins the selection of a multi-select question, where
 * the two fields are independent and filling both means both. For a
 * single-select question it is the answer when nothing was picked (the user
 * typed their own instead), and otherwise travels beside the pick as the
 * tool's own per-question `annotations[question].notes` — the slot the CLI
 * uses for free text attached to a selection and renders to the model as
 * `"Q"="A" notes: ...` — so a client that presents the box as a notes field
 * cannot make the selection disappear. Decline yields empty answers (the model
 * is told the user skipped rather than the turn aborting); cancel — and any
 * custom/future action we don't understand — aborts the tool call.
 */
export function applyAskElicitationResponse(response, toolInput, questions) {
    if (response.action === "decline") {
        return { action: "answered", updatedInput: { ...toolInput, answers: {} } };
    }
    if (response.action !== "accept") {
        return { action: "cancel" };
    }
    const content = acceptedElicitationContent(response);
    // Typed against the tool's own output schema so the answer/response shapes
    // stay in sync with what the built-in tool's call() expects to read back.
    const answers = {};
    const annotations = {};
    questions.forEach((question, index) => {
        const custom = content[questionCustomFieldKey(index)];
        const customText = typeof custom === "string" ? custom.trim() : "";
        const value = content[questionFieldKey(index)];
        const picks = value === undefined || value === null
            ? []
            : Array.isArray(value)
                ? value.filter((item) => item !== undefined && item !== null && item !== "").map(String)
                : [String(value)];
        // A multi-select is additive, and the form offers the selection and the
        // custom box as independent fields — a user who fills both means both, so
        // the typed answer joins the checked options.
        if (question.multiSelect) {
            const text = joinMultiSelectAnswer(customText === "" ? picks : [...picks, customText]);
            if (text !== "") {
                answers[question.question] = text;
            }
            return;
        }
        // A single-select question is answered by exactly one thing. With no option
        // picked, the typed text is that answer (the CLI's "Other"). With an option
        // picked as well, the pick stays the answer and the text rides along as the
        // tool's per-question `notes` annotation, so neither is lost. A single-select
        // normally holds one item; the plain join only matters if a client hands
        // back an array for it, and then mirrors the old behavior.
        const picked = picks.join(", ");
        if (picked === "") {
            if (customText !== "") {
                answers[question.question] = customText;
            }
            return;
        }
        answers[question.question] = picked;
        if (customText !== "") {
            annotations[question.question] = { notes: customText };
        }
    });
    return {
        action: "answered",
        updatedInput: {
            ...toolInput,
            answers,
            ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
        },
    };
}
/**
 * Coerce an arbitrary MCP `requestedSchema` into an ACP `ElicitationSchema`.
 * The two are structurally compatible JSON Schemas; we just guarantee the
 * `type: "object"` discriminator is present.
 */
function normalizeElicitationSchema(schema) {
    if (!schema || typeof schema !== "object") {
        return { type: "object", properties: {} };
    }
    return { ...schema, type: "object" };
}
/**
 * The `request_user_dialog` kind the CLI emits when a model refusal has a
 * fallback available but needs user consent before retrying (e.g. Claude Fable
 * declining a request with Opus available as the fallback). Declaring this
 * kind in `supportedDialogKinds` is the opt-in: the CLI fails closed and never
 * emits an undeclared kind — the flow degrades to the classic refusal error
 * ending the turn.
 */
export const REFUSAL_FALLBACK_DIALOG_KIND = "refusal_fallback_prompt";
/**
 * Validate the opaque dialog payload into a {@link RefusalFallbackPrompt}.
 * Returns `null` when the required fields are missing or mistyped (a newer CLI
 * may reshape the payload), so the caller can cancel the dialog and let the
 * CLI apply its default behavior instead of rendering something misleading.
 */
export function extractRefusalFallbackPrompt(payload) {
    const { originalModel, fallbackModel, apiRefusalCategory, guidanceText } = payload;
    if (typeof originalModel !== "string" || typeof fallbackModel !== "string") {
        return null;
    }
    return {
        originalModel,
        fallbackModel,
        apiRefusalCategory: typeof apiRefusalCategory === "string" ? apiRefusalCategory : null,
        ...(typeof guidanceText === "string" && guidanceText ? { guidanceText } : {}),
    };
}
/** Form-field key carrying the user's choice in the refusal-fallback form. */
const REFUSAL_FALLBACK_CHOICE_KEY = "choice";
/** Wire values of the dialog's result enum (CLI schema). `edit_prompt` is
 *  deliberately not offered: in the CLI it prefills the composer with the
 *  refused prompt for edit-and-retry, and ACP has no composer-prefill surface
 *  — the user can simply edit and resend on their own. */
const RETRY_FALLBACK_RESULT = "retry_fallback";
const KEEP_REFUSAL_RESULT = "cancelled";
/**
 * Render the refusal-fallback consent prompt as an ACP form elicitation: a
 * single-select between retrying on the fallback model and keeping the
 * refusal. The enum `const`s are the dialog's wire result values, so the
 * response maps back without a translation table.
 */
export function refusalFallbackToCreateRequest(prompt, sessionId) {
    const category = prompt.apiRefusalCategory ? ` (${prompt.apiRefusalCategory})` : "";
    const guidance = prompt.guidanceText ? `\n\n${prompt.guidanceText}` : "";
    return {
        mode: "form",
        sessionId,
        message: `${prompt.originalModel} declined this request${category}. ` +
            `Retry with ${prompt.fallbackModel}?` +
            guidance,
        requestedSchema: {
            type: "object",
            properties: {
                [REFUSAL_FALLBACK_CHOICE_KEY]: {
                    type: "string",
                    oneOf: [
                        {
                            const: RETRY_FALLBACK_RESULT,
                            title: `Retry with ${prompt.fallbackModel}`,
                            description: `The session continues on ${prompt.fallbackModel}.`,
                        },
                        {
                            const: KEEP_REFUSAL_RESULT,
                            title: "Keep the refusal",
                            description: "You can send a new message.",
                        },
                    ],
                },
            },
        },
    };
}
/**
 * Map the elicitation response back to the dialog's result enum. Only an
 * explicit accept-with-retry resolves to `retry_fallback`; decline, cancel, a
 * skipped field, or an unrecognized value all keep the refusal — the dialog's
 * own default — so a dismissed or half-filled form can never trigger a model
 * switch the user didn't ask for.
 */
export function refusalFallbackResultFromResponse(response) {
    const choice = acceptedElicitationContent(response)[REFUSAL_FALLBACK_CHOICE_KEY];
    return choice === RETRY_FALLBACK_RESULT ? RETRY_FALLBACK_RESULT : KEEP_REFUSAL_RESULT;
}
