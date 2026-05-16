type ScreeningInput = {
  severityScore: bigint
}

let pendingInput: ScreeningInput | null = null

export function setScreeningInput(input: ScreeningInput) {
  pendingInput = input
}

export function clearScreeningInput() {
  pendingInput = null
}

export const witnesses = {
  severityScore({ privateState }: any) {
    return [privateState, pendingInput?.severityScore ?? 0n]
  },
}
