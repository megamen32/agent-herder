/**
 * Built-in LLM summarizer for session transcripts.
 * Uses OpenAI-compatible API at llm.bezrabotnyi.com with gemma4 model.
 * Designed to compress long transcripts into useful summaries,
 * saving tokens and context when reviewing agent sessions.
 */

const DEFAULT_API_BASE = "https://llm.bezrabotnyi.com/v1";
const DEFAULT_MODEL = "gemma4";

export interface SummarizerConfig {
  apiBase?: string;
  model?: string;
  apiKey?: string;
  maxTokens?: number;
}

/**
 * Summarize a session transcript using the built-in LLM.
 */
export async function summarizeTranscript(
  transcript: string,
  config: SummarizerConfig = {}
): Promise<{ summary: string; error?: string }> {
  const apiBase = config.apiBase || process.env.SUMMARIZER_API_BASE || DEFAULT_API_BASE;
  const model = config.model || process.env.SUMMARIZER_MODEL || DEFAULT_MODEL;
  const apiKey = config.apiKey || process.env.SUMMARIZER_API_KEY;

  if (!apiKey) {
    return { summary: "", error: "SUMMARIZER_API_KEY not set. Cannot summarize without an API key." };
  }

  // Truncate very long transcripts to avoid token limits
  const maxInputLength = 60_000;
  const truncatedTranscript = transcript.length > maxInputLength
    ? transcript.slice(0, maxInputLength) + "\n\n[... transcript truncated for length ...]"
    : transcript;

  const systemPrompt = `You are a concise session summarizer for AI coding agents. 
Given a transcript of an agent's session, produce a structured summary in this format:

## Task
<What the user asked the agent to do>

## Progress  
<What has been accomplished so far, key files changed, features implemented>

## Current State
<What the agent is currently working on or blocked on>

## Issues / Next Steps
<Any errors encountered, pending decisions, or recommended next actions>

Be concise but complete. Focus on actionable information. Use the same language as the transcript.`;

  try {
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Summarize this agent session transcript:\n\n${truncatedTranscript}` },
        ],
        max_tokens: config.maxTokens || 1024,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown error");
      return { summary: "", error: `Summarizer API returned ${response.status}: ${errText}` };
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const summary = data.choices?.[0]?.message?.content;

    if (!summary) {
      return { summary: "", error: "Summarizer returned empty response" };
    }

    return { summary };
  } catch (err) {
    return { summary: "", error: `Summarizer request failed: ${(err as Error).message}` };
  }
}

/**
 * Extract a quick one-line summary (cheaper than full summarize).
 */
export async function quickSummary(
  transcript: string,
  config: SummarizerConfig = {}
): Promise<{ summary: string; error?: string }> {
  const apiBase = config.apiBase || process.env.SUMMARIZER_API_BASE || DEFAULT_API_BASE;
  const model = config.model || process.env.SUMMARIZER_MODEL || DEFAULT_MODEL;
  const apiKey = config.apiKey || process.env.SUMMARIZER_API_KEY;

  if (!apiKey) {
    return { summary: "", error: "SUMMARIZER_API_KEY not set" };
  }

  const truncated = transcript.length > 15_000 ? transcript.slice(0, 15_000) + "\n[truncated]" : transcript;

  try {
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "Summarize this AI coding agent session in 1-3 sentences. Focus on: what task was given, current progress, and if there are any problems. Be concise.",
          },
          { role: "user", content: truncated },
        ],
        max_tokens: 200,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      return { summary: "", error: `API returned ${response.status}` };
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return { summary: data.choices?.[0]?.message?.content || "" };
  } catch (err) {
    return { summary: "", error: (err as Error).message };
  }
}