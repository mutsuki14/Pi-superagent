/** Shared tool primitives: a zod-described tool, and its bridge to a Pi `ToolDefinition`. */
import { z } from 'zod'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'
import { IM_WORDS, wordCount } from './text.ts'
import { UserError } from '../core/index.ts'

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  schema: S
  execute: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown>
}
export const tool = <S extends z.ZodType>(definition: Tool<S>): Tool => definition as unknown as Tool

/** Human-facing acknowledgement text, constrained to `IM_WORDS` regardless of which channel it is posted to. */
export const AcknowledgementSchema = z.string().trim().min(1)
  .refine(text => wordCount(text) <= IM_WORDS, `An acknowledgement has at most ${IM_WORDS} words (Chinese uses word segmentation); write one short sentence.`)

/** Formats a tool result or error as the text the model reads. */
export const toolText = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 1)

/**
 * Bridges a zod-described tool to a Pi `ToolDefinition`: the JSON Schema Pi validates arguments against comes from zod, and
 * the zod schema parses them again so refinements hold. A `UserError` or any other failure is returned as an error result,
 * so the model reads why and goes on.
 */
export function piTool(definition: Tool, log?: (message: string) => void): ToolDefinition {
  const parameters = z.toJSONSchema(definition.schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' }) as unknown as TSchema
  delete (parameters as { $schema?: string }).$schema
  return {
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters,
    async execute(_id, params, signal) {
      try {
        const args = definition.schema.parse(params)
        const result = await definition.execute(args, signal ?? new AbortController().signal)
        return { content: [{ type: 'text', text: toolText(result ?? { ok: true }) }], details: {} }
      } catch (error) {
        const message = error instanceof UserError ? `Refused: ${error.message}` : error instanceof z.ZodError
          ? `Invalid arguments: ${error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
          : `Error: ${error instanceof Error ? error.message : String(error)}`
        log?.(`tool ${definition.name} failed: ${message}`)
        return { content: [{ type: 'text', text: message }], details: {}, isError: true }
      }
    },
  }
}
