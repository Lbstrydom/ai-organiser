/**
 * Shared types for all post-LLM deterministic validators.
 * DD-2: Validators return issues, not exceptions.
 * DD-6: ValidationResult<T> is the universal validator contract.
 */

export interface ValidationIssue {
    severity: 'error' | 'warning' | 'info';
    field: string;
    message: string;
    autoFixed?: boolean;
}

export interface ValidationResult<T> {
    valid: boolean;        // false if any severity === 'error'
    data: T;               // the possibly-corrected output
    issues: ValidationIssue[];
}
