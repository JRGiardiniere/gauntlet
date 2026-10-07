// How a finished run's digest reaches the main agent (#146), the way Claude
// Code's own background-task notices do: appended while the agent's turn runs,
// so it lands between tool calls, and submitted when the agent is idle, so it
// starts a turn. An append during the turn's last model call is read by no
// later step, so the turn's end hands it back to be submitted.
export const digestDelivery = () => {
  let busy = false
  let unread: string | undefined
  return {
    turnStarted: () => {
      busy = true
    },
    stepped: () => {
      unread = undefined
    },
    // The digest no step read, to submit now the agent is idle.
    turnEnded: (): string | undefined => {
      busy = false
      const left = unread
      unread = undefined
      return left
    },
    route: (digest: string): "append" | "submit" => {
      if (!busy) return "submit"
      unread = digest
      return "append"
    },
  }
}
