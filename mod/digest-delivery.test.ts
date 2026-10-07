import { describe, expect, it } from "vitest"
import { digestDelivery } from "./digest-delivery.ts"

describe("the digest's way to the main agent", () => {
  it("wakes an idle agent and lands between a busy agent's tool calls", () => {
    const delivery = digestDelivery()
    expect(delivery.route("idle digest")).toBe("submit")
    delivery.turnStarted()
    expect(delivery.route("busy digest")).toBe("append")
    delivery.stepped()
    expect(delivery.turnEnded()).toBeUndefined()
  })

  it("submits a digest appended during the turn's last model call when the turn ends", () => {
    const delivery = digestDelivery()
    delivery.turnStarted()
    delivery.stepped()
    expect(delivery.route("late digest")).toBe("append")
    expect(delivery.turnEnded()).toBe("late digest")
    expect(delivery.route("next digest")).toBe("submit")
  })
})
