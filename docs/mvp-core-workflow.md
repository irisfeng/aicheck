# MVP Core Workflow

## Goal

Keep the internal tool narrow and useful:

- Operator role handles material upload and AI pre-review
- Expert role handles manual review and final adjustment

## Minimal Functional Scope

1. Login with two roles
2. Upload files using checklist-code naming
3. Run API-based OCR and checklist review
4. Display item-level results and evidence linkage
5. Allow expert-only manual override
6. Allow expert-only export

## Minimal Landing Workflow

1. Operator logs in
2. Operator creates a case name and uploads files
3. System runs OCR and AI pre-review
4. System highlights mandatory blockers and unresolved items
5. Expert logs in and reviews AI conclusions
6. Expert overrides if needed and exports the final summary

## Why This Is Enough For MVP

- It preserves basic separation of responsibilities
- It avoids building persistence and full workflow engines too early
- It keeps the evaluation focus on evidence quality and model judgment quality
