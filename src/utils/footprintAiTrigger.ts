const FOOTPRINT_AI_TRIGGER_PARAM = 'generateAi'

export function buildFootprintAiTriggerPath(): string {
  return `/footprint?${FOOTPRINT_AI_TRIGGER_PARAM}=1`
}

export function shouldAutoGenerateFootprintAi(search: string): boolean {
  return new URLSearchParams(search).get(FOOTPRINT_AI_TRIGGER_PARAM) === '1'
}

export function removeFootprintAiTrigger(search: string): string {
  const params = new URLSearchParams(search)
  params.delete(FOOTPRINT_AI_TRIGGER_PARAM)
  const next = params.toString()
  return next ? `?${next}` : ''
}
