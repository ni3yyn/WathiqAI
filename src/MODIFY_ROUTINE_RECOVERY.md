# Wathiq AI — Routine Editing Recovery Upgrade

## Changed files
- `agent/tools/modifyRoutine.ts`: converts routine-edit failures into structured, actionable follow-up questions; supports an explicitly approved `new_category` for swapping a step to a different functional category; partial batch execution can be enabled with `allow_partial`; partial replace-all/batch responses carry a follow-up question and choices.
- `agent/agent.ts`: returns follow-up payloads without committing them as the new routine; exception fallback is user-facing and does not expose raw exception details.
- `agent/fastLane.ts`: handles follow-up payloads directly instead of falling through to the LLM or expecting a routine card; partial edits include their follow-up question.
- `agent/prompt.ts`: requires the assistant to ask a concrete follow-up and retry with updated constraints instead of stopping at a generic error.

## Behavior
- Missing routine: ask whether to build one or provide the routine to edit.
- Missing/ambiguous step: ask for step number/name and offer likely categories.
- Brand/category unavailable: explain the exact constraint and ask permission to change brand, budget, or category.
- Budget conflict: offer a budget increase, cheaper alternative, removal of another step, or keeping the current item.
- Avoid-list conflict: preserve hard exclusions and ask to search a different compliant product.
- Duplicate category/step: ask whether to replace the existing step instead.
- Partial multi-edit: default remains atomic (no partial changes); if the user approves partial execution, pass `allow_partial: true`, then successful edits apply and failed ones stay unchanged with an explicit follow-up.
- Category changes are never silent. After user approval, pass `new_category` and the step label, usage time, instructions, and rationale are updated to the new category.

## Validation
TypeScript parser/syntax check was run on the modified files. A complete project build could not be run because this source bundle has no `package.json`/installed dependencies and the environment lacks the project dependency typings. The remaining `tsc` messages are missing-dependency/Node typings plus a `getProducts()` inferred-unknown issue caused by the isolated `--noResolve` check.
