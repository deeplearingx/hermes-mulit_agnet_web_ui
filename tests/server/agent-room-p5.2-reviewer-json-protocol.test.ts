// ─── P5.2: Reviewer JSON Output Protocol Tests ──────────────────
// Tests for parseReviewerOutput which enforces JSON-first parsing
// with safe fallback strategies.
//
// Covers:
//   - Valid JSON with each decision type
//   - Invalid / non-JSON output → revision_required (never approved)
//   - Missing decision → revision_required
//   - Empty feedback → fills with raw output
//   - Conflicting text safety (e.g. "这个实现未通过，需要修改")
//   - issues and confidence metadata propagation
//   - Markdown-wrapped JSON (```json ... ```)
//   - Edge cases: null decision, extra fields, clamped confidence

import { describe, expect, it } from 'vitest'
import { parseReviewerOutput } from '../../packages/server/src/services/hermes/agent-room/runner/runtime/orchestrated-gateway-runtime'

// ─── Valid JSON decision tests ───────────────────────────────────

describe('P5.2 parseReviewerOutput — valid JSON decisions', () => {
    it('valid JSON approved → decision "approved"', () => {
        const output = JSON.stringify({
            decision: 'approved',
            feedback: 'Implementation meets requirements',
            issues: [],
            confidence: 0.95,
        })
        const result = parseReviewerOutput(output)
        expect(result.decision).toBe('approved')
        expect(result.feedback).toBe('Implementation meets requirements')
    })

    it('valid JSON revision_required → decision "revision_required"', () => {
        const output = JSON.stringify({
            decision: 'revision_required',
            feedback: 'Missing error handling in auth module',
            issues: ['No try-catch around JWT verification'],
            confidence: 0.85,
        })
        const result = parseReviewerOutput(output)
        expect(result.decision).toBe('revision_required')
        expect(result.feedback).toBe('Missing error handling in auth module')
    })

    it('valid JSON need_user_decision → decision "need_user_decision"', () => {
        const output = JSON.stringify({
            decision: 'need_user_decision',
            feedback: 'Cannot determine if approach A or B is correct',
            issues: ['Ambiguous requirements for caching strategy'],
            confidence: 0.3,
        })
        const result = parseReviewerOutput(output)
        expect(result.decision).toBe('need_user_decision')
        expect(result.feedback).toBe('Cannot determine if approach A or B is correct')
    })
})

// ─── Non-JSON fallback tests ────────────────────────────────────

describe('P5.2 parseReviewerOutput — non-JSON fallback', () => {
    it('non-JSON text output → defaults to revision_required', () => {
        const result = parseReviewerOutput('The code looks good overall but needs some improvements')
        expect(result.decision).toBe('revision_required')
        expect(result.feedback).toBe('The code looks good overall but needs some improvements')
    })

    it('plain text with "approved" keyword → still revision_required (safety-first)', () => {
        // This is the critical safety test: even if text contains "approved",
        // non-JSON output must never be trusted as approved.
        const result = parseReviewerOutput('This is approved by the reviewer')
        expect(result.decision).toBe('revision_required')
    })

    it('plain text with Chinese "通过" keyword → still revision_required', () => {
        const result = parseReviewerOutput('代码质量通过了审核')
        expect(result.decision).toBe('revision_required')
    })

    it('empty string → revision_required with empty feedback', () => {
        const result = parseReviewerOutput('')
        expect(result.decision).toBe('revision_required')
        expect(result.feedback).toBe('')
    })

    it('whitespace-only → revision_required', () => {
        const result = parseReviewerOutput('   \n\t  ')
        expect(result.decision).toBe('revision_required')
    })
})

// ─── Conflicting text safety tests ──────────────────────────────

describe('P5.2 parseReviewerOutput — conflicting text safety', () => {
    it('"这个实现未通过，需要修改" must NOT be approved', () => {
        // Classic Chinese ambiguity: contains "通过" but means "did NOT pass"
        const result = parseReviewerOutput('这个实现未通过，需要修改')
        expect(result.decision).toBe('revision_required')
        expect(result.decision).not.toBe('approved')
    })

    it('"Implementation did not pass, needs revision" must NOT be approved', () => {
        const result = parseReviewerOutput('Implementation did not pass, needs revision')
        expect(result.decision).toBe('revision_required')
    })

    it('"NOT approved — please fix the following issues" must NOT be approved', () => {
        const result = parseReviewerOutput('NOT approved — please fix the following issues')
        expect(result.decision).toBe('revision_required')
    })

    it('"approved但有些问题需要修改" — text fallback still revision_required', () => {
        // Non-JSON text containing "approved" — must not be trusted
        const result = parseReviewerOutput('approved但有些问题需要修改')
        expect(result.decision).toBe('revision_required')
    })
})

// ─── Missing or invalid decision field ──────────────────────────

describe('P5.2 parseReviewerOutput — missing or invalid decision', () => {
    it('JSON with missing decision → defaults to revision_required', () => {
        const output = JSON.stringify({
            feedback: 'Some feedback',
            confidence: 0.5,
        })
        const result = parseReviewerOutput(output)
        expect(result.decision).toBe('revision_required')
        expect(result.feedback).toBe('Some feedback')
    })

    it('JSON with invalid decision value → defaults to revision_required', () => {
        const output = JSON.stringify({
            decision: 'looks_good_to_me',
            feedback: 'Seems fine',
        })
        const result = parseReviewerOutput(output)
        expect(result.decision).toBe('revision_required')
    })

    it('JSON with null decision → defaults to revision_required', () => {
        const output = JSON.stringify({
            decision: null,
            feedback: 'Cannot decide',
        })
        const result = parseReviewerOutput(output)
        expect(result.decision).toBe('revision_required')
    })

    it('JSON with numeric decision → defaults to revision_required', () => {
        const output = JSON.stringify({
            decision: 1,
            feedback: 'Numeric decision',
        })
        const result = parseReviewerOutput(output)
        expect(result.decision).toBe('revision_required')
    })
})

// ─── Empty feedback fallback ────────────────────────────────────

describe('P5.2 parseReviewerOutput — empty feedback handling', () => {
    it('JSON with empty feedback → fills with raw output', () => {
        const raw = JSON.stringify({
            decision: 'approved',
            feedback: '',
        })
        const result = parseReviewerOutput(raw)
        expect(result.decision).toBe('approved')
        expect(result.feedback).toBe(raw) // raw output used as feedback
    })

    it('JSON with whitespace-only feedback → fills with raw output', () => {
        const raw = JSON.stringify({
            decision: 'revision_required',
            feedback: '   ',
        })
        const result = parseReviewerOutput(raw)
        expect(result.decision).toBe('revision_required')
        expect(result.feedback).toBe(raw)
    })

    it('JSON with missing feedback → fills with raw output', () => {
        const raw = JSON.stringify({
            decision: 'need_user_decision',
        })
        const result = parseReviewerOutput(raw)
        expect(result.decision).toBe('need_user_decision')
        expect(result.feedback).toBe(raw)
    })
})

// ─── Issues and confidence metadata ─────────────────────────────

describe('P5.2 parseReviewerOutput — issues and confidence', () => {
    it('valid issues array is preserved', () => {
        const output = JSON.stringify({
            decision: 'revision_required',
            feedback: 'Multiple issues found',
            issues: ['Missing null check', 'No input validation', 'Hardcoded secret'],
            confidence: 0.9,
        })
        const result = parseReviewerOutput(output)
        expect(result.issues).toEqual(['Missing null check', 'No input validation', 'Hardcoded secret'])
        expect(result.confidence).toBe(0.9)
    })

    it('empty issues array → undefined (no issues to report)', () => {
        const output = JSON.stringify({
            decision: 'approved',
            feedback: 'All good',
            issues: [],
            confidence: 0.95,
        })
        const result = parseReviewerOutput(output)
        expect(result.issues).toBeUndefined()
    })

    it('issues with empty strings are filtered out', () => {
        const output = JSON.stringify({
            decision: 'revision_required',
            feedback: 'Issues found',
            issues: ['Real issue', '', '  ', 'Another issue'],
            confidence: 0.7,
        })
        const result = parseReviewerOutput(output)
        expect(result.issues).toEqual(['Real issue', 'Another issue'])
    })

    it('non-array issues field → undefined', () => {
        const output = JSON.stringify({
            decision: 'approved',
            feedback: 'Good',
            issues: 'single string not array',
            confidence: 0.8,
        })
        const result = parseReviewerOutput(output)
        expect(result.issues).toBeUndefined()
    })

    it('issues array with non-string elements → undefined', () => {
        const output = JSON.stringify({
            decision: 'approved',
            feedback: 'Good',
            issues: [123, true],
            confidence: 0.8,
        })
        const result = parseReviewerOutput(output)
        expect(result.issues).toBeUndefined()
    })

    it('confidence is clamped to [0, 1]', () => {
        const outputOver = JSON.stringify({
            decision: 'approved',
            feedback: 'Very confident',
            confidence: 1.5,
        })
        expect(parseReviewerOutput(outputOver).confidence).toBe(1)

        const outputUnder = JSON.stringify({
            decision: 'approved',
            feedback: 'Negative confidence',
            confidence: -0.5,
        })
        expect(parseReviewerOutput(outputUnder).confidence).toBe(0)
    })

    it('NaN confidence → undefined', () => {
        const output = JSON.stringify({
            decision: 'approved',
            feedback: 'Good',
            confidence: NaN,
        })
        const result = parseReviewerOutput(output)
        expect(result.confidence).toBeUndefined()
    })

    it('missing confidence → undefined', () => {
        const output = JSON.stringify({
            decision: 'approved',
            feedback: 'Good',
        })
        const result = parseReviewerOutput(output)
        expect(result.confidence).toBeUndefined()
    })

    it('non-numeric confidence → undefined', () => {
        const output = JSON.stringify({
            decision: 'approved',
            feedback: 'Good',
            confidence: 'high',
        })
        const result = parseReviewerOutput(output)
        expect(result.confidence).toBeUndefined()
    })
})

// ─── Markdown-wrapped JSON ──────────────────────────────────────

describe('P5.2 parseReviewerOutput — markdown-wrapped JSON', () => {
    it('```json ... ``` wrapped JSON is parsed correctly', () => {
        const output = '```json\n' + JSON.stringify({
            decision: 'approved',
            feedback: 'Looks great',
            confidence: 0.9,
        }, null, 2) + '\n```'
        const result = parseReviewerOutput(output)
        expect(result.decision).toBe('approved')
        expect(result.feedback).toBe('Looks great')
        expect(result.confidence).toBe(0.9)
    })

    it('``` ... ``` wrapped JSON (no lang tag) is parsed correctly', () => {
        const output = '```\n' + JSON.stringify({
            decision: 'revision_required',
            feedback: 'Needs work',
        }) + '\n```'
        const result = parseReviewerOutput(output)
        expect(result.decision).toBe('revision_required')
        expect(result.feedback).toBe('Needs work')
    })
})

// ─── Integration: metadata propagation ──────────────────────────

describe('P5.2 parseReviewerOutput — full output shape', () => {
    it('complete ReviewerOutput with all fields', () => {
        const output = JSON.stringify({
            decision: 'revision_required',
            feedback: 'Code review found 3 issues',
            issues: ['SQL injection risk', 'Missing rate limiting', 'No logging'],
            confidence: 0.88,
        })
        const result = parseReviewerOutput(output)
        expect(result).toEqual({
            decision: 'revision_required',
            feedback: 'Code review found 3 issues',
            issues: ['SQL injection risk', 'Missing rate limiting', 'No logging'],
            confidence: 0.88,
        })
    })

    it('minimal ReviewerOutput (only decision and feedback)', () => {
        const output = JSON.stringify({
            decision: 'approved',
            feedback: 'LGTM',
        })
        const result = parseReviewerOutput(output)
        expect(result).toEqual({
            decision: 'approved',
            feedback: 'LGTM',
            issues: undefined,
            confidence: undefined,
        })
    })
})
