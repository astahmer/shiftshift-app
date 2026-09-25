# ShiftShift Agent Guidelines

- Treat entry loss and an empty local database as symptoms to investigate, not
  proof that data was deleted. Inspect the effective settings, selected store,
  fallback state, and configured folder before changing data.
- Home Manager seeds initial settings only when absent. Read the live settings
  and running app configuration before attributing a change to `nixapply`.
- For storage or duplicate-instance incidents, follow
  `.agents/skills/shiftshift-runtime-state-audit/SKILL.md`.
- Preserve user records during backend migration or recovery. Verify the
  selected runtime backend and representative records after a change.
