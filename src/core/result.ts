export type Result<T> =
    | { ok: true; value: T }
    | { ok: false; error: string };

export function ok<T>(value: T): Result<T> { return { ok: true, value }; }
export function err<T>(error: string): Result<T> { return { ok: false, error }; }
