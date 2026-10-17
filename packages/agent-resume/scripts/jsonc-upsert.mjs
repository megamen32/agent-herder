#!/usr/bin/env node
/**
 * Insert or replace one member inside a JSON object literal.
 *
 * The surrounding file is never re-serialised: comments, ordering and
 * formatting belong to the operator, so only the named member's text changes,
 * and running the installer twice is a no-op. Every helper works on absolute
 * indexes in the original text.
 */

/** Matching close brace of the object that starts at `open`, ignoring strings. */
export function findObjectEnd(text, open) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "{") depth++;
    else if (character === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Object that follows `"key":`, or null when the key is absent. */
export function findObjectForKey(text, key) {
  const match = new RegExp(`"${key}"\\s*:`).exec(text);
  if (!match) return null;
  const colon = text.indexOf(":", match.index);
  const open = text.indexOf("{", colon);
  if (open < 0) return null;
  const close = findObjectEnd(text, open);
  return close < 0 ? null : { open, close };
}

/** Span of an existing member inside `[containerOpen, containerClose]`, or null. */
export function findMemberSpan(text, containerOpen, containerClose, memberName) {
  const pattern = new RegExp(`"${memberName}"\\s*:\\s*\\{`, "g");
  pattern.lastIndex = containerOpen;
  const match = pattern.exec(text);
  if (!match || match.index > containerClose) return null;
  const memberOpen = match.index + match[0].length - 1;
  const close = findObjectEnd(text, memberOpen);
  if (close < 0) return null;
  // Only the member's own indentation belongs to it; the newline in front does not.
  let start = match.index;
  while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start--;
  return { start, end: close + 1, indent: text.slice(start, match.index) };
}

/** Indentation used by a member of the object, or the given default. */
export function memberIndent(text, containerOpen, containerClose, fallback) {
  const block = text.slice(containerOpen, containerClose);
  const match = /\n([ \t]+)"/.exec(block);
  return match ? match[1] : fallback;
}

/**
 * Re-indent a member block, keeping the block's own relative indentation so a
 * nested member stays nested under the same key.
 */
export function indentBlock(entry, indent) {
  return entry
    .split("\n")
    .map((line, index) => {
      if (!line.trim()) return line;
      return index === 0 ? indent + line.trim() : indent + line;
    })
    .join("\n");
}

export function upsertMember(text, key, memberName, entry, defaultIndent = "    ") {
  const container = findObjectForKey(text, key);
  if (!container) return null;
  const span = findMemberSpan(text, container.open, container.close, memberName);
  if (span) {
    // Keep the exact indentation already used for this member.
    const indent = span.indent || memberIndent(text, container.open, container.close, defaultIndent);
    return text.slice(0, span.start) + indentBlock(entry, indent) + text.slice(span.end);
  }
  const indent = memberIndent(text, container.open, container.close, defaultIndent);
  const body = indentBlock(entry, indent);
  const raw = text.slice(container.open + 1, container.close);
  const members = raw.replace(/\s+$/, "");
  // The whitespace in front of the container's closing brace belongs to it.
  const tail = raw.slice(members.length);
  const merged = members ? `${members},\n${body}${tail}` : `\n${body}${tail}`;
  return `${text.slice(0, container.open + 1)}${merged}${text.slice(container.close)}`;
}