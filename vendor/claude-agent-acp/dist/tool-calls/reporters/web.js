import { formatWebSearchHit, resultText, structuredResult, textContent } from "../content.js";
/** WebFetch: the prompt is input that the user reads. The answer is the result. */
export class WebFetchReporter {
    toolUse(input) {
        const fetch = input;
        return {
            title: fetch?.url ? `Fetch ${fetch.url}` : "Fetch",
            kind: "fetch",
            ...(fetch?.prompt ? { display: [textContent(fetch.prompt)] } : {}),
        };
    }
}
/** WebSearch: the hits are the result to show. */
export class WebSearchReporter {
    toolUse(input) {
        const search = input;
        return {
            title: search?.query ? `Search "${search.query}"` : "Web search",
            kind: "fetch",
        };
    }
    toolResult({ result, structured }) {
        // The raw tool_result text is a model-directed dump. The structured
        // WebSearchOutput carries the hits: render them like server-side
        // web_search_result blocks ("Title (url)").
        const structuredSearch = structuredResult(structured);
        if (structuredSearch && Array.isArray(structuredSearch.results)) {
            const lines = structuredSearch.results.flatMap((entry) => typeof entry === "string"
                ? [entry]
                : Array.isArray(entry?.content)
                    ? // tool_use_result arrives untyped across CLI versions: skip
                        // off-spec hits instead of "undefined (undefined)" lines.
                        entry.content.flatMap((hit) => typeof hit?.title === "string" && typeof hit?.url === "string"
                            ? [formatWebSearchHit(hit)]
                            : [])
                    : []);
            if (lines.length > 0)
                return { content: [textContent(lines.join("\n"))] };
        }
        return resultText(result);
    }
}
