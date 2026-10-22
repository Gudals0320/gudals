export type Draft =
  | { phase: 'structuring'; raw: string; startedAt: number }
  | { phase: 'ready'; raw: string; structured: string }
  | { phase: 'failed'; raw: string; reason: string }

declare module 'claude-code' {
  interface PluginState {
    gudals: {
      transpromptDraft: Draft | null
      transpromptBypassNext: boolean
    }
  }
}
