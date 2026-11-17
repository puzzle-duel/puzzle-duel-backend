# Stage E — ADR decision matrix

| Decision | Source | Binding? | Stage E action |
| --- | --- | --- | --- |
| D1–D10 engine rules | ADR-E01 | Design Accepted | Use Stage C engine unchanged |
| Trusted ingress / deadline exclusive | ADR-T02 TD-02/03 | Design Accepted | Phase A ingress imported |
| Client score never ranked authority | ADR-E01 §7 / ADR-T02 TD-11 | Design Accepted | `scoreDelta`/`completesSeries` stripped from authority path |
| Writer fence + board revision CAS | ADR-T02 TD-03/05 | Design Accepted | Mandatory for ranked moves |
| Four-category leaderboard publish | ADR-T02 TD-12 | Design Accepted (product) | Interface only; **NOT_RUN** |
| HTTP routes / OpenAPI | ADR-T02 TD-18 | Pending contracts | **NOT_RUN** — no speculative endpoints |
| Auth/session/device model | ADR-002 / TD-05 | Proposed / incomplete | Consistency checks only; auth E2E **NOT_RUN** |
| ADR-T01 technical text | ADR-T01 | **Proposed** | Not promoted |
| Blueprint v1.1 tournament MVP | BLUEPRINT.md | Missing | Feature-flag / Draft PR only |
| Production SQL migrations | AGENTS.md / T02 | Required before prod | Memory + Phase A DDL; migrations README notes gap |

Stop points preserved as NOT_RUN rather than invented policy.
