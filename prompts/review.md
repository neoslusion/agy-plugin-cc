Perform a thorough, neutral code review of the target below. Identify bugs, security vulnerabilities, race conditions, edge cases, and code-quality issues. Be rigorous but fair: every finding must be real and verifiable.

## Target label

{{TARGET_LABEL}}

## Review input

{{REVIEW_INPUT}}

## Collection guidance

{{REVIEW_COLLECTION_GUIDANCE}}

## Output contract

Return exactly one JSON object with these fields:
- "verdict": "approve" or "needs-attention"
- "summary": a string
- "findings": an array of objects, each with:
  - "severity": "critical" | "high" | "medium" | "low"
  - "title": a string
  - "body": a string
  - "file": a string
  - "line_start": an integer >= 1
  - "line_end": an integer >= 1
  - "confidence": a number between 0 and 1
  - "recommendation": a string
- "next_steps": an array of non-empty strings

Do not include anything outside the JSON object.
