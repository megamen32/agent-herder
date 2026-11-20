import { z } from "zod";

const maxBytes = 2 * 1024 * 1024;
/** The GPTAdmin exec facade limits its complete UTF-8 program to 64 KiB. */
export class FleetAttachmentFrameTooLarge extends Error {
  constructor() { super("fleet_attachment_frame_too_large"); }
}
const maxBase64Length = (bytes: number) => 4 * Math.ceil(bytes / 3);
const mimeType = /^[a-zA-Z0-9!#$%&'+.^_\x60|~-]+\/[a-zA-Z0-9!#$%&'+.^_\x60|~-]+$/;

/** Wire format and aggregate budget shared with the Rust owner's InlineAttachment. */
const file = z.object({
  name: z.string().min(1).max(255).refine(name =>
    Buffer.byteLength(name) <= 255 && !/^\p{White_Space}*$/u.test(name)
    && name !== "." && name !== ".." && !/[\\/\p{Cc}]/u.test(name), "Invalid attachment filename"),
  mime_type: z.string().max(255).regex(mimeType),
  data_base64: z.string().max(maxBase64Length(maxBytes)),
}).strict();

export type MeshInlineAttachment = z.infer<typeof file>;
export const meshAttachmentsSchema = z.array(file).max(16).superRefine((files, ctx) => {
  if (files.length > 16) return;
  let remaining = maxBytes;
  for (const [index, { data_base64 }] of files.entries()) {
    if (data_base64.length <= maxBase64Length(remaining)) {
      const bytes = Buffer.from(data_base64, "base64");
      if (bytes.length <= remaining && bytes.toString("base64") === data_base64) {
        remaining -= bytes.length;
        continue;
      }
    }
    ctx.addIssue({ code: "custom", path: [index, "data_base64"], message: "Invalid base64 or attachment byte limit exceeded" });
    return;
  }
});

const address = z.object({
  hostId: z.string().trim().min(1).max(512),
  harness: z.string().trim().min(1).max(64),
  nativeSessionId: z.string().trim().min(1).max(512),
}).strict();

/** ChatGPT also accepts an image or a file without a caption. */
export function hasMeshMessage(harness: string, message: string, attachments?: readonly MeshInlineAttachment[]): boolean {
  return message.length <= 4000 && (message.trim().length > 0 || (harness === "chatgpt" && Boolean(attachments?.length)));
}

export const meshDeliverySchema = z.object({
  target: address,
  sender: address,
  inputId: z.string().trim().min(1).max(256),
  message: z.string().max(4000),
  attachments: meshAttachmentsSchema.optional(),
}).strict().refine(request => hasMeshMessage(request.target.harness, request.message, request.attachments), "Message cannot be blank");
