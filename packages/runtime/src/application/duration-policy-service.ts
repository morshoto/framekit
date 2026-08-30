import type { DurationPolicyPlan, DurationPolicyRequest } from "../domain/duration.js";
import { planDurationPolicy } from "../editing/duration-policy.js";

export class DurationPolicyService {
  public plan(request: DurationPolicyRequest): DurationPolicyPlan {
    return planDurationPolicy(request);
  }
}
