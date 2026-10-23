// PLACEHOLDER: an in-memory WorldModel so the Critic can record facts before the real world-model
// engine exists. Facts live only for the process; filtering is exact match on the given fields.
import type { Fact, FactFilter, WorldModel } from "../types.js";

export class InMemoryWorldModel implements WorldModel {
  private readonly facts: Fact[] = [];

  async addFact(f: Fact): Promise<void> {
    this.facts.push({ ...f });
  }

  async getFacts(filter: FactFilter = {}): Promise<Fact[]> {
    return this.facts.filter(
      (f) =>
        (filter.claim_id === undefined || f.claim_id === filter.claim_id) &&
        (filter.section_id === undefined || f.section_id === filter.section_id) &&
        (filter.verdict === undefined || f.verdict === filter.verdict),
    );
  }
}
