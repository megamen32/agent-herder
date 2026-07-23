import { SessionConverter, type Conversation, type ConversionResult, type HarnessType } from "session-convert";

export interface ConvertSessionInput {
  sessionId: string;
  from: HarnessType;
  to: HarnessType;
  projectPath?: string;
  searchPaths?: string[];
}

export interface ReadSessionInput {
  sessionId: string;
  from: HarnessType;
  searchPaths?: string[];
}

/** Thin domain wrapper that keeps conversion behind the agent-herder service boundary. */
export class AgentHerderSessionConverter {
  private readonly converter: SessionConverter;

  constructor(converter = new SessionConverter()) {
    this.converter = converter;
  }

  async convert(input: ConvertSessionInput): Promise<ConversionResult> {
    if (input.from === input.to) {
      return { success: false, error: "Source and target harness must differ" };
    }
    return this.converter.convert(input.from, input.to, input.sessionId, {
      projectPath: input.projectPath,
      searchPaths: input.searchPaths,
    });
  }

  async read(input: ReadSessionInput): Promise<Conversation | null> {
    return this.converter.readSession(input.from, input.sessionId, { searchPaths: input.searchPaths });
  }
}
