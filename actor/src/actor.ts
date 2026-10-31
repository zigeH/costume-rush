import { Actor, Emittable, Persisted } from "terse-sdk/actor"

// One Run actor per simulation ("halloween"). Durable store for app/durable.ts:
//  - done:  idempotency keys for durable.once() (exactly-once RFQs / messages / POs)
//  - state: the whole console state object, stored as a JSON string (keeps the contract simple)
//  - phase/day: small emittable mirrors so the Terse dashboard shows progress
export class Run extends Actor {
    @Persisted
    @Emittable
    done: { [key: string]: number } = {}

    @Persisted
    state = ""

    @Persisted
    @Emittable
    phase = "idle"

    @Persisted
    @Emittable
    day = 0

    async isDone(key: string): Promise<boolean> {
        return this.done[key] !== undefined
    }

    async markDone(key: string): Promise<number> {
        const at = Date.now()
        this.done = { ...this.done, [key]: at } // reassign so it persists
        return at
    }

    async saveState(json: string): Promise<void> {
        this.state = json
        try {
            const s = JSON.parse(json)
            if (typeof s?.phase === "string") this.phase = s.phase
            if (typeof s?.day === "number") this.day = s.day
        } catch {}
    }

    async getState(): Promise<string> {
        return this.state
    }

    async reset(): Promise<void> {
        this.done = {}
        this.state = ""
        this.phase = "idle"
        this.day = 0
    }
}
